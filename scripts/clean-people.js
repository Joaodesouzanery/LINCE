// Limpa falsos positivos JA gravados em `people` (toponimos como "Rio de Janeiro",
// termos institucionais, nomes de formato improvavel) usando o MESMO validador do
// extrator (lib/dou.isLikelyPersonName) — o que o extrator apertado hoje rejeita,
// aqui e removido do historico. Remove tambem arestas/alertas orfaos (genericos,
// sem FK). mandates/party_links/assets caem por ON DELETE CASCADE. SEM IA.
//
// Uso:
//   node scripts/clean-people.js            # DRY-RUN: so lista o que removeria
//   node scripts/clean-people.js --commit   # apaga de verdade
//
// DELETE em producao -> rode o dry-run e revise a lista antes do --commit.
require("dotenv").config();
const { getSupabase } = require("../lib/supabase");
const { fetchAllPeople } = require("../lib/tse-match");
const { isLikelyPersonName } = require("../lib/dou");

async function main() {
  const commit = process.argv.includes("--commit");
  const supabase = getSupabase();
  const people = await fetchAllPeople(supabase);
  const bad = people.filter((p) => !isLikelyPersonName(p.full_name));
  console.log(`Pessoas: ${people.length} | falsos positivos detectados: ${bad.length}`);
  if (!bad.length) { console.log("Nada a limpar."); return; }

  const sample = bad.slice(0, 50).map((p) => p.full_name);
  console.log(`\nAmostra (ate 50):`);
  for (const n of sample) console.log(`  - ${n}`);

  if (!commit) {
    console.log(`\n(DRY-RUN) ${bad.length} pessoas seriam removidas (+ arestas/alertas orfaos).`);
    console.log(`Revise a lista acima e rode com --commit para apagar.`);
    return;
  }

  // --commit: apaga em lotes. relationships e alerts sao genericos (from/to/target
  // kind+id, sem FK) -> apagar explicitamente; people leva mandates/party_links/
  // assets por ON DELETE CASCADE.
  let removed = 0, rels = 0, alerts = 0;
  const CHUNK = 100;
  for (let i = 0; i < bad.length; i += CHUNK) {
    const ids = bad.slice(i, i + CHUNK).map((p) => p.id);
    const r1 = await supabase.from("relationships").delete({ count: "exact" }).eq("from_kind", "person").in("from_id", ids);
    if (r1.error) console.error(`  rel(from): ${r1.error.message}`); else rels += r1.count || 0;
    const r2 = await supabase.from("relationships").delete({ count: "exact" }).eq("to_kind", "person").in("to_id", ids);
    if (r2.error) console.error(`  rel(to): ${r2.error.message}`); else rels += r2.count || 0;
    const a1 = await supabase.from("alerts").delete({ count: "exact" }).eq("target_kind", "person").in("target_id", ids);
    if (a1.error) console.error(`  alerts: ${a1.error.message}`); else alerts += a1.count || 0;
    const p1 = await supabase.from("people").delete({ count: "exact" }).in("id", ids);
    if (p1.error) console.error(`  people: ${p1.error.message}`); else removed += p1.count || 0;
  }
  console.log(`\n=== Limpeza concluida ===`);
  console.log(`Pessoas removidas: ${removed} | arestas orfas: ${rels} | alertas orfaos: ${alerts}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
