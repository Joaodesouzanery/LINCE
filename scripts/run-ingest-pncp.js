// Popula contratos do PNCP por agencia (camada financeira / M6).
// Requer CNPJs em agencies.collection_rules.cnpj (rode db:agencies-cnpj antes).
// Uso: node scripts/run-ingest-pncp.js [AAAAMMDD inicial] [AAAAMMDD final]
require("dotenv").config();
const { getSupabase } = require("../lib/supabase");
const { fetchAllContractsByOrgao } = require("../lib/pncp");

async function main() {
  const supabase = getSupabase();
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const dataInicial = process.argv[2] || `${today.slice(0, 4)}0101`;
  const dataFinal = process.argv[3] || today;

  const { data: agencies } = await supabase
    .from("agencies")
    .select("id, acronym, collection_rules")
    .eq("sector", "regulatory");

  let inserted = 0, skipped = 0, noCnpj = [];
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
    }
  }
  console.log(`\nConcluido: ${inserted} contratos inseridos, ${skipped} ja existiam.`);
  if (noCnpj.length) console.log(`Sem CNPJ (rode db:agencies-cnpj): ${noCnpj.join(", ")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
