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

// Fase 1 (1C): e-mail POR MONITOR. Ate aqui so o digest de PAINEL tinha e-mail —
// o monitor (a watchlist do cliente, o sinal mais alto do produto) so tinha webhook
// global, que nao serve para vender: o que gruda cliente e o e-mail que ele encaminha
// ao chefe. Agrupa os hits por monitor e manda 1 e-mail por destinatario.
// Best-effort: sem RESEND_API_KEY/RESEND_FROM, o mailer devolve skipped e nada quebra.
async function sendMonitorEmails(supabase, monitorAlerts, { label = "LINCE · Monitor DOU" } = {}) {
  const list = Array.isArray(monitorAlerts) ? monitorAlerts.filter(Boolean) : [];
  if (!list.length) return { ok: false, skipped: "no_alerts" };
  if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM) return { ok: false, skipped: "no_key" };
  const porMonitor = new Map();
  for (const a of list) {
    const mid = a?.metadata?.monitor_id || a?.target_id;
    if (!mid) continue;
    if (!porMonitor.has(mid)) porMonitor.set(mid, []);
    porMonitor.get(mid).push(a);
  }
  if (!porMonitor.size) return { ok: false, skipped: "no_monitor_id" };
  const { data: monitors, error } = await supabase.from("monitors")
    .select("id, label, owner_email").in("id", [...porMonitor.keys()]);
  if (error) return { ok: false, error: error.message };
  const { sendEmail } = require("./mailer");
  // Um destinatario pode vigiar varios monitores -> agrupa por e-mail (1 mensagem).
  const porEmail = new Map();
  for (const m of monitors || []) {
    const to = String(m.owner_email || "").trim();
    if (!to || !to.includes("@")) continue;
    if (!porEmail.has(to)) porEmail.set(to, []);
    porEmail.get(to).push({ monitor: m, hits: porMonitor.get(m.id) || [] });
  }
  if (!porEmail.size) return { ok: false, skipped: "no_recipient" };
  let sent = 0; const falhas = [];
  for (const [to, blocos] of porEmail) {
    const totalHits = blocos.reduce((s, b) => s + b.hits.length, 0);
    const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const corpoHtml = blocos.map((b) =>
      `<h3 style="margin:16px 0 4px;font-size:15px">${esc(b.monitor.label || "Monitor")} — ${b.hits.length} ocorrência(s)</h3>` +
      `<ul style="margin:0;padding-left:18px">${b.hits.slice(0, 20).map((h) => `<li style="margin:4px 0">${esc(h.title || "")}${h.body ? `<br><span style="color:#666;font-size:13px">${esc(String(h.body).slice(0, 200))}</span>` : ""}</li>`).join("")}</ul>` +
      (b.hits.length > 20 ? `<p style="color:#666;font-size:13px">…e mais ${b.hits.length - 20}.</p>` : "")
    ).join("");
    const r = await sendEmail({
      to,
      subject: `${label}: ${totalHits} ocorrência(s) em ${blocos.length} monitor(es)`,
      html: `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:640px"><p>Seus monitores registraram novas ocorrências no Diário Oficial:</p>${corpoHtml}<p style="color:#888;font-size:12px;margin-top:20px">Enviado automaticamente pela LINCE · dados públicos (DOU/INLABS).</p></div>`,
      text: blocos.map((b) => `${b.monitor.label}: ${b.hits.length} ocorrência(s)\n` + b.hits.slice(0, 20).map(alertLine).join("\n")).join("\n\n")
    });
    if (r.ok) sent++; else falhas.push(`${to}: ${r.error || r.skipped}`);
  }
  return { ok: sent > 0, sent, destinatarios: porEmail.size, falhas };
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

module.exports = { sendAlertWebhook, postWebhook, sendMonitorEmails };
