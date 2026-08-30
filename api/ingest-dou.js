// Endpoint de ingestao do DOU (chamado pelo Vercel Cron 1x/dia ou manualmente).
// GET /api/ingest-dou?date=YYYY-MM-DD  (default: hoje)
// Protegido por CRON_SECRET: header "authorization: Bearer <CRON_SECRET>".
const { getSupabase } = require("../lib/supabase");
const { collectDou } = require("../lib/dou");
const { analyzeAto } = require("../lib/anthropic");
const { persistDou } = require("../lib/dou-persist");
const { loadActiveMonitors, flushMonitorAlerts } = require("../lib/ingest");
const { timingSafeEqualStr } = require("../lib/timing");
const { sendAlertWebhook, sendMonitorEmails } = require("../lib/notify");

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
    if (records.discarded) console.log(`[ingest-dou ${date}] ${records.discarded}/${records.totalXml} atos sem match de agencia (descartados)`);

    // A rota HTTP tem 60s (vercel.json). Duas coisas nao cabem nela e por isso
    // ficam DESLIGADAS por padrao aqui:
    //   - IA: analyzeAto e uma chamada Claude por ato, sequencial. ~220 atos/dia
    //     dao ~7 min. scripts/backfill-ai.js preenche os resumos depois.
    //   - Pessoas: processPeopleFromDoc leva 25-30s sozinho e e trabalho duplicado
    //     do cron ingest-people-dou das 12:30.
    // ?ia=1 e ?pessoas=1 religam, para quando a chamada vem do CLI/Actions.
    const comIA = req.query.ia === "1";
    const comPessoas = req.query.pessoas === "1";

    const monitors = await loadActiveMonitors(supabase);
    const r = await persistDou(supabase, records, {
      analisar: comIA ? analyzeAto : null,
      comPessoas,
      monitores: monitors
    });
    const { inserted, skipped, directors, monitorAlerts, monitorHits } = r;

    await flushMonitorAlerts(supabase, monitorAlerts, monitorHits);

    // F2 — notificação externa (best-effort, gated por ALERT_WEBHOOK_URL): empurra
    // os HITS DE MONITOR (watchlist do usuário = alto sinal) para o webhook. Não
    // notifica os atos de pessoal genéricos (evita spam). Nunca lança.
    const notified = await sendAlertWebhook(monitorAlerts, { label: "LINCE · Monitor DOU" });
    // Fase 1 (1C): e-mail por monitor (monitors.owner_email). Best-effort — nunca lança.
    const emailed = await sendMonitorEmails(supabase, monitorAlerts, { label: "LINCE · Monitor DOU" })
      .catch((e) => ({ ok: false, error: e.message }));

    return res.status(200).json({
      ok: true,
      date,
      found: records.length,
      inserted,
      skipped,
      directors,
      alerts: r.alerts,
      monitor_alerts: monitorAlerts.length,
      // Declara o que NAO foi feito nesta rota, em vez de deixar o numero de
      // resumos vazios aparecer semanas depois como "a IA nao funciona".
      ia: comIA ? "aplicada" : `pulada (${r.pendentesDeIA} ato(s) sem resumo — use backfill:ai)`,
      pessoas: comPessoas ? "extraidas" : "puladas (cron ingest-people-dou)",
      notified: notified.ok ? notified.sent : (notified.skipped || notified.error || false),
      emailed: emailed.ok ? emailed.sent : (emailed.skipped || emailed.error || false),
      // falhas parciais de envio nao podem sumir so porque UM destinatario deu certo
      email_falhas: (emailed.falhas && emailed.falhas.length) ? emailed.falhas : undefined
    });
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message, source: "DOU/INLABS" });
  }
};
