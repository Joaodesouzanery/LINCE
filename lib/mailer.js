// F3 (NOMOS) — envio de e-mail via Resend (HTTP direto, sem SDK — molde lib/anthropic).
// GATED: sem RESEND_API_KEY + RESEND_FROM -> skip gracioso { ok:false, skipped:"no_key" }.
// Padrao do projeto: retorna { ok, ... } e NUNCA lanca para o caller. "Pronto p/ ligar":
// o codigo fica no lugar; basta setar as duas envs (sem redeploy de logica).
const API_URL = "https://api.resend.com/emails";

// to: string | string[]. Precisa de subject + (html OU text).
async function sendEmail({ to, subject, html, text } = {}) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!apiKey || !from) return { ok: false, skipped: "no_key" };

  const dest = Array.isArray(to) ? to.filter(Boolean) : (to ? [to] : []);
  if (!dest.length) return { ok: false, skipped: "no_recipient" };
  if (!subject || (!html && !text)) return { ok: false, skipped: "no_content" };

  try {
    const resp = await fetch(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ from, to: dest, subject, ...(html ? { html } : {}), ...(text ? { text } : {}) }),
      signal: AbortSignal.timeout(10000),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) return { ok: false, status: resp.status, error: body?.message || body?.name || `HTTP ${resp.status}` };
    return { ok: true, id: body?.id || null, sent: dest.length };
  } catch (e) {
    return { ok: false, error: e.name === "TimeoutError" ? "timeout" : e.message };
  }
}

module.exports = { sendEmail };
