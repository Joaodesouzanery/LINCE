// Carrega filiacao partidaria do TSE (dump NOMINAL, com NM_FILIADO).
// Cruza com diretores no banco para detectar filiacao politica ativa.
//
// ATENCAO (jul/2026): o TSE DESCONTINUOU o dump nominal de filiados em massa
// (LGPD). O que ha hoje em dados abertos e o "Perfil da Filiacao Partidaria",
// que e AGREGADO (contagens por sexo/idade/UF/partido, coluna QT_FILIADO) e NAO
// tem nomes -> nao serve para este loader. Este script segue util caso voce
// tenha um dump nominal antigo (ate ~2019) ou uma fonte equivalente com nomes.
//
// Uso: node scripts/load-tse-filiacao.js /path/to/filiacao.csv [--dry-run]
//
// Colunas esperadas (variam por ano, script tenta detectar):
//   NM_FILIADO, SG_PARTIDO, DT_FILIACAO, SG_UF, CD_SITUACAO
require("dotenv").config();
const fs = require("fs");
const readline = require("readline");
const { getSupabase } = require("../lib/supabase");
const { normalizeNameKey, parseCsvLine } = require("../lib/text");

function parseDate(s) {
  if (!s) return null;
  // Formatos comuns do TSE: DD/MM/YYYY ou YYYY-MM-DD
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const m2 = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return s.slice(0, 10);
  return null;
}

// Le TODAS as pessoas paginando (o PostgREST limita cada resposta a 1000 linhas).
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

  // Carrega diretores do banco (people so tem id/full_name; sem normalized_*).
  // Checar `error`: coluna inexistente nao deve virar "0 diretores".
  const people = await fetchAllPeople(supabase); // pagina (PostgREST corta em 1000)
  // Chave de nome -> person_id, DESCARTANDO chaves ambiguas (homonimos): sem CPF
  // nao da p/ desambiguar, e atribuir filiacao a pessoa errada e pior que perder.
  const nameIndex = new Map();
  const ambiguous = new Set();
  for (const p of people || []) {
    const key = normalizeNameKey(p.full_name);
    if (!key || ambiguous.has(key)) continue;
    const prev = nameIndex.get(key);
    if (prev && prev !== p.id) { nameIndex.delete(key); ambiguous.add(key); }
    else nameIndex.set(key, p.id);
  }
  console.log(`Diretores no banco: ${nameIndex.size} (chaves ambiguas descartadas: ${ambiguous.size})`);

  const rl = readline.createInterface({ input: fs.createReadStream(csvPath, "latin1"), crlfDelay: Infinity });
  let lineNum = 0, matched = 0, inserted = 0, skipped = 0, failed = 0;
  let colNome = -1, colPartido = -1, colData = -1, colSit = -1;

  for await (const line of rl) {
    lineNum++;
    if (lineNum % 1000000 === 0) console.log(`  Lidas ${lineNum} linhas, ${matched} correspondencias...`);

    const cols = parseCsvLine(line);

    if (lineNum === 1) {
      // Detecta colunas pelo cabecalho (primeira que casar vence).
      // CRITICO: colPartido deve ser a SIGLA (SG_PARTIDO), NUNCA o nome por
      // extenso (NM_PARTIDO) — por isso excluimos colunas com NM_/NR_/NOME.
      cols.forEach((c, i) => {
        const u = c.toUpperCase();
        if (colNome < 0 && (u.includes("NM_FILIADO") || u === "NOME")) colNome = i;
        if (colPartido < 0 && (u.includes("SG_PARTIDO") ||
            (u.includes("PARTIDO") && !u.includes("NM_") && !u.includes("NR_") && !u.includes("NOME")))) colPartido = i;
        if (colData < 0 && (u.includes("DT_FILIACAO") || u.includes("DATA"))) colData = i;
        if (colSit < 0 && (u.includes("CD_SITUACAO") || u.includes("SITUACAO"))) colSit = i;
      });
      console.log(`Colunas: nome=${colNome}, partido=${colPartido}, data=${colData}, situacao=${colSit}`);
      if (colNome < 0 || colPartido < 0) {
        console.error("Nao foi possivel detectar colunas NM_FILIADO / SG_PARTIDO. Verifique o cabecalho.");
        process.exit(1);
      }
      continue;
    }

    const nome = normalizeNameKey(cols[colNome] || "");
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

    // Dedupe por person_id + partido. Checar `error`: se o SELECT falhar, NAO
    // seguir para o insert as cegas (evita duplicata e mascarar falha de DB).
    const { data: exists, error: selErr } = await supabase
      .from("party_links")
      .select("id")
      .eq("person_id", personId)
      .eq("party", partido)
      .maybeSingle();
    if (selErr) { failed++; console.error(`  x dedupe ${cols[colNome]} → ${partido}: ${selErr.message}`); continue; }

    if (exists) { skipped++; continue; }

    const { error } = await supabase.from("party_links").insert({
      person_id: personId,
      party: partido,
      joined_at: dataFiliacao,
      status: situacao || "REGULAR",
      source: "tse_filiacao",
      confidence_score: 1
    });
    if (error) { failed++; console.error(`  x insert ${cols[colNome]} → ${partido}: ${error.message}`); continue; }
    inserted++;
    console.log(`  + ${cols[colNome]} → ${partido} (filiado desde ${dataFiliacao})`);
  }

  console.log(`\n=== TSE Filiacao concluido ===`);
  console.log(`Linhas lidas    : ${lineNum}`);
  console.log(`Correspondencias: ${matched}`);
  console.log(`Inseridos       : ${inserted}`);
  console.log(`Ja existiam     : ${skipped}`);
  console.log(`Falhas          : ${failed}`);
  if (dryRun) console.log(`\n(dry-run: nenhuma gravacao realizada)`);
  if (failed > 0) { console.error(`\nFALHA: ${failed} erro(s) de gravacao/leitura — dados podem estar incompletos.`); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
