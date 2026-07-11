// Backfill da classificacao por TEMA nos atos do DOU ja ingeridos.
// Aplica lib/themes.classifyThemes sobre titulo+texto e grava documents.themes.
// Pre-requisito: aplicar o bloco "Fase M14" do supabase/schema.sql (coluna themes).
//
// Uso:
//   node scripts/backfill-themes.js [--limit N] [--all] [--dry-run]
//     (default: so atos ainda sem tema; --all re-taggeia tudo)
require("dotenv").config();
const { getSupabase } = require("../lib/supabase");
const { classifyThemes } = require("../lib/themes");

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const all = process.argv.includes("--all");
  const limitArg = arg("--limit");
  const limit = (limitArg != null && Number.isFinite(Number(limitArg))) ? Number(limitArg) : Infinity;
  const supabase = getSupabase();

  const PAGE = 500;
  const MAX_ITERS = 100000; // backstop contra loop
  let processed = 0, updated = 0, empty = 0, from = 0, iters = 0;
  const counts = {};
  while (processed < limit) {
    if (++iters > MAX_ITERS) { console.error("Abortando: excesso de iteracoes."); break; }
    const { data, error } = await supabase
      .from("documents")
      .select("id, title, extracted_text, themes")
      .eq("source_name", "DOU")
      // Ordem deterministica (published_at e por DIA -> empata muito; id desempata),
      // essencial para --all/--dry-run nao pular/repetir registros na paginacao.
      .order("published_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    // filtro is-null so no modo default (re-tag: --all pega tudo)
    const rows = (data || []).filter((d) => all ? true : d.themes == null);
    if (error) { console.error("Erro ao listar documentos:", error.message); process.exit(1); }
    if (!rows.length) { if (!data || data.length < PAGE) break; from += PAGE; continue; }

    let updatedThisPage = 0;
    for (const d of rows) {
      if (processed >= limit) break;
      const themes = classifyThemes(d.title, d.extracted_text);
      for (const t of themes) counts[t] = (counts[t] || 0) + 1;
      if (!themes.length) empty++;
      if (dryRun) { processed++; continue; }
      const { error: upErr } = await supabase.from("documents").update({ themes }).eq("id", d.id);
      if (upErr) { console.error(`  x ${d.id}: ${upErr.message}`); continue; }
      updated++; updatedThisPage++; processed++;
    }
    // Guard de progresso (modo default, live): se filtramos por is-null e nada foi
    // gravado numa pagina cheia, o conjunto nunca encolhe -> aborta (evita loop #1).
    if (!all && !dryRun && rows.length && updatedThisPage === 0) {
      console.error("Abortando: nenhuma atualizacao progrediu (verifique permissoes/coluna themes).");
      break;
    }
    // Default+live: 'from' fica em 0 (o filtro is-null encolhe sozinho). Senao avanca.
    if (all || dryRun) from += PAGE;
    if (!data || data.length < PAGE) break;
  }

  console.log(`\n=== Backfill de temas concluido ===`);
  console.log(`Processados: ${processed} | atualizados: ${updated} | sem tema: ${empty}`);
  console.log(`Distribuicao de temas:`);
  for (const [t, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${n.toString().padStart(5)}  ${t}`);
  if (dryRun) console.log(`\n(dry-run: nada gravado)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
