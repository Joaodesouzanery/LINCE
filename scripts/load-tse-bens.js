// Carrega bens declarados de candidatos (TSE dados abertos) para a tabela assets.
// O dump de bens NAO tem CPF nem nome: a ponte e o arquivo de candidatos
// (SQ_CANDIDATO). Por isso o loader exige OS DOIS arquivos do mesmo ano:
//
//   1. https://dadosabertos.tse.jus.br/dataset/candidatos-<ANO>
//      - consulta_cand_<ANO>_BRASIL.csv  (candidato: SQ_CANDIDATO, NR_CPF, NM)
//      - bem_candidato_<ANO>_BRASIL.csv  (bens: SQ_CANDIDATO, DS_BEM, VR_BEM)
//   2. CSVs em latin1, delimitados por ";", com cabecalho.
//
// Uso:
//   node scripts/load-tse-bens.js --cand consulta_cand_2024_BRASIL.csv \
//     --bens bem_candidato_2024_BRASIL.csv [--dry-run]
//
// Match com a base local `people` SO por nome (a tabela nao tem CPF — LGPD).
// match_method='name' (fraco, homonimo sinalizado na UI). Para nao ATRIBUIR
// patrimonio a pessoa errada, so casamos nomes NAO-AMBIGUOS: chaves de nome que
// apontam para mais de uma pessoa na base OU para mais de um candidato no TSE
// sao DESCARTADAS (melhor perder um match do que imputar bem a quem nao e).
require("dotenv").config();
const fs = require("fs");
const readline = require("readline");
const { getSupabase } = require("../lib/supabase");
const { normalizeNameKey, parseCsvLine } = require("../lib/text");

const BATCH_SIZE = 500;

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

// Valor pt-BR do TSE: "1.234.567,89" -> 1234567.89
function parseMoney(s) {
  const clean = String(s || "").replace(/\./g, "").replace(",", ".").trim();
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}

// Le TODAS as pessoas paginando de 1000 em 1000 (o PostgREST limita cada resposta).
async function fetchAllPeople(supabase) {
  const all = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from("people").select("id, full_name")
      .order("created_at", { ascending: true }).range(from, from + PAGE - 1);
    if (error) { console.error(`Erro lendo people: ${error.message}`); process.exit(1); }
    all.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return all;
}

// Detecta indices de colunas pelo cabecalho (nomes variam pouco entre anos).
function detectColumns(headerCols, wanted) {
  const found = {};
  headerCols.forEach((c, i) => {
    const u = c.toUpperCase();
    for (const [key, patterns] of Object.entries(wanted)) {
      if (found[key] == null && patterns.some((p) => u.includes(p))) found[key] = i;
    }
  });
  return found;
}

