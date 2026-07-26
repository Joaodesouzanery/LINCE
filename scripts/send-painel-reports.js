// F3 (NOMOS) — Envia o digest de cada painel ATIVO (novas votacoes desde o ultimo
// envio) por WEBHOOK (webhook_url do painel) e E-MAIL (owner_email, gated Resend).
// Roda no GitHub Actions (Vercel Hobby ja esta no limite de crons/funcoes).
//
// Uso: node scripts/send-painel-reports.js [--dry-run] [--force]
//   --force: envia mesmo sem novidade (ignora has_novidade)
//
// 'tempo_real' roda no mesmo ciclo diario por ora (real-time = hook na ingestao, depois).
require("dotenv").config();
const { getSupabase } = require("../lib/supabase");
const { buildPainelDigest, toText, toEmailHtml } = require("../lib/painel-report");
const { postWebhook } = require("../lib/notify");
const { sendEmail } = require("../lib/mailer");

const WEEK_MS = 7 * 24 * 3600 * 1000;

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");
  const supabase = getSupabase();

  const { data: paineis, error } = await supabase.from("paineis").select("*")
    .eq("active", true).in("frequencia", ["tempo_real", "diario"]);
  if (error) { console.error(`Falha ao ler paineis: ${error.message}`); process.exit(1); }
  console.log(`Paineis ativos (tempo_real/diario): ${(paineis || []).length}`);

  let enviados = 0, semNovidade = 0, semCanal = 0, falhas = 0;
  for (const p of paineis || []) {
    const since = p.last_report_at || new Date(Date.now() - WEEK_MS).toISOString();
    let digest;
    // byIngestion: conta como "novo" o que foi INGERIDO desde o ultimo envio (evita
    // duplicar no limite do dia e nao perde votacao ingerida com atraso).
    try { digest = await buildPainelDigest(supabase, p.id, { since, byIngestion: true }); }
    catch (e) { falhas++; console.error(`  x digest ${p.nome}: ${e.message}`); continue; }
    if (!digest) { falhas++; continue; }

    if (!digest.has_novidade && !force) { semNovidade++; console.log(`  - ${p.nome}: sem novidade desde ${String(since).slice(0, 10)}`); continue; }
    if (!p.webhook_url && !p.owner_email) { semCanal++; console.log(`  ! ${p.nome}: sem webhook_url nem owner_email`); continue; }

    if (dryRun) { console.log(`  [dry] ${p.nome}: ${digest.counts.novas_votacoes} nova(s) votacao(oes) -> ${p.webhook_url ? "webhook " : ""}${p.owner_email ? "email" : ""}`); continue; }

    const [wh, em] = await Promise.all([
      p.webhook_url ? postWebhook(p.webhook_url, { text: toText(digest), label: p.nome }) : Promise.resolve({ skipped: "no_webhook_url" }),
      p.owner_email ? sendEmail({ to: p.owner_email, subject: `LINCE · Painel ${p.nome}`, html: toEmailHtml(digest), text: toText(digest) }) : Promise.resolve({ skipped: "no_owner_email" })
    ]);
    const up = await supabase.from("paineis").update({ last_report_at: new Date().toISOString() }).eq("id", p.id);
    if (up.error) console.error(`  ! last_report_at nao gravado (${p.nome}): ${up.error.message} — aplique M21.1`);
    enviados++;
    console.log(`  ✓ ${p.nome}: webhook=${wh.ok ? "ok" : (wh.skipped || wh.error)} email=${em.ok ? "ok" : (em.skipped || em.error)}`);
  }

  console.log(`\n=== Digest de paineis concluido ===`);
  console.log(`Enviados: ${enviados} | sem novidade: ${semNovidade} | sem canal: ${semCanal} | falhas: ${falhas}`);
  if (dryRun) console.log("(dry-run: nada enviado)");
}

main().catch((e) => { console.error(e); process.exit(1); });
