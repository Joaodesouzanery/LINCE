// Persiste proposicoes da Camara/Senado (hoje o radar legislativo e so ao vivo,
// sem historico). Busca por uma lista curada de termos regulatorios e faz upsert
// por id estavel ("camara:"/"senado:"), preservando first_seen. Pre-requisito:
// bloco "Fase M18" do schema (tabela proposicoes). SEM IA.
//
// Uso: node scripts/load-proposicoes.js [--dry-run]
require("dotenv").config();
const { getSupabase } = require("../lib/supabase");
const { searchProposicoes } = require("../lib/legislativo");

// Termos regulatorios (setores das 11 agencias) — o recorte que interessa ao LINCE.
const TERMS = [
  "agência reguladora", "regulação", "energia elétrica", "petróleo", "gás natural",
  "telecomunicações", "vigilância sanitária", "saúde suplementar", "saneamento básico",
  "recursos hídricos", "transporte terrestre", "transporte aquaviário", "aviação civil",
  "mineração", "concessão", "tarifa", "agência nacional"
];

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const supabase = getSupabase();
  const seen = new Map();
  for (const q of TERMS) {
    const r = await searchProposicoes({ q, casa: "both", limit: 30 }).catch(() => ({ items: [] }));
    for (const p of r.items || []) if (p && p.id) seen.set(p.id, p);
    process.stdout.write(`  ${q}: ${(r.items || []).length}\n`);
  }
  const now = new Date().toISOString();
  const rows = [...seen.values()].map((p) => ({
    id: p.id, casa: p.casa || null, tipo: p.tipo || null, numero: p.numero != null ? String(p.numero) : null,
    ano: p.ano ? Number(p.ano) : null, ementa: p.ementa || null, titulo: p.titulo || null,
    autor: p.autor || null, url: p.url || null, last_seen: now
    // first_seen NAO vai no payload: default now() no insert; no conflito, preservado.
  }));
  console.log(`\nProposicoes unicas: ${rows.length}${dryRun ? " (dry-run)" : ""}`);
  if (dryRun || !rows.length) return;

  // F-INT1 (F4): identifica as NOVAS antes do upsert (p/ avaliar monitores so nelas).
  const ids = rows.map((r) => r.id);
  const existing = new Set();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await supabase.from("proposicoes").select("id").in("id", ids.slice(i, i + 200));
    for (const e of data || []) existing.add(e.id);
  }
  const novas = rows.filter((r) => !existing.has(r.id));

  const { error } = await supabase.from("proposicoes").upsert(rows, { onConflict: "id" });
  if (error) { console.error("Erro:", error.message); process.exit(1); }
  console.log(`Upsert OK: ${rows.length} proposicoes (${novas.length} novas).`);

  // F-INT1 (F4): monitores tambem vigiam PROPOSICOES novas (antes: so DOU).
  // Dedup por (monitor, proposicao_id) via checagem previa.
  if (novas.length) {
    const { loadActiveMonitors, matchMonitorsForDoc, bumpMonitorHits } = require("../lib/ingest");
    const monitors = await loadActiveMonitors(supabase);
    let alerts = 0;
    const counts = new Map();
    for (const prop of novas) {
      if (!monitors.length) break;
      const hits = matchMonitorsForDoc(monitors, {
        docId: null, title: prop.titulo || "", text: `${prop.titulo || ""} ${prop.ementa || ""} ${prop.autor || ""}`,
        agencyId: null, publishedAt: null
      });
      for (const h of hits) {
        const { data: dup, error: dupErr } = await supabase.from("alerts").select("id")
          .eq("alert_type", "monitor").eq("target_id", h.monitorId)
          .eq("metadata->>proposicao_id", String(prop.id)).limit(1).maybeSingle();
        if (dupErr) { console.error(`  monitor prop ${prop.id}: dedup falhou (${dupErr.message}) — pulando`); continue; }
        if (dup) continue;
        const alert = { ...h.alert, title: `Monitor (proposição): ${h.alert.title.replace(/^Monitor: /, "")}`,
          body: `${prop.titulo || prop.id}: ${(prop.ementa || "").slice(0, 160)}`.slice(0, 200),
          metadata: { ...h.alert.metadata, source: "legislativo", proposicao_id: prop.id, url: prop.url } };
        const { error: aErr } = await supabase.from("alerts").insert(alert);
        if (!aErr) { alerts++; counts.set(h.monitorId, (counts.get(h.monitorId) || 0) + 1); }
      }
    }
    if (counts.size) await bumpMonitorHits(supabase, counts).catch(() => {});
    if (alerts) console.log(`${alerts} alerta(s) de monitor sobre proposicoes novas.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
