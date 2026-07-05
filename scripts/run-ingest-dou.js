// Roda a ingestao do DOU localmente e persiste no Supabase.
// Uso: node scripts/run-ingest-dou.js 2026-06-11
require("dotenv").config();
const { getSupabase } = require("../lib/supabase");
const { collectDou } = require("../lib/dou");
const { analyzeAto } = require("../lib/anthropic");
const { processPeopleFromDoc, loadActiveMonitors, matchMonitorsForDoc, flushMonitorAlerts } = require("../lib/ingest");

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

  let inserted = 0, skipped = 0, directors = 0;
  const monitors = await loadActiveMonitors(supabase);
  const monitorAlerts = [];
  const monitorHits = new Map();
  if (monitors.length) console.log(`Monitores ativos: ${monitors.length}`);

  for (const r of records) {
    // Dedupe por content_hash
    const { data: exists } = await supabase
      .from("documents")
      .select("id")
      .eq("content_hash", r.content_hash)
      .maybeSingle();
    if (exists) { skipped++; continue; }

    const ai = await analyzeAto(r.title, r.extracted_text);

    const { data: doc, error } = await supabase.from("documents").insert({
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
    }).select("id").single();

    if (error) {
      console.error(`  ERRO [${r.agency_acronym}] ${r.title}: ${error.message}`);
      continue;
    }

    inserted++;
    console.log(`  + [${r.agency_acronym}] ${r.title}`);
    if (ai.summary) console.log(`    IA: ${ai.summary}`);

    // Monitores de vigilancia: testa o doc novo contra todos os ativos.
    const hits = matchMonitorsForDoc(monitors, {
      docId: doc.id,
      title: r.title,
      text: r.extracted_text,
      agencyId: r.agency_id,
      agencyAcronym: r.agency_acronym,
      publishedAt: r.published_at,
      aiEntities: ai.entities
    });
    for (const h of hits) {
      monitorAlerts.push(h.alert);
      monitorHits.set(h.monitorId, (monitorHits.get(h.monitorId) || 0) + 1);
      console.log(`    monitor hit: ${h.alert.title}`);
    }

    // Secao 2: extrai diretores (regex + IA), cria mandatos e conexoes.
    if (r.section === 2) {
      const result = await processPeopleFromDoc(supabase, {
        id: doc.id,
        agency_id: r.agency_id,
        agency_acronym: r.agency_acronym,
        published_at: r.published_at,
        title: r.title,
        text: r.extracted_text,
        aiEntities: ai.entities
      });
      if (result.people) {
        directors += result.people;
        console.log(`    diretores: ${result.people} | conexoes: ${result.relationships}`);
      }
    }
  }

  await flushMonitorAlerts(supabase, monitorAlerts, monitorHits);

  console.log(`\nConcluido: ${inserted} inseridos, ${skipped} ja existiam, ${directors} diretores criados, ${monitorAlerts.length} alertas de monitor.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
