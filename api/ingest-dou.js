// Endpoint de ingestao do DOU (chamado pelo Vercel Cron 1x/dia ou manualmente).
// GET /api/ingest-dou?date=YYYY-MM-DD  (default: hoje)
// Protegido por CRON_SECRET: header "authorization: Bearer <CRON_SECRET>".
const { getSupabase } = require("../lib/supabase");
const { collectDou } = require("../lib/dou");
const { analyzeAto } = require("../lib/anthropic");

const DOC_TYPE = { 1: "norma", 2: "ato_pessoal", 3: "contrato" };

function authorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // sem secret configurado, libera (uso single-user)
  return req.headers.authorization === `Bearer ${secret}`;
}

module.exports = async function handler(req, res) {
  if (!authorized(req)) {
    return res.status(401).json({ ok: false, error: "Nao autorizado." });
  }

  const date = String(req.query.date || new Date().toISOString().slice(0, 10));

  try {
    const supabase = getSupabase();

    const { data: agencies, error: agErr } = await supabase
      .from("agencies")
      .select("id, acronym")
      .eq("sector", "regulatory");
    if (agErr) throw agErr;
    if (!agencies?.length) {
      return res.status(412).json({ ok: false, error: "Nenhuma agencia cadastrada. Rode o seed." });
    }

    const records = await collectDou(date, agencies);

    let inserted = 0;
    let skipped = 0;
    const alerts = [];

    for (const record of records) {
      // Dedupe por content_hash.
      const { data: exists } = await supabase
        .from("documents")
        .select("id")
        .eq("content_hash", record.content_hash)
        .maybeSingle();
      if (exists) { skipped++; continue; }

      const ai = await analyzeAto(record.title, record.extracted_text);

      const { data: doc, error: docErr } = await supabase
        .from("documents")
        .insert({
          agency_id: record.agency_id,
          source_name: "DOU",
          source_url: record.source_url,
          document_type: DOC_TYPE[record.section] || "ato",
          title: record.title,
          published_at: record.published_at,
          content_hash: record.content_hash,
          extracted_text: record.extracted_text,
          extraction_status: ai.summary ? "summarized" : "raw",
          metadata: {
            section: record.section,
            orgao: record.orgao,
            agency_acronym: record.agency_acronym,
            ai_summary: ai.summary,
            ai_entities: ai.entities,
            ai_confidence: ai.confidence
          }
        })
        .select("id")
        .single();
      if (docErr) throw docErr;
      inserted++;

      // Nomeacoes/exoneracoes (Secao 2) viram alerta imediato.
      if (record.section === 2) {
        alerts.push({
          target_kind: "agency",
          target_id: record.agency_id,
          title: `Ato de pessoal: ${record.agency_acronym}`,
          description: ai.summary || record.title,
          severity: "high",
          source_document_id: doc.id
        });
      }
    }

    if (alerts.length) {
      await supabase.from("alerts").insert(alerts);
    }

    return res.status(200).json({
      ok: true,
      date,
      found: records.length,
      inserted,
      skipped,
      alerts: alerts.length
    });
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message, source: "DOU/INLABS" });
  }
};
