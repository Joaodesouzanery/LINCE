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
  const { error } = await supabase.from("proposicoes").upsert(rows, { onConflict: "id" });
  if (error) { console.error("Erro:", error.message); process.exit(1); }
  console.log(`Upsert OK: ${rows.length} proposicoes.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
