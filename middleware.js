// Gate de acesso (M15) — Vercel Edge Middleware, com Supabase Auth.
// NAO conta no limite de 12 funcoes serverless do Hobby (middleware e separado).
//
// Modelo SPA: o front estatico (index.html/app.js/styles.css) e PUBLICO (nao
// contem segredo — a chave anon e publica E o banco tem RLS). Quem protege os
// DADOS via /api/* na Vercel e este gate; o banco em si e protegido por RLS
// (supabase/schema.sql, Fase M15) — as duas camadas sao necessarias.
//
// Regras (roda so em /api/* pelo matcher):
// - /api/ingest-* -> libera aqui (cron nao loga; protegido por CRON_SECRET).
// - /api/intelligence?type=auth_config -> libera (a tela de login precisa dele).
// - Demais /api/* -> exigem "Authorization: Bearer <jwt>" valido (via GoTrue) e,
//   se ALLOWED_EMAILS setada, o email na lista (senao 403).
// - PRODUCAO e FAIL-CLOSED: sem SUPABASE_ANON_KEY -> 503; ALLOWED_EMAILS vazia
//   -> 403 (signup e aberto na pagina, entao a allowlist e o gate real).
//   Em preview/dev, fail-open (conveniencia).
//
// LGPD: o LINCE toca CPF/dossie/screening — vazar = fim do negocio.

export const config = { matcher: ["/api/:path*"] };

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

function allowedEmails() {
  return String(process.env.ALLOWED_EMAILS || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export default async function middleware(request) {
  let url;
  try { url = new URL(request.url); } catch { return; }
  const pathname = url.pathname;

  // Defensivo (o matcher ja limita a /api/*): so gate para APIs.
  if (!pathname.startsWith("/api/")) return;
  // Ingestao fica fora do gate JWT (cron nao loga) — protegida por CRON_SECRET.
  if (pathname.startsWith("/api/ingest")) return;
  // Config publica de auth (a tela de login precisa dela antes de existir sessao).
  if (pathname.startsWith("/api/intelligence") && url.searchParams.get("type") === "auth_config") return;

  const isProd = process.env.VERCEL_ENV === "production";
  const supaUrl = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;

  // Sem config de auth: em PRODUCAO -> fail-CLOSED (503); em preview/dev -> libera.
  if (!supaUrl || !anon) {
    if (isProd) return jsonResponse(503, { ok: false, error: "Login nao configurado (SUPABASE_ANON_KEY)." });
    console.warn("[LINCE] middleware fail-open (preview/dev): SUPABASE_ANON_KEY ausente.");
    return;
  }

  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return jsonResponse(401, { ok: false, error: "Nao autenticado." });

  // Valida o token no GoTrue (verifica assinatura/expiracao) e obtem o usuario.
  let user = null;
  try {
    const r = await fetch(`${supaUrl}/auth/v1/user`, {
      headers: { apikey: anon, authorization: `Bearer ${token}` }
    });
    if (r.ok) user = await r.json();
  } catch { /* rede indisponivel -> nao autorizado */ }
  if (!user || !user.id) return jsonResponse(401, { ok: false, error: "Sessao invalida ou expirada." });

  // Allowlist (signup e aberto na pagina). Em PRODUCAO, allowlist vazia = NEGA
  // (senao qualquer um que se cadastre acessaria). Em preview/dev, libera.
  const allow = allowedEmails();
  if (!allow.length) {
    if (isProd) return jsonResponse(403, { ok: false, error: "Allowlist (ALLOWED_EMAILS) nao configurada." });
  } else if (!allow.includes(String(user.email || "").toLowerCase())) {
    return jsonResponse(403, { ok: false, error: "Email nao autorizado a acessar o LINCE." });
  }
  return; // autorizado -> segue
}
