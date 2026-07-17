// Popula party_links (vinculo partidario) a partir do SG_PARTIDO do consulta_cand
// do TSE. O dump NOMINAL de filiacao foi descontinuado (LGPD), mas o partido da
// CANDIDATURA e um sinal legal, publico e atualizavel a cada eleicao: quem se
// candidata precisa estar filiado (prazo ~6 meses antes do pleito). SEM IA.
//
// Uso: node scripts/load-tse-partido.js --cand consulta_cand_ANO_ALL.csv [--dry-run]
//
// Match com `people` SO por nome (sem CPF, LGPD) — homonimos ambiguos dos DOIS
// lados sao descartados (ver lib/tse-match.js). link_type='candidatura'.
require("dotenv").config();
const fs = require("fs");
const readline = require("readline");
const { getSupabase } = require("../lib/supabase");
const { normalizeNameKey, parseCsvLine } = require("../lib/text");
const { fetchAllPeople, buildPeopleNameIndex } = require("../lib/tse-match");

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

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
  const dryRun = process.argv.includes("--dry-run");
  if (!candPath) { console.error("Uso: node scripts/load-tse-partido.js --cand consulta_cand_X.csv [--dry-run]"); process.exit(1); }
  if (!fs.existsSync(candPath)) { console.error(`Arquivo nao encontrado: ${candPath}`); process.exit(1); }

  const supabase = getSupabase();
  const people = await fetchAllPeople(supabase);
  const { byNameKey, ambiguous } = buildPeopleNameIndex(people);
  console.log(`Pessoas na base: ${people.length} | chaves unicas: ${byNameKey.size} | descartadas por homonimia: ${ambiguous.size}`);

  // Pass 1: candidatos que casam com people (nome unico dos DOIS lados) -> partido.
  const rl = readline.createInterface({ input: fs.createReadStream(candPath, "latin1"), crlfDelay: Infinity });
  let lineNum = 0, cols = null;
  const keyToCand = new Map();   // key -> { sq, person_id, party, year }
  const ambiguousCand = new Set();
  for await (const line of rl) {
    lineNum++;
    if (lineNum % 200000 === 0) console.log(`  [cand] ${lineNum} linhas...`);
    const parts = parseCsvLine(line);
    if (lineNum === 1) {
      cols = detectColumns(parts, {
        sq: ["SQ_CANDIDATO"],
        nome: ["NM_CANDIDATO"],
        partido: ["SG_PARTIDO"],   // SIGLA — nunca NM_PARTIDO/NR_PARTIDO
        ano: ["ANO_ELEICAO"]
      });
      console.log(`[cand] colunas: ${JSON.stringify(cols)}`);
      if (cols.sq == null || cols.nome == null || cols.partido == null) {
        console.error("Nao detectei SQ_CANDIDATO / NM_CANDIDATO / SG_PARTIDO no cabecalho de --cand.");
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
    const partido = (parts[cols.partido] || "").trim().toUpperCase();
    if (!partido) continue;
    keyToCand.set(key, {
      sq,
      person_id: byNameKey.get(key),
      party: partido,
      year: cols.ano != null ? Number(parts[cols.ano]) || null : null
    });
  }
  const cands = [...keyToCand.values()];
  console.log(`[cand] candidatos casados (nome unico dos 2 lados): ${cands.length} | descartados por homonimia no TSE: ${ambiguousCand.size}`);
  if (!cands.length) { console.log("Nada a carregar."); return; }

  // Pass 2: dedupe por (person_id, party, reference_year) e insere.
  let inserted = 0, skipped = 0, failed = 0;
  for (const c of cands) {
    if (dryRun) { console.log(`  ${c.party} (${c.year}) -> person ${c.person_id}`); continue; }
    let q = supabase.from("party_links").select("id").eq("person_id", c.person_id).eq("party", c.party);
    q = c.year != null ? q.eq("reference_year", c.year) : q.is("reference_year", null);
    const { data: existing, error: selErr } = await q.limit(1);
    if (selErr) { failed++; console.error(`  x dedupe ${c.party}/${c.year}: ${selErr.message}`); continue; }
    if (existing && existing.length) { skipped++; continue; }
    const { error } = await supabase.from("party_links").insert({
      person_id: c.person_id, party: c.party, link_type: "candidatura",
      reference_year: c.year, source_name: "TSE", source: "tse_consulta_cand", confidence_score: 0.9
    });
    if (error) { failed++; console.error(`  x insert ${c.party}/${c.year}: ${error.message}`); continue; }
    inserted++;
  }
  console.log(`\n=== TSE Partido concluido ===`);
  console.log(`Inseridos: ${inserted} | ja existiam: ${skipped} | falhas: ${failed}`);
  if (dryRun) console.log(`(dry-run: nada gravado)`);
  if (failed > 0) { console.error(`FALHA: ${failed} erro(s) de gravacao/leitura.`); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
