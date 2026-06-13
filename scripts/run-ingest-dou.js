// Roda a ingestao do DOU localmente e persiste no Supabase.
// Uso: node scripts/run-ingest-dou.js 2026-06-11
require("dotenv").config();
const { getSupabase } = require("../lib/supabase");
const { collectDou } = require("../lib/dou");
const { analyzeAto } = require("../lib/anthropic");

const DOC_TYPE = { 1: "norma", 2: "ato_pessoal", 3: "contrato" };

async function main() {
  const date = process.argv[2] || new Date().toISOString().slice(0, 10);
  const supabase = getSupabase();

  const { data: agencies } = await supabase
    .from("agencies")
    .select("id, acronym")
    .eq("sector", "regulatory");

  console.log(`Coletando DOU de ${date} para ${agencies?.length || 0} agencias...`);
  const records = await collectDou(date, agencies || []);
  console.log(`Atos encontrados: ${records.length}`);

  let inserted = 0, skipped = 0;

  for (const r of records) {
    // Dedupe por content_hash
    const { data: exists } = await supabase
      .from("documents")
      .select("id")
      .eq("content_hash", r.content_hash)
      .maybeSingle();
    if (exists) { skipped++; continue; }

    const ai = await analyzeAto(r.title, r.extracted_text);

    const { error } = await supabase.from("documents").insert({
      agency_id: r.agency_id,
      source_name: "DOU",
      source_url: r.source_url,
      document_type: DOC_TYPE[r.section] || "ato",
      title: r.title,
      published_at: r.published_at,
      content_hash: r.content_hash,
      extracted_text: r.extracted_text,
      extraction_status: ai.summary ? "summarized" : "raw",
      metadata: {
        section: r.section,
        orgao: r.orgao,
        agency_acronym: r.agency_acronym,
        ai_summary: ai.summary,
        ai_entities: ai.entities,
        ai_confidence: ai.confidence
      }
    });

    if (error) {
      console.error(`  ERRO [${r.agency_acronym}] ${r.title}: ${error.message}`);
      continue;
    }

    inserted++;
    if (ai.summary) {
      console.log(`  + [${r.agency_acronym}] ${r.title}`);
      console.log(`    IA: ${ai.summary}`);
    } else {
      console.log(`  + [${r.agency_acronym}] ${r.title}`);
    }
  }

  console.log(`\nConcluido: ${inserted} inseridos, ${skipped} ja existiam.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
