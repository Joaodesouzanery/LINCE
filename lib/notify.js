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

// Bloqueia destinos internos (anti-SSRF): loopback/link-local/privados por LITERAL de
// IP + hostnames locais. O webhook_url e do dono do painel e o POST parte server-side;
// so dados publicos sao enviados e o corpo NAO e refletido, mas fechamos o oraculo de
// alcancabilidade interna (ex.: 169.254.169.254). Nao cobre DNS-rebinding (residual aceito).
function isBlockedWebhookHost(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "::1" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true; // IPv6 loopback/link-local/ULA
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a === 0 || a === 127 || a === 10 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return true;
  }
  return false;
}

// F3 — POST genérico p/ um webhook_url EXPLÍCITO (o do painel), não o env global.
// `text` alimenta Slack/Discord/genérico; `payload` (opcional) vai junto p/ webhook
// customizado. Best-effort, timeout 8s, NUNCA lança. Sem url -> skip gracioso.
async function postWebhook(url, { text = "", payload = null, label = "LINCE" } = {}) {
  if (!url || !/^https?:\/\//.test(url)) return { ok: false, skipped: "no_webhook" };
  let parsed;
  try { parsed = new URL(url); } catch { return { ok: false, skipped: "bad_url" }; }
  if (isBlockedWebhookHost(parsed.hostname)) return { ok: false, skipped: "blocked_host" };
  const body = { text, content: text, ...(payload ? { data: payload } : {}) };
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    return { ok: resp.ok, status: resp.status, label };
  } catch (e) {
    return { ok: false, error: e.name === "TimeoutError" ? "timeout" : e.message };
  }
}

module.exports = { sendAlertWebhook, postWebhook };
