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
// Match com a base local `people`: CPF (forte, match_method='cpf') ou chave de
// nome normalizada (fraco, match_method='name' — homonimos sao sinalizados na UI).
// O CPF do candidato NAO e persistido (LGPD): o vinculo fica em person_id.
require("dotenv").config();
const fs = require("fs");
const readline = require("readline");
const { getSupabase } = require("../lib/supabase");
const { normalizeNameKey, onlyDigits } = require("../lib/text");

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

function splitCsvLine(line) {
  return line.split(";").map((c) => c.replace(/^"|"$/g, "").trim());
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

  // Pass 0: indices da base local (por CPF e por chave de nome).
  const { data: people } = await supabase.from("people").select("id, full_name, cpf, normalized_key, normalized_name");
  const byCpf = new Map();
  const byNameKey = new Map();
  for (const p of people || []) {
    const cpf = onlyDigits(p.cpf);
    if (cpf.length === 11) byCpf.set(cpf, p.id);
    const key = p.normalized_key || normalizeNameKey(p.full_name);
    if (key) byNameKey.set(key, p.id);
  }
  console.log(`Pessoas na base local: ${(people || []).length} (${byCpf.size} com CPF)`);

  // Pass 1: consulta_cand -> so candidatos que casam com people entram no indice.
  const sqIndex = new Map(); // SQ_CANDIDATO -> { person_id, match_method, candidate_name }
  {
    const rl = readline.createInterface({ input: fs.createReadStream(candPath, "latin1"), crlfDelay: Infinity });
    let lineNum = 0;
    let cols = null;
    for await (const line of rl) {
      lineNum++;
      if (lineNum % 200000 === 0) console.log(`  [cand] ${lineNum} linhas, ${sqIndex.size} matches...`);
      const parts = splitCsvLine(line);
      if (lineNum === 1) {
        cols = detectColumns(parts, {
          sq: ["SQ_CANDIDATO"],
          cpf: ["NR_CPF_CANDIDATO", "NR_CPF"],
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
      const cpf = cols.cpf != null ? onlyDigits(parts[cols.cpf]) : "";
      const nome = parts[cols.nome] || "";
      let personId = null, method = null;
      if (cpf.length === 11 && byCpf.has(cpf)) { personId = byCpf.get(cpf); method = "cpf"; }
      else {
        const key = normalizeNameKey(nome);
        if (key && byNameKey.has(key)) { personId = byNameKey.get(key); method = "name"; }
      }
      if (personId) {
        sqIndex.set(sq, {
          person_id: personId,
          match_method: method,
          candidate_name: nome,
          reference_year: cols.ano != null ? Number(parts[cols.ano]) || null : null,
          election_uf: cols.uf != null ? parts[cols.uf] || null : null
        });
      }
    }
    console.log(`[cand] candidatos correspondentes na base local: ${sqIndex.size}`);
  }

  if (!sqIndex.size) {
    console.log("Nenhum candidato casa com a base local — nada a carregar.");
    return;
  }

  // Pass 2: bem_candidato -> rows de assets em batches (upsert idempotente).
  let lineNum = 0, matched = 0, inserted = 0;
  let batch = [];
  async function flush() {
    if (!batch.length || dryRun) { batch = []; return; }
    const { error, data } = await supabase.from("assets").upsert(batch, {
      onConflict: "sq_candidato,nr_ordem,reference_year",
      ignoreDuplicates: true
    }).select("id");
    if (error) console.error(`  ERRO no batch: ${error.message}`);
    else inserted += (data || []).length;
    batch = [];
  }

  {
    const rl = readline.createInterface({ input: fs.createReadStream(bensPath, "latin1"), crlfDelay: Infinity });
    let cols = null;
    for await (const line of rl) {
      lineNum++;
      if (lineNum % 200000 === 0) console.log(`  [bens] ${lineNum} linhas, ${matched} bens correspondentes...`);
      const parts = splitCsvLine(line);
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
      const row = {
        person_id: match.person_id,
        candidate_name: match.candidate_name,
        sq_candidato: sq,
        nr_ordem: cols.ordem != null ? Number(parts[cols.ordem]) || 0 : 0,
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
}

main().catch((e) => { console.error(e); process.exit(1); });
