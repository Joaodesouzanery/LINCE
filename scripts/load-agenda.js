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

  let inserted = 0, actsWithThemes = 0, transitions = 0, removed = 0;
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
    // F-INT1 (F4): UPSERT com HISTORICO de status (antes: delete+insert destruia a
    // transicao de estado do tema — o dado mais valioso: "saiu de planejado p/ em consulta").
    const { data: existing, error: exErr } = await supabase.from("regulatory_agenda")
      .select("id, theme_title, status, metadata").eq("source_document_id", act.id);
    if (exErr) { console.error(`   x ${act.id}: ${exErr.message}`); continue; }
    // byTitle: primeira linha por titulo; extras = duplicatas pre-existentes (limpaveis se sem historico).
    const byTitle = new Map(); const extraRows = [];
    for (const r of existing || []) {
      const k = String(r.theme_title).trim().toLowerCase();
      if (byTitle.has(k)) extraRows.push(r); else byTitle.set(k, r);
    }
    const seenTitles = new Set();
    const nowIso = new Date().toISOString();
    for (const t of themes) {
      const key = String(t.theme_title).trim().toLowerCase();
      if (seenTitles.has(key)) continue; // dedup INTRA-ATO: extrator repetiu o mesmo titulo
      seenTitles.add(key);
      const cur = byTitle.get(key);
      if (!cur) {
        const { error } = await supabase.from("regulatory_agenda").insert({
          agency_id: act.agency_id, biennium, theme_title: t.theme_title, status: t.status || null, area: t.area || null,
          source_document_id: act.id, source_url: act.source_url, metadata: { last_extracted_at: nowIso }
        });
        if (error) { console.error(`   x tema "${t.theme_title.slice(0, 40)}": ${error.message}`); continue; }
        inserted++;
      } else if ((t.status || null) !== (cur.status || null)) {
        // TRANSICAO de status -> registra no historico e atualiza.
        const hist = [...(((cur.metadata || {}).status_history) || []), { from: cur.status || null, to: t.status || null, at: nowIso }];
        const { error } = await supabase.from("regulatory_agenda")
          .update({ status: t.status || null, area: t.area || cur.area || null, metadata: { ...(cur.metadata || {}), status_history: hist, last_extracted_at: nowIso } })
          .eq("id", cur.id);
        if (error) { console.error(`   x transicao "${t.theme_title.slice(0, 40)}": ${error.message}`); continue; }
        console.log(`   ~ "${t.theme_title.slice(0, 50)}": ${cur.status || "—"} -> ${t.status || "—"}`);
        transitions++;
      } else {
        await supabase.from("regulatory_agenda").update({ metadata: { ...(cur.metadata || {}), last_extracted_at: nowIso } }).eq("id", cur.id);
      }
    }
    // Temas que sumiram do ato: remove SO os sem historico (provavel ruido de parser),
    // e SO quando a extracao parece completa (>=70% dos existentes) — extracao parcial/
    // flaky nao pode apagar tema valido.
    const extractionPlausible = !existing?.length || themes.length >= Math.ceil(existing.length * 0.7);
    if (extractionPlausible) {
      for (const [key, cur] of byTitle) {
        if (seenTitles.has(key)) continue;
        const hasHist = (((cur.metadata || {}).status_history) || []).length > 0;
        if (hasHist) { console.log(`   ! tema sumiu do ato mas tem historico — mantido: "${String(cur.theme_title).slice(0, 50)}"`); continue; }
        await supabase.from("regulatory_agenda").delete().eq("id", cur.id);
        removed++;
      }
    } else {
      console.log(`   ! extracao parcial (${themes.length}/${existing.length}) — sweep de remocao pulado`);
    }
    // Duplicatas pre-existentes do mesmo titulo: limpa as extras sem historico.
    for (const r of extraRows) {
      const hasHist = (((r.metadata || {}).status_history) || []).length > 0;
      if (hasHist) continue;
      await supabase.from("regulatory_agenda").delete().eq("id", r.id);
      removed++;
    }
  }

  console.log(`\n=== load:agenda concluido ===`);
  console.log(`Atos: ${acts.length} | com temas: ${actsWithThemes} | novos: ${inserted} | transicoes de status: ${transitions} | removidos (ruido): ${removed}${dryRun ? " (dry-run)" : ""}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
