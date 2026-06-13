// Carrega filiacao partidaria do TSE (dump anual dadosabertos.tse.jus.br).
// Cruza com diretores no banco para detectar filiacao politica ativa.
//
// Como baixar:
//   1. Acesse: https://dadosabertos.tse.jus.br/dataset/filiados-partidos
//   2. Baixe o ZIP do ano corrente (ex: filiados_2026.zip) -> extrai CSV por partido
//      OU baixe o arquivo nacional consolidado "filiacao_partidaria_AAAA.csv"
//   3. O CSV tem cabecalho na 1a linha, delimitado por ";"
//
// Uso: node scripts/load-tse-filiacao.js /path/to/filiacao.csv [--dry-run]
//
// Colunas esperadas (variam por ano, script tenta detectar):
//   NM_FILIADO, SG_PARTIDO, DT_FILIACAO, CD_MUNICIPIO, NM_MUNICIPIO, SG_UF, CD_SITUACAO
require("dotenv").config();
const fs = require("fs");
const readline = require("readline");
const { getSupabase } = require("../lib/supabase");

function normalize(name) {
  return (name || "").toUpperCase().replace(/[^A-Z\s]/g, "").replace(/\s+/g, " ").trim();
}

function parseDate(s) {
  if (!s) return null;
  // Formatos comuns do TSE: DD/MM/YYYY ou YYYY-MM-DD
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const m2 = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return s.slice(0, 10);
  return null;
}

async function main() {
  const csvPath = process.argv[2];
  const dryRun = process.argv.includes("--dry-run");
  if (!csvPath) {
    console.error("Uso: node scripts/load-tse-filiacao.js /path/to/filiacao.csv [--dry-run]");
    process.exit(1);
  }
  if (!fs.existsSync(csvPath)) {
    console.error(`Arquivo nao encontrado: ${csvPath}`);
    process.exit(1);
  }

  const supabase = getSupabase();

  // Carrega diretores do banco
  const { data: people } = await supabase.from("people").select("id, name, normalized_name");
  const nameIndex = new Map();
  for (const p of people || []) {
    const key = normalize(p.normalized_name || p.name);
    if (key) nameIndex.set(key, p.id);
  }
  console.log(`Diretores no banco: ${nameIndex.size}`);

  const rl = readline.createInterface({ input: fs.createReadStream(csvPath, "latin1"), crlfDelay: Infinity });
  let lineNum = 0, matched = 0, inserted = 0, skipped = 0;
  let colNome = -1, colPartido = -1, colData = -1, colSit = -1;

  for await (const line of rl) {
    lineNum++;
    if (lineNum % 1000000 === 0) console.log(`  Lidas ${lineNum} linhas, ${matched} correspondencias...`);

    const cols = line.split(";").map((c) => c.replace(/^"|"$/g, "").trim());

    if (lineNum === 1) {
      // Detecta colunas pelo cabecalho
      cols.forEach((c, i) => {
        const u = c.toUpperCase();
        if (u.includes("NM_FILIADO") || u === "NOME") colNome = i;
        if (u.includes("SG_PARTIDO") || u.includes("PARTIDO")) colPartido = i;
        if (u.includes("DT_FILIACAO") || u.includes("DATA")) colData = i;
        if (u.includes("CD_SITUACAO") || u.includes("SITUACAO")) colSit = i;
      });
      console.log(`Colunas: nome=${colNome}, partido=${colPartido}, data=${colData}, situacao=${colSit}`);
      if (colNome < 0 || colPartido < 0) {
        console.error("Nao foi possivel detectar colunas NM_FILIADO / SG_PARTIDO. Verifique o cabecalho.");
        process.exit(1);
      }
      continue;
    }

    const nome = normalize(cols[colNome] || "");
    const partido = (cols[colPartido] || "").trim().toUpperCase();
    const dataFiliacao = parseDate(cols[colData] || "");
    const situacao = (cols[colSit] || "").trim();

    if (!nome || !partido) continue;

    const personId = nameIndex.get(nome);
    if (!personId) continue;
    matched++;

    if (dryRun) {
      console.log(`  MATCH: ${cols[colNome]} | ${partido} | ${dataFiliacao} | ${situacao}`);
      continue;
    }

    // Dedupe por person_id + partido
    const { data: exists } = await supabase
      .from("party_links")
      .select("id")
      .eq("person_id", personId)
      .eq("party", partido)
      .maybeSingle();

    if (exists) { skipped++; continue; }

    const { error } = await supabase.from("party_links").insert({
      person_id: personId,
      party: partido,
      joined_at: dataFiliacao,
      status: situacao || "REGULAR",
      source: "tse_filiacao",
      confidence_score: 1
    });
    if (!error) {
      inserted++;
      console.log(`  + ${cols[colNome]} → ${partido} (filiado desde ${dataFiliacao})`);
    }
  }

  console.log(`\n=== TSE Filiacao concluido ===`);
  console.log(`Linhas lidas    : ${lineNum}`);
  console.log(`Correspondencias: ${matched}`);
  console.log(`Inseridos       : ${inserted}`);
  console.log(`Ja existiam     : ${skipped}`);
  if (dryRun) console.log(`\n(dry-run: nenhuma gravacao realizada)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
