// Popula contratos do PNCP por agencia (camada financeira / M6).
// Requer CNPJs em agencies.collection_rules.cnpj (rode db:agencies-cnpj antes).
// Uso: node scripts/run-ingest-pncp.js [AAAAMMDD inicial] [AAAAMMDD final]
require("dotenv").config();
const { getSupabase } = require("../lib/supabase");
const { fetchAllContractsByOrgao } = require("../lib/pncp");
const { loadActiveMonitors, matchMonitorsForDoc, bumpMonitorHits } = require("../lib/ingest");

// F-INT1 (F4): monitores tambem vigiam CONTRATOS novos (antes: so DOU). Dedup por
// (monitor, pncp_id) via checagem previa — alerts nao tem unique p/ fonte sem documento.
async function alertMonitorsForContract(supabase, monitors, ag, c) {
  if (!monitors.length) return 0;
  const hits = matchMonitorsForDoc(monitors, {
    docId: null, title: c.object || "", text: `${c.object || ""} ${c.supplier_name || ""} ${c.supplier_cnpj || ""}`,
    agencyId: ag.id, agencyAcronym: ag.acronym, publishedAt: c.signed_at
  });
  let n = 0;
  const counts = new Map();
  for (const h of hits) {
    const { data: dup, error: dupErr } = await supabase.from("alerts").select("id")
      .eq("alert_type", "monitor").eq("target_id", h.monitorId)
      .eq("metadata->>pncp_id", String(c.pncp_id)).limit(1).maybeSingle();
    if (dupErr) { console.error(`  alerta monitor ${c.pncp_id}: dedup falhou (${dupErr.message}) — pulando p/ nao duplicar`); continue; }
    if (dup) continue;
    const alert = { ...h.alert, title: `Monitor (contrato): ${h.alert.title.replace(/^Monitor: /, "")}`,
      body: `Contrato PNCP ${ag.acronym}: ${(c.object || "").slice(0, 160)} — ${c.supplier_name || c.supplier_cnpj || ""}`.slice(0, 200),
      metadata: { ...h.alert.metadata, source: "pncp", pncp_id: c.pncp_id, value: c.value } };
    const { error } = await supabase.from("alerts").insert(alert);
    if (!error) { n++; counts.set(h.monitorId, (counts.get(h.monitorId) || 0) + 1); }
  }
  if (counts.size) await bumpMonitorHits(supabase, counts).catch(() => {}); // hit_count coerente com o fluxo DOU
  return n;
}

async function main() {
  const supabase = getSupabase();
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const dataInicial = process.argv[2] || `${today.slice(0, 4)}0101`;
  const dataFinal = process.argv[3] || today;

  const { data: agencies } = await supabase
    .from("agencies")
    .select("id, acronym, collection_rules")
    .eq("sector", "regulatory");

  let inserted = 0, skipped = 0, monitorAlerts = 0, noCnpj = [];
  const monitors = await loadActiveMonitors(supabase);
  for (const ag of agencies || []) {
    const cnpj = ag.collection_rules?.cnpj;
    if (!cnpj) { noCnpj.push(ag.acronym); continue; }
    const result = await fetchAllContractsByOrgao(cnpj, dataInicial, dataFinal);
    if (!result.ok) { console.log(`  ${ag.acronym}: ${result.error}`); continue; }
    console.log(`${ag.acronym}: ${result.items.length} contratos retornados`);

    for (const c of result.items) {
      if (!c.pncp_id) continue;
      const { data: exists } = await supabase.from("contracts").select("id").eq("pncp_id", c.pncp_id).maybeSingle();
      if (exists) { skipped++; continue; }

      let supplier_company_id = null;
      if (c.supplier_cnpj) {
        const { data: comp } = await supabase.from("companies")
          .upsert({ cnpj: c.supplier_cnpj, legal_name: c.supplier_name || c.supplier_cnpj }, { onConflict: "cnpj" })
          .select("id").single();
        supplier_company_id = comp?.id || null;
      }

      await supabase.from("contracts").insert({
        agency_id: ag.id, supplier_company_id, supplier_cnpj: c.supplier_cnpj,
        supplier_name: c.supplier_name, object: c.object, modality: c.modality,
        value: c.value, signed_at: c.signed_at, ends_at: c.ends_at,
        pncp_id: c.pncp_id, source_url: c.source_url, metadata: { raw: c.raw }
      });
      inserted++;

      if (supplier_company_id) {
        await supabase.from("relationships").insert({
          from_kind: "company", from_id: supplier_company_id,
          to_kind: "agency", to_id: ag.id, relationship: "reported",
          confidence_score: 1, metadata: { kind: "contract", pncp_id: c.pncp_id, value: c.value }
        });
      }

      monitorAlerts += await alertMonitorsForContract(supabase, monitors, ag, c).catch((e) => { console.error(`  alerta monitor (contrato ${c.pncp_id}): ${e.message}`); return 0; });
    }
  }
  console.log(`\nConcluido: ${inserted} contratos inseridos, ${skipped} ja existiam, ${monitorAlerts} alerta(s) de monitor.`);
  if (noCnpj.length) console.log(`Sem CNPJ (rode db:agencies-cnpj): ${noCnpj.join(", ")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
