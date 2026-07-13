// Popula regulatory_agenda: acha os atos do DOU que aprovam/atualizam a Agenda
// Regulatoria e extrai os temas itemizados. Com ANTHROPIC_API_KEY -> extracao
// de qualidade (lib/anthropic.extractAgendaThemes); sem chave -> heuristica
// best-effort (linhas numeradas). Pre-requisito: bloco "Fase M16" do schema.
//
// Uso: node scripts/load-agenda.js [--limit N] [--dry-run]
require("dotenv").config();
const { getSupabase } = require("../lib/supabase");
const { extractAgendaThemes } = require("../lib/anthropic");

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }

// Fallback sem IA: linhas tipo "Item 1 - Tema", "1. Tema", "1) Tema".
function heuristicThemes(text) {
  const out = [];
  for (const raw of String(text || "").split(/\n|;|\.(?=\s+\d)/)) {
    const m = raw.trim().match(/^(?:item\s+)?\d{1,3}\s*[\.\)\-–]\s*(.{8,160})$/i);
    if (m) out.push({ theme_title: m[1].trim().slice(0, 300), status: null, area: null });
  }
  return out.slice(0, 120);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const limit = Math.max(1, Number(arg("--limit")) || 30);
  const supabase = getSupabase();
  const hasKey = !!process.env.ANTHROPIC_API_KEY;
  console.log(hasKey ? "Extracao por IA (ANTHROPIC_API_KEY presente)." : "Sem ANTHROPIC_API_KEY -> heuristica best-effort.");

  // Atos de agenda: por tema (backfillado) OU por titulo. Duas queries, dedup por id.
  const cols = "id, title, extracted_text, published_at, source_url, agency_id";
  const [byTheme, byTitle] = await Promise.all([
    supabase.from("documents").select(cols).eq("source_name", "DOU")
      .contains("themes", ["Agenda Regulatória"]).order("published_at", { ascending: false }).limit(limit),
    supabase.from("documents").select(cols).eq("source_name", "DOU")
      .ilike("title", "%agenda regulat%").order("published_at", { ascending: false }).limit(limit)
  ]);
  const seen = new Set();
  const acts = [];
  for (const d of [...(byTheme.data || []), ...(byTitle.data || [])]) {
    if (seen.has(d.id)) continue; seen.add(d.id); acts.push(d);
  }
  console.log(`Atos de agenda encontrados: ${acts.length}`);

  let inserted = 0, actsWithThemes = 0;
  for (const act of acts.slice(0, limit)) {
    let themes = [], biennium = null;
    if (hasKey) {
      const r = await extractAgendaThemes(act.extracted_text);
      themes = r.themes || [];
      biennium = r.biennium || null;  // bienio e por-ato (nao por-tema)
    } else {
      themes = heuristicThemes(act.extracted_text);
    }
    if (!themes.length) continue;
    actsWithThemes++;
    console.log(`  ${act.title?.slice(0, 60)} -> ${themes.length} tema(s)${biennium ? ` [${biennium}]` : ""}`);
    if (dryRun) continue;
    // Re-executavel: limpa os temas antigos deste ato e reinsere.
    await supabase.from("regulatory_agenda").delete().eq("source_document_id", act.id);
    const rows = themes.map((t) => ({
      agency_id: act.agency_id, biennium, theme_title: t.theme_title, status: t.status || null, area: t.area || null,
      source_document_id: act.id, source_url: act.source_url
    }));
    const { error } = await supabase.from("regulatory_agenda").insert(rows);
    if (error) { console.error(`   x ${act.id}: ${error.message}`); continue; }
    inserted += rows.length;
  }

  console.log(`\n=== load:agenda concluido ===`);
  console.log(`Atos: ${acts.length} | com temas: ${actsWithThemes} | temas inseridos: ${inserted}${dryRun ? " (dry-run)" : ""}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
