// Backfill de diretores a partir dos atos de pessoal JA ingeridos no Supabase.
// Util para processar os 312 atos antigos (ingeridos antes do extrator existir).
// Uso: node scripts/backfill-people.js
require("dotenv").config();
const { getSupabase } = require("../lib/supabase");
const { processPeopleFromDoc } = require("../lib/ingest");

async function main() {
  const supabase = getSupabase();
  const { data: docs, error } = await supabase
    .from("documents")
    .select("id, title, agency_id, published_at, extracted_text, metadata")
    .eq("source_name", "DOU")
    .eq("document_type", "ato_pessoal")
    .limit(1000);
  if (error) throw error;

  console.log(`Atos de pessoal encontrados: ${docs?.length || 0}`);
  let people = 0, rels = 0;
  for (const doc of docs || []) {
    const r = await processPeopleFromDoc(supabase, {
      id: doc.id,
      agency_id: doc.agency_id,
      agency_acronym: doc.metadata?.agency_acronym,
      published_at: doc.published_at,
      title: doc.title,
      text: doc.extracted_text,
      aiEntities: doc.metadata?.ai_entities
    });
    if (r.people) { people += r.people; rels += r.relationships; console.log(`  + ${r.people} diretores de "${doc.title.slice(0,60)}"`); }
  }
  console.log(`\nConcluido: ${people} diretores, ${rels} conexoes criadas.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
