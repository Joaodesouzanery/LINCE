// F2 — Canal de notificação externa de alertas (o "Arko Alerta"). Hoje os alertas
// só existem in-app; aqui empurramos os NOVOS para um webhook (Slack/Discord/Teams
// ou genérico). Determinístico e SEM chave paga: o usuário fornece a URL.
//
// Ativação (gated): env ALERT_WEBHOOK_URL. Sem ela -> skip gracioso (não quebra a
// ingestão). Padrão do projeto: retorna { ok, ... } e NUNCA lança para o caller.
//
// Payload universal: enviamos `text` (Slack), `content` (Discord) e `alerts` (webhook
// genérico) no mesmo corpo — cada destino lê o campo que entende.

function alertLine(a) {
  const sev = a && a.severity === "high" ? " ⚠" : "";
  const title = (a && (a.title || a.alert_type)) || "Alerta";
  // atos de pessoal usam `description`; hits de monitor usam `body`.
  const detail = a && (a.description || a.body);
  const desc = detail ? ` — ${String(detail).slice(0, 160)}` : "";
  return `• ${title}${sev}${desc}`;
}

// Envia os alertas NOVOS para o webhook configurado. `items` = array de alertas
// (aceita shapes distintos: atos de pessoal e hits de monitor). Best-effort.
async function sendAlertWebhook(items, { label = "LINCE" } = {}) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return { ok: false, skipped: "no_webhook" };
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) return { ok: false, skipped: "no_alerts" };

  const shown = list.slice(0, 20);
  const extra = list.length > shown.length ? `\n… +${list.length - shown.length} outro(s)` : "";
  const text = `🔔 ${label} — ${list.length} novo(s) alerta(s):\n${shown.map(alertLine).join("\n")}${extra}`;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, content: text, alerts: shown }),
      signal: AbortSignal.timeout(8000),
    });
    return { ok: resp.ok, status: resp.status, sent: list.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { sendAlertWebhook };
