// M20.3 — Doacoes de campanha ("quem financia") do TSE (prestacao de contas).
// Carrega o arquivo de RECEITAS de candidatos e liga o DOADOR -> parlamentar.
//
//   https://dadosabertos.tse.jus.br/dataset/prestacao-de-contas-eleitorais-candidatos-<ANO>
//     - receitas_candidatos_<ANO>_BRASIL.csv  (SQ_CANDIDATO, NM_CANDIDATO,
//       NM_DOADOR, NR_CPF_CNPJ_DOADOR, VR_RECEITA, ANO_ELEICAO)
//   CSV em latin1, ";", com cabecalho. Arquivo GRANDE -> roda LOCAL (nao no cron).
//
// Uso: node scripts/load-tse-doacoes.js --receitas receitas_candidatos_2022_BRASIL.csv [--dry-run]
//
// Match do RECEBEDOR (candidato) com `people` SO por nome (LGPD, sem CPF na base),
// homonimo-seguro dos DOIS lados (base + TSE) via lib/tse-match. LGPD do DOADOR:
// CNPJ de PJ e publico (guardado inteiro); CPF de PF e MASCARADO antes de gravar.
require("dotenv").config();
const fs = require("fs");
const readline = require("readline");
const { getSupabase } = require("../lib/supabase");
const { normalizeNameKey, parseCsvLine, onlyDigits } = require("../lib/text");
const { fetchAllPeople, buildPeopleNameIndex } = require("../lib/tse-match");

const BATCH_SIZE = 500;

function argValue(flag) { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : null; }
function parseMoney(s) { const c = String(s || "").replace(/\./g, "").replace(",", ".").trim(); const n = Number(c); return Number.isFinite(n) ? n : null; }
function detectColumns(headerCols, wanted) {
  const found = {};
  headerCols.forEach((c, i) => { const u = c.toUpperCase(); for (const [k, pats] of Object.entries(wanted)) if (found[k] == null && pats.some((p) => u.includes(p))) found[k] = i; });
  return found;
}
// LGPD: CPF (11) mascarado "***456789**"; CNPJ (14) publico inteiro; resto: so digitos.
function safeDonorDoc(raw) {
  const d = onlyDigits(raw);
  if (d.length === 14) return { doc: d, type: "PJ" };
  if (d.length === 11) return { doc: `***${d.slice(3, 9)}**`, type: "PF" };
  return { doc: d || null, type: null };
}

