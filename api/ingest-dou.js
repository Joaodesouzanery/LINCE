// Endpoint de ingestao do DOU (chamado pelo Vercel Cron 1x/dia ou manualmente).
// GET /api/ingest-dou?date=YYYY-MM-DD  (default: hoje)
// Protegido por CRON_SECRET: header "authorization: Bearer <CRON_SECRET>".
const { getSupabase } = require("../lib/supabase");
const { collectDou } = require("../lib/dou");
const { analyzeAto } = require("../lib/anthropic");
const { classifyThemes } = require("../lib/themes");
const { processPeopleFromDoc, loadActiveMonitors, matchMonitorsForDoc, flushMonitorAlerts } = require("../lib/ingest");
const { timingSafeEqualStr } = require("../lib/timing");
const { sendAlertWebhook } = require("../lib/notify");

const DOC_TYPE = { 1: "norma", 2: "ato_pessoal", 3: "contrato" };

function authorized(req) {
  const secret = process.env.CRON_SECRET;
  // Fail-closed em PRODUCAO: sem CRON_SECRET, nega (evita ingestao/custo anonimo).
  // Em preview/dev, libera (conveniencia). A Vercel injeta o secret nos crons.
  if (!secret) return process.env.VERCEL_ENV !== "production";
  return timingSafeEqualStr(req.headers.authorization, `Bearer ${secret}`);
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
      .select("id, acronym, name")
      .eq("sector", "regulatory");
    if (agErr) throw agErr;
    if (!agencies?.length) {
      return res.status(412).json({ ok: false, error: "Nenhuma agencia cadastrada. Rode o seed." });
    }

    const records = await collectDou(date, agencies);

    let inserted = 0;
    let skipped = 0;
    let directors = 0;
    const alerts = [];
    const monitors = await loadActiveMonitors(supabase);
    const monitorAlerts = [];
    const monitorHits = new Map();

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

      // Tema (best-effort, DESACOPLADO do insert): update separado para NAO
      // quebrar a ingestao caso a coluna 'themes' ainda nao exista em producao
      // (a migracao Fase M14 e aplicada manualmente). supabase-js nao lanca em
      // erro de coluna (retorna {error}); o try/catch cobre so classifyThemes.
      try {
        const themes = classifyThemes(record.title, record.extracted_text);
        if (themes.length) await supabase.from("documents").update({ themes }).eq("id", doc.id);
      } catch { /* coluna ausente ou erro de classificacao: nao trava a ingestao */ }

      // Monitores de vigilancia: testa o doc novo contra todos os ativos.
      const hits = matchMonitorsForDoc(monitors, {
        docId: doc.id,
        title: record.title,
        text: record.extracted_text,
        agencyId: record.agency_id,
        agencyAcronym: record.agency_acronym,
        publishedAt: record.published_at,
        aiEntities: ai.entities
      });
      for (const h of hits) {
        monitorAlerts.push(h.alert);
        monitorHits.set(h.monitorId, (monitorHits.get(h.monitorId) || 0) + 1);
      }

      // Nomeacoes/exoneracoes (Secao 2): alerta + extracao de diretores.
      if (record.section === 2) {
        alerts.push({
          target_kind: "agency",
          target_id: record.agency_id,
          title: `Ato de pessoal: ${record.agency_acronym}`,
          description: ai.summary || record.title,
          severity: "high",
          source_document_id: doc.id
        });
        const r = await processPeopleFromDoc(supabase, {
          id: doc.id,
          agency_id: record.agency_id,
          agency_acronym: record.agency_acronym,
          published_at: record.published_at,
          title: record.title,
          text: record.extracted_text,
          aiEntities: ai.entities
        });
        directors += r.people;
      }
    }

    if (alerts.length) {
      await supabase.from("alerts").insert(alerts);
    }
    await flushMonitorAlerts(supabase, monitorAlerts, monitorHits);

    // F2 — notificação externa (best-effort, gated por ALERT_WEBHOOK_URL): empurra
    // os HITS DE MONITOR (watchlist do usuário = alto sinal) para o webhook. Não
    // notifica os atos de pessoal genéricos (evita spam). Nunca lança.
    const notified = await sendAlertWebhook(monitorAlerts, { label: "LINCE · Monitor DOU" });

    return res.status(200).json({
      ok: true,
      date,
      found: records.length,
      inserted,
      skipped,
      directors,
      alerts: alerts.length,
      monitor_alerts: monitorAlerts.length,
      notified: notified.ok ? notified.sent : (notified.skipped || notified.error || false)
    });
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message, source: "DOU/INLABS" });
  }
};
