// Remove pessoas ORFAS: sem NENHUMA referencia (mandato, party_link, asset, voto,
// deliberacao relatada, aresta de relationship). Depois do fix-agency-attribution,
// os ex-"diretores da ANA" perderam o mandato mas continuam em `people` (com
// agency_id da ANA) — ainda apareceriam na lista de Diretores. Isso os expurga.
// SEM IA. DELETE em producao -> dry-run primeiro.
//
// Uso: node scripts/clean-orphan-people.js            (DRY-RUN)
//      node scripts/clean-orphan-people.js --commit
require("dotenv").config();
const { getSupabase } = require("../lib/supabase");
const { fetchAllPeople } = require("../lib/tse-match");

async function allValues(supabase, table, column, extraEq) {
  const out = new Set();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from(table).select(column).order(column, { ascending: true }).range(from, from + PAGE - 1);
    if (extraEq) q = q.eq(extraEq[0], extraEq[1]);
    const { data, error } = await q;
    if (error) throw new Error(`${table}.${column}: ${error.message}`);
    for (const r of data || []) if (r[column]) out.add(r[column]);
    if (!data || data.length < PAGE) break;
  }
  return out;
}

async function main() {
  const commit = process.argv.includes("--commit");
  const supabase = getSupabase();
  const people = await fetchAllPeople(supabase);

  // Ids referenciados por qualquer sinal.
  const referenced = new Set();
  const add = (set) => { for (const v of set) referenced.add(v); };
  add(await allValues(supabase, "mandates", "person_id"));
  add(await allValues(supabase, "party_links", "person_id"));
  add(await allValues(supabase, "assets", "person_id"));
  add(await allValues(supabase, "votes", "voter_person_id"));
  add(await allValues(supabase, "deliberations", "rapporteur_person_id"));
  add(await allValues(supabase, "relationships", "from_id", ["from_kind", "person"]));
  add(await allValues(supabase, "relationships", "to_id", ["to_kind", "person"]));

  const orphans = people.filter((p) => !referenced.has(p.id));
  console.log(`Pessoas: ${people.length} | com referencia: ${referenced.size} | ORFAS: ${orphans.length}`);
  console.log(`Amostra: ${orphans.slice(0, 20).map((p) => p.full_name).join(" | ")}`);

  if (!commit) { console.log(`\n(DRY-RUN) rode com --commit para remover.`); return; }

  const ids = orphans.map((p) => p.id);
  let removed = 0, alerts = 0;
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const a = await supabase.from("alerts").delete({ count: "exact" }).eq("target_kind", "person").in("target_id", slice);
    if (!a.error) alerts += a.count || 0;
    const d = await supabase.from("people").delete({ count: "exact" }).in("id", slice);
    if (!d.error) removed += d.count || 0;
  }
  console.log(`\nRemovidas: ${removed} pessoas orfas | ${alerts} alertas.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