async function main() {
  const receitasPath = argValue("--receitas");
  const dryRun = process.argv.includes("--dry-run");
  if (!receitasPath) { console.error("Uso: node scripts/load-tse-doacoes.js --receitas receitas_candidatos_ANO_BRASIL.csv [--dry-run]"); process.exit(1); }
  if (!fs.existsSync(receitasPath)) { console.error(`Arquivo nao encontrado: ${receitasPath}`); process.exit(1); }

  const supabase = getSupabase();
  const people = await fetchAllPeople(supabase);
  const { byNameKey, ambiguous } = buildPeopleNameIndex(people);
  console.log(`Pessoas na base: ${people.length} | chaves unicas: ${byNameKey.size} | descartadas por homonimia: ${ambiguous.size}`);

  // Pass 1: mapeia SQ_CANDIDATO -> person_id, descartando homonimos do lado TSE
  // (2 SQ distintos com o mesmo nome -> nao da p/ saber qual e o parlamentar).
  const sqToPerson = new Map();       // SQ -> { person_id, recipient_name }
  let cols = null;
  {
    const keyToSq = new Map(); const ambiguousTse = new Set();
    const rl = readline.createInterface({ input: fs.createReadStream(receitasPath, "latin1"), crlfDelay: Infinity });
    let lineNum = 0;
    for await (const line of rl) {
      lineNum++;
      if (lineNum % 500000 === 0) console.log(`  [pass1] ${lineNum} linhas...`);
      const parts = parseCsvLine(line);
      if (lineNum === 1) {
        cols = detectColumns(parts, {
          sq: ["SQ_CANDIDATO"],
          nome: ["NM_CANDIDATO"],
          receita: ["SQ_RECEITA"],           // id do recibo (discrimina recibos de mesmo valor)
          doador: ["NM_DOADOR_ORIGINARIO", "NM_DOADOR"],
          doc: ["NR_CPF_CNPJ_DOADOR_ORIGINARIO", "NR_CPF_CNPJ_DOADOR", "NR_CPF_CNPJ"],
          valor: ["VR_RECEITA"],
          ano: ["ANO_ELEICAO"]
        });
        console.log(`[receitas] colunas: ${JSON.stringify(cols)}`);
        if (cols.sq == null || cols.nome == null || cols.valor == null) { console.error("Faltam SQ_CANDIDATO / NM_CANDIDATO / VR_RECEITA no cabecalho."); process.exit(1); }
        if (cols.doc == null) console.warn("AVISO: nao detectei a coluna de CPF/CNPJ do doador — donor_document/type ficarao vazios.");
        if (cols.receita == null) console.warn("AVISO: sem SQ_RECEITA — usando sequencia por candidato como id de recibo (idempotente se o arquivo for o mesmo).");
        continue;
      }
      const sq = parts[cols.sq]; if (!sq) continue;
      const key = normalizeNameKey(parts[cols.nome] || "");
      if (!key || !byNameKey.has(key) || ambiguousTse.has(key)) continue;
      const prev = keyToSq.get(key);
      if (prev && prev !== sq) { keyToSq.delete(key); ambiguousTse.add(key); sqToPerson.delete(prev); continue; }
      keyToSq.set(key, sq);
      sqToPerson.set(sq, { person_id: byNameKey.get(key), recipient_name: parts[cols.nome] || null });
    }
    console.log(`[pass1] candidatos casados (nome unico dos 2 lados): ${sqToPerson.size} | descartados por homonimia no TSE: ${ambiguousTse.size}`);
  }
  if (!sqToPerson.size) { console.log("Nenhum candidato casa com a base — nada a carregar."); return; }

  // Pass 2: doacoes -> campaign_donations (upsert idempotente por RECIBO).
  let lineNum = 0, matched = 0, inserted = 0, batchErrors = 0;
  let batch = [];
  const receitaSeq = new Map(); // sq -> proximo n sintetico (fallback sem SQ_RECEITA)
  async function flush() {
    if (!batch.length || dryRun) { batch = []; return; }
    const { error, data } = await supabase.from("campaign_donations").upsert(batch, {
      onConflict: "sq_candidato,tse_receita_id", ignoreDuplicates: true
    }).select("id");
    if (error) { console.error(`  ERRO no batch: ${error.message}`); batchErrors++; } else inserted += (data || []).length;
    batch = [];
  }
  {
    const rl = readline.createInterface({ input: fs.createReadStream(receitasPath, "latin1"), crlfDelay: Infinity });
    for await (const line of rl) {
      lineNum++;
      if (lineNum % 500000 === 0) console.log(`  [pass2] ${lineNum} linhas, ${matched} doacoes...`);
      if (lineNum === 1) continue; // cabecalho (cols ja detectado no pass1)
      const parts = parseCsvLine(line);
      const sq = parts[cols.sq];
      const match = sq && sqToPerson.get(sq);
      if (!match) continue;
      matched++;
      const donor = safeDonorDoc(cols.doc != null ? parts[cols.doc] : "");
      const year = cols.ano != null ? Number(parts[cols.ano]) || null : null;
      // Id de recibo p/ a chave: SQ_RECEITA do TSE; se ausente, sequencia por candidato
      // (estavel no mesmo arquivo -> idempotente). Nunca NULL (evita re-insercao).
      let receitaId = cols.receita != null ? String(parts[cols.receita] || "").trim() : "";
      if (!receitaId) { const n = (receitaSeq.get(sq) || 0) + 1; receitaSeq.set(sq, n); receitaId = `seq${n}`; }
      const row = {
        recipient_person_id: match.person_id,
        recipient_name: match.recipient_name,
        sq_candidato: sq,
        tse_receita_id: receitaId,
        donor_name: cols.doador != null ? (parts[cols.doador] || "").slice(0, 200) : null,
        donor_document: donor.doc,
        donor_type: donor.type,
        amount: parseMoney(parts[cols.valor]),
        reference_year: year,
        source_name: "TSE",
        match_method: "name"
      };
      if (dryRun) { if (matched <= 20) console.log(`  MATCH: ${match.recipient_name} <- ${row.donor_name} (${row.donor_type}) R$ ${row.amount} [${year}]`); continue; }
      batch.push(row);
      if (batch.length >= BATCH_SIZE) await flush();
    }
    await flush();
  }

  console.log(`\n=== TSE Doacoes concluido ===`);
  console.log(`Linhas lidas: ${lineNum} | doacoes correspondentes: ${matched} | inseridas: ${inserted}`);
  if (dryRun) console.log("(dry-run: nada gravado)");
  if (batchErrors > 0) { console.error(`\nFALHA: ${batchErrors} batch(es) com erro.`); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
