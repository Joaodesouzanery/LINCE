// Gate de acesso (M15) — Vercel Edge Middleware.
// Protege TODO o deploy (front + endpoints) com HTTP Basic Auth numa tacada.
// NAO conta no limite de 12 funcoes serverless do Hobby (middleware e separado).
//
// Regras:
// - Exige APP_USER/APP_PASS (env vars na Vercel). Enquanto NAO estiverem
//   configuradas, LIBERA (fail-open) — assim o deploy nao fica inacessivel
//   antes de voce setar as credenciais. Setou -> passa a exigir login.
// - Os endpoints de ingestao (/api/ingest-*) sao EXCLUIDOS aqui (o cron da
//   Vercel nao faz Basic Auth); eles tem protecao propria por CRON_SECRET
//   (Bearer). Ver o matcher abaixo (negative lookahead).
//
// Motivo: o LINCE produz dossie de contraparte, screening PEP/sancoes e toca
// CPF sob LGPD. "Privado por obscuridade" numa URL publica da Vercel nao e
// privado — este gate impede que quem achar a URL leia os dados.

// Comparacao de tempo (quase) constante — evita vazar o segredo char a char.
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default function middleware(request) {
  // Ingestao (/api/ingest-*) fica FORA do Basic Auth (o cron da Vercel nao faz
  // Basic Auth); e protegida pelo CRON_SECRET nos proprios handlers. Checagem
  // no codigo (mais portavel que matcher com negative-lookahead).
  let pathname = "/";
  try { pathname = new URL(request.url).pathname; } catch { /* usa "/" */ }
  if (pathname.startsWith("/api/ingest")) return;

  const user = process.env.APP_USER;
  const pass = process.env.APP_PASS;
  // Fail-open ate ser configurado (nao brickar o deploy antes de setar env).
  // Registra rastro nos logs — assim uma config parcial (so APP_USER, ou nome
  // de env errado) nao passa despercebida como "aberto silencioso".
  if (!user || !pass) {
    console.warn("[LINCE] middleware fail-open: APP_USER/APP_PASS ausentes — deploy SEM gate de acesso.");
    return;
  }

  const header = request.headers.get("authorization") || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    let decoded = "";
    try { decoded = atob(encoded); } catch { decoded = ""; }
    const i = decoded.indexOf(":");
    if (i >= 0 && safeEqual(decoded.slice(0, i), user) && safeEqual(decoded.slice(i + 1), pass)) {
      return; // autorizado -> segue para a rota normal
    }
  }
  return new Response("Autenticacao necessaria.", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="LINCE", charset="UTF-8"',
      "content-type": "text/plain; charset=utf-8"
    }
  });
}