async function main() {
  const candPath = argValue("--cand");
  const bensPath = argValue("--bens");
  const dryRun = process.argv.includes("--dry-run");
  if (!candPath || !bensPath) {
    console.error("Uso: node scripts/load-tse-bens.js --cand consulta_cand_X.csv --bens bem_candidato_X.csv [--dry-run]");
    process.exit(1);
  }
  for (const p of [candPath, bensPath]) {
    if (!fs.existsSync(p)) { console.error(`Arquivo nao encontrado: ${p}`); process.exit(1); }
  }

  const supabase = getSupabase();

  // Pass 0: indice da base local por chave de nome. A tabela `people` NAO tem
  // CPF (LGPD: nao persistimos CPF) nem colunas normalized_*, entao o unico
  // sinal disponivel e o nome -> match_method='name' (fraco, homonimo sinalizado
  // na UI). Checar `error`: se o select falhar (coluna inexistente), nao tratar
  // como "0 pessoas".
  // Paginar: o PostgREST corta cada resposta em 1000 linhas. Sem isso, so as
  // 1000 primeiras pessoas entrariam no indice (a base tem milhares).
  const people = await fetchAllPeople(supabase);
  // Chave de nome -> person_id. Se duas pessoas distintas colapsam na mesma chave
  // (homonimo), a chave e AMBIGUA: removemos do indice para nao atribuir bem a
  // qualquer uma delas (nao ha como desambiguar so pelo nome).
  const byNameKey = new Map();
  const ambiguousLocal = new Set();
  for (const p of people || []) {
    const key = normalizeNameKey(p.full_name);
    if (!key) continue;
    if (ambiguousLocal.has(key)) continue;
    const prev = byNameKey.get(key);
    if (prev && prev !== p.id) { byNameKey.delete(key); ambiguousLocal.add(key); }
    else byNameKey.set(key, p.id);
  }
  console.log(`Pessoas na base local: ${(people || []).length} | chaves unicas: ${byNameKey.size} | descartadas por homonimia: ${ambiguousLocal.size}`);

  // Pass 1: consulta_cand -> so candidatos que casam com people entram no indice.
  // Se DOIS candidatos distintos (SQ diferentes) tem o mesmo nome, a chave e
  // ambigua no lado TSE tambem -> descartamos (nao da p/ saber qual e o dirigente).
  const sqIndex = new Map(); // SQ_CANDIDATO -> { person_id, match_method, candidate_name }
  {
    const rl = readline.createInterface({ input: fs.createReadStream(candPath, "latin1"), crlfDelay: Infinity });
    let lineNum = 0;
    let cols = null;
    const keyToCand = new Map();   // key -> candidato unico que casou
    const ambiguousCand = new Set();
    for await (const line of rl) {
      lineNum++;
      if (lineNum % 200000 === 0) console.log(`  [cand] ${lineNum} linhas...`);
      const parts = parseCsvLine(line);
      if (lineNum === 1) {
        cols = detectColumns(parts, {
          sq: ["SQ_CANDIDATO"],
          nome: ["NM_CANDIDATO"],
          ano: ["ANO_ELEICAO"],
          uf: ["SG_UF"]
        });
        console.log(`[cand] colunas: ${JSON.stringify(cols)}`);
        if (cols.sq == null || cols.nome == null) {
          console.error("Nao detectei SQ_CANDIDATO / NM_CANDIDATO no cabecalho de --cand.");
          process.exit(1);
        }
        continue;
      }
      const sq = parts[cols.sq];
      if (!sq) continue;
      const nome = parts[cols.nome] || "";
      const key = normalizeNameKey(nome);
      if (!key || !byNameKey.has(key) || ambiguousCand.has(key)) continue;
      const prev = keyToCand.get(key);
      if (prev && prev.sq !== sq) { keyToCand.delete(key); ambiguousCand.add(key); continue; }
      keyToCand.set(key, {
        sq,
        person_id: byNameKey.get(key),
        match_method: "name",
        candidate_name: nome,
        reference_year: cols.ano != null ? Number(parts[cols.ano]) || null : null,
        election_uf: cols.uf != null ? parts[cols.uf] || null : null
      });
    }
    for (const c of keyToCand.values()) sqIndex.set(c.sq, c);
    console.log(`[cand] candidatos casados (nome unico dos 2 lados): ${sqIndex.size} | descartados por homonimia no TSE: ${ambiguousCand.size}`);
  }

  if (!sqIndex.size) {
    console.log("Nenhum candidato casa com a base local — nada a carregar.");
    return;
  }

  // Pass 2: bem_candidato -> rows de assets em batches (upsert idempotente).
  let lineNum = 0, matched = 0, inserted = 0, batchErrors = 0;
  let batch = [];
  const ordemSeq = new Map(); // (sq|ano) -> proximo nr_ordem sintetico (fallback)
  async function flush() {
    if (!batch.length || dryRun) { batch = []; return; }
    const { error, data } = await supabase.from("assets").upsert(batch, {
      onConflict: "sq_candidato,nr_ordem,reference_year",
      ignoreDuplicates: true
    }).select("id");
    if (error) { console.error(`  ERRO no batch: ${error.message}`); batchErrors++; }
    else inserted += (data || []).length;
    batch = [];
  }

  {
    const rl = readline.createInterface({ input: fs.createReadStream(bensPath, "latin1"), crlfDelay: Infinity });
    let cols = null;
    for await (const line of rl) {
      lineNum++;
      if (lineNum % 200000 === 0) console.log(`  [bens] ${lineNum} linhas, ${matched} bens correspondentes...`);
      const parts = parseCsvLine(line);
      if (lineNum === 1) {
        cols = detectColumns(parts, {
          sq: ["SQ_CANDIDATO"],
          ordem: ["NR_ORDEM_CANDIDATO", "NR_ORDEM_BEM_CANDIDATO", "NR_ORDEM"],
          tipo: ["DS_TIPO_BEM_CANDIDATO", "DS_TIPO_BEM"],
          desc: ["DS_BEM_CANDIDATO", "DS_BEM"],
          valor: ["VR_BEM_CANDIDATO", "VR_BEM"],
          ano: ["ANO_ELEICAO"],
          uf: ["SG_UF"]
        });
        console.log(`[bens] colunas: ${JSON.stringify(cols)}`);
        if (cols.sq == null || cols.valor == null) {
          console.error("Nao detectei SQ_CANDIDATO / VR_BEM no cabecalho de --bens.");
          process.exit(1);
        }
        continue;
      }
      const sq = parts[cols.sq];
      const match = sq && sqIndex.get(sq);
      if (!match) continue;
      matched++;
      const year = (cols.ano != null ? Number(parts[cols.ano]) : null) || match.reference_year || null;
      // nr_ordem: usa NR_ORDEM do TSE se valido (>0); senao gera sequencia por
      // (sq, ano) para nao colapsar N bens num unico (sq,0,year) no upsert
      // (ignoreDuplicates descartaria os demais em silencio).
      let nrOrdem = cols.ordem != null ? Number(parts[cols.ordem]) : NaN;
      if (!Number.isInteger(nrOrdem) || nrOrdem <= 0) {
        const seqKey = `${sq}|${year}`;
        nrOrdem = (ordemSeq.get(seqKey) || 0) + 1;
        ordemSeq.set(seqKey, nrOrdem);
      }
      const row = {
        person_id: match.person_id,
        candidate_name: match.candidate_name,
        sq_candidato: sq,
        nr_ordem: nrOrdem,
        asset_type: cols.tipo != null ? parts[cols.tipo] || null : null,
        description: cols.desc != null ? (parts[cols.desc] || "").slice(0, 500) : null,
        value: parseMoney(parts[cols.valor]),
        reference_year: year,
        election_uf: (cols.uf != null ? parts[cols.uf] : null) || match.election_uf || null,
        match_method: match.match_method,
        source_name: "TSE"
      };
      if (dryRun) {
        if (matched <= 20) console.log(`  MATCH: ${match.candidate_name} | ${row.asset_type} | ${row.description?.slice(0, 60)} | R$ ${row.value} | ${year} [${match.match_method}]`);
        continue;
      }
      batch.push(row);
      if (batch.length >= BATCH_SIZE) await flush();
    }
    await flush();
  }

  console.log(`\n=== TSE Bens concluido ===`);
  console.log(`Linhas lidas (bens): ${lineNum}`);
  console.log(`Bens correspondentes: ${matched}`);
  console.log(`Inseridos           : ${inserted}`);
  if (dryRun) console.log(`\n(dry-run: nenhuma gravacao realizada)`);
  // Nao mascarar falha: se algum batch deu erro, sair != 0 para o operador/cron
  // nao ver "concluido" e achar que gravou tudo.
  if (batchErrors > 0) { console.error(`\nFALHA: ${batchErrors} batch(es) com erro — dados podem estar incompletos.`); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
