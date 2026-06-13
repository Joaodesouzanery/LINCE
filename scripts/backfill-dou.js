// Backfill historico do DOU: ingere todos os dias de 2026-01-02 ate ontem.
// Idempotente: dedupe por content_hash — pode rodar multiplas vezes sem duplicar.
// Uso: node scripts/backfill-dou.js [YYYY-MM-DD inicio] [YYYY-MM-DD fim]
// Ex:  node scripts/backfill-dou.js 2026-01-02 2026-06-12
require("dotenv").config();
const { getSupabase } = require("../lib/supabase");
const { collectDou } = require("../lib/dou");
const { analyzeAto } = require("../lib/anthropic");
const { processPeopleFromDoc } = require("../lib/ingest");

const DOC_TYPE = { 1: "norma", 2: "ato_pessoal", 3: "contrato" };

function dateRange(from, to) {
  const dates = [];
  const cur = new Date(from + "T12:00:00Z");
  const end = new Date(to + "T12:00:00Z");
  while (cur <= end) {
    const d = cur.toISOString().slice(0, 10);
    // Pula fins de semana (DOU nao circula sabado/domingo normalmente)
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) dates.push(d);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

async function ingestDate(supabase, date, agencies) {
  let inserted = 0, skipped = 0, directors = 0;
  let records;
  try {
    records = await collectDou(date, agencies);
  } catch (e) {
    console.error(`  [${date}] ERRO collectDou: ${e.message}`);
    return { inserted, skipped, directors };
  }

  for (const r of records) {
    const { data: exists } = await supabase
      .from("documents")
      .select("id")
      .eq("content_hash", r.content_hash)
      .maybeSingle();
    if (exists) { skipped++; continue; }

    // IA e opcional (sem ANTHROPIC_API_KEY, ai fica vazio)
    const ai = await analyzeAto(r.title, r.extracted_text).catch(() => ({}));

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

    if (error) continue;
    inserted++;

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
      if (result.people) directors += result.people;
    }
  }
  return { inserted, skipped, directors };
}

async function main() {
  const supabase = getSupabase();
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const fromDate = process.argv[2] || "2026-01-02";
  const toDate = process.argv[3] || yesterday;

  const { data: agencies } = await supabase
    .from("agencies")
    .select("id, acronym")
    .eq("sector", "regulatory");

  const dates = dateRange(fromDate, toDate);
  console.log(`Backfill DOU: ${dates.length} dias uteis (${fromDate} → ${toDate})`);
  console.log(`Agencias: ${(agencies || []).map((a) => a.acronym).join(", ")}\n`);

  let totalInserted = 0, totalSkipped = 0, totalDirectors = 0;

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    process.stdout.write(`[${i + 1}/${dates.length}] ${date} ... `);
    const r = await ingestDate(supabase, date, agencies || []);
    totalInserted += r.inserted;
    totalSkipped += r.skipped;
    totalDirectors += r.directors;
    console.log(`+${r.inserted} novos, ${r.skipped} ja existiam${r.directors ? `, ${r.directors} diretores` : ""}`);

    // Pausa breve entre datas para nao sobrecarregar INLABS
    if (i < dates.length - 1) await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`\n=== Backfill concluido ===`);
  console.log(`Atos inseridos : ${totalInserted}`);
  console.log(`Ja existiam    : ${totalSkipped}`);
  console.log(`Diretores      : ${totalDirectors}`);
  console.log(`\nA partir de agora os crons da Vercel cuidam do DOU diario automaticamente.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
