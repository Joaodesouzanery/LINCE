// Backfill dos resumos de IA nos atos do DOU ja ingeridos.
// A ingestao pula documentos existentes (dedupe por hash), entao setar a
// ANTHROPIC_API_KEY depois NAO reprocessa o historico — este script faz isso.
// Reprocessa documentos com extraction_status='raw' (IA nao rodou / falhou),
// chama analyzeAto e atualiza metadata.ai_summary/ai_entities/ai_confidence.
//
// Uso:
//   node scripts/backfill-ai.js [--limit N] [--dry-run]
// Requer ANTHROPIC_API_KEY. Throttle padrao 1.5s entre chamadas (CNPJWS-like);
// ajuste com AI_THROTTLE_MS conforme seu limite de taxa da Anthropic.
require("dotenv").config();
const { getSupabase } = require("../lib/supabase");
const { analyzeAto } = require("../lib/anthropic");

const THROTTLE_MS = Number(process.env.AI_THROTTLE_MS || 1500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY ausente. Configure antes de rodar o backfill.");
    process.exit(1);
  }
  const dryRun = process.argv.includes("--dry-run");
  const limit = Math.max(1, Number(arg("--limit")) || 500);
  const supabase = getSupabase();

  // Documentos do DOU cuja IA nunca produziu saida (extraction_status='raw').
  const PAGE = 200;
  const docs = [];
  for (let from = 0; docs.length < limit; from += PAGE) {
    const { data, error } = await supabase
      .from("documents")
      .select("id, title, extracted_text, metadata, extraction_status")
      .eq("source_name", "DOU")
      .eq("extraction_status", "raw")
      .order("published_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) { console.error("Erro ao listar documentos:", error.message); process.exit(1); }
    docs.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  const targets = docs.slice(0, limit);
  console.log(`Atos para reprocessar (extraction_status='raw'): ${targets.length}`);
  if (!targets.length) return;

  let ok = 0, empty = 0, failed = 0;
  for (let i = 0; i < targets.length; i++) {
    const d = targets[i];
    if (dryRun) { console.log(`  [dry] ${d.id} ${String(d.title || "").slice(0, 70)}`); continue; }
    try {
      const ai = await analyzeAto(d.title, d.extracted_text);
      if (!ai.summary) {
        empty++;
        if (ai.error) console.log(`  ! ${d.id} IA erro: ${ai.error}`);
        else console.log(`  . ${d.id} IA sem resumo (${ai.skipped || "vazio"})`);
      } else {
        const metadata = { ...(d.metadata || {}), ai_summary: ai.summary, ai_entities: ai.entities, ai_confidence: ai.confidence };
        const { error: upErr } = await supabase
          .from("documents")
          .update({ metadata, extraction_status: "summarized" })
          .eq("id", d.id);
        if (upErr) { failed++; console.log(`  x ${d.id} update: ${upErr.message}`); }
        else { ok++; console.log(`  + ${d.id} resumo ok (conf ${ai.confidence})`); }
      }
    } catch (e) { failed++; console.log(`  x ${d.id} ${e.message}`); }
    if (i < targets.length - 1) await sleep(THROTTLE_MS);
  }

  console.log(`\n=== Backfill IA concluido ===`);
  console.log(`Processados: ${targets.length} | resumidos: ${ok} | sem resumo: ${empty} | falhas: ${failed}`);
  if (dryRun) console.log(`(dry-run: nada gravado)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
