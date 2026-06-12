// Roda a ingestao do DOU localmente (fora do serverless), para testes.
// Uso: node scripts/run-ingest-dou.js 2026-06-11
const { getSupabase } = require("../lib/supabase");
const { collectDou } = require("../lib/dou");
const { analyzeAto } = require("../lib/anthropic");

async function main() {
  const date = process.argv[2] || new Date().toISOString().slice(0, 10);
  const supabase = getSupabase();
  const { data: agencies } = await supabase
    .from("agencies")
    .select("id, acronym")
    .eq("sector", "regulatory");

  console.log(`Coletando DOU de ${date} para ${agencies?.length || 0} agencias...`);
  const records = await collectDou(date, agencies || []);
  console.log(`Atos encontrados das agencias: ${records.length}`);

  for (const r of records.slice(0, 5)) {
    const ai = await analyzeAto(r.title, r.extracted_text);
    console.log(`- [${r.agency_acronym}] ${r.title}`);
    if (ai.summary) console.log(`    IA: ${ai.summary} (conf ${ai.confidence})`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
