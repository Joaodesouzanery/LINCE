// M6 - Ingestao de contratos do PNCP por agencia.
// O CNPJ de cada agencia deve estar em agencies.collection_rules.cnpj.
// GET /api/ingest-pncp?acronym=ANEEL&dataInicial=20260101&dataFinal=20260612
const { getSupabase } = require("../lib/supabase");
const { fetchAllContractsByOrgao } = require("../lib/pncp");
const { timingSafeEqualStr } = require("../lib/timing");
const { isValidCnpj } = require("../lib/text");

function fmt(d) { return d.replace(/-/g, ""); }

// Gate por CRON_SECRET (mesmo padrao do ingest-dou). Sem secret -> libera
// (uso single-user); o middleware Basic Auth cobre o restante do deploy.
function authorized(req) {
  const secret = process.env.CRON_SECRET;
  // Fail-closed em PRODUCAO: sem CRON_SECRET, nega. Preview/dev libera.
  if (!secret) return process.env.VERCEL_ENV !== "production";
  return timingSafeEqualStr(req.headers.authorization, `Bearer ${secret}`);
}

module.exports = async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: "Nao autorizado." });
  try {
    const supabase = getSupabase();
    const acronym = req.query.acronym ? String(req.query.acronym).toUpperCase() : null;

    let agencies;
    if (acronym) {
      ({ data: agencies } = await supabase.from("agencies").select("id, acronym, collection_rules").eq("acronym", acronym));
    } else {
      ({ data: agencies } = await supabase.from("agencies").select("id, acronym, collection_rules").eq("sector", "regulatory"));
    }
    if (!agencies?.length) return res.status(404).json({ ok: false, error: "Agencia nao encontrada." });

    const today = new Date().toISOString().slice(0, 10);
    const dataInicial = fmt(String(req.query.dataInicial || `${today.slice(0, 4)}0101`));
    const dataFinal = fmt(String(req.query.dataFinal || today));

    let inserted = 0, skipped = 0, noCnpj = [];

    for (const agency of agencies) {
      const cnpj = agency.collection_rules?.cnpj;
      // CNPJ ausente OU invalido (digito verificador) -> pula VISIVELMENTE (entra
      // em agencies_without_cnpj) em vez de consultar CNPJ errado e voltar vazio.
      if (!cnpj || !isValidCnpj(cnpj)) { noCnpj.push(agency.acronym); continue; }

      const result = await fetchAllContractsByOrgao(cnpj, dataInicial, dataFinal);
      if (!result.ok) continue;

      for (const c of result.items) {
        if (!c.pncp_id) continue;
        const { data: exists } = await supabase.from("contracts").select("id").eq("pncp_id", c.pncp_id).maybeSingle();
        if (exists) { skipped++; continue; }

        // Resolve/insere a empresa fornecedora por CNPJ.
        let supplier_company_id = null;
        if (c.supplier_cnpj) {
          const { data: comp } = await supabase
            .from("companies")
            .upsert({ cnpj: c.supplier_cnpj, legal_name: c.supplier_name || c.supplier_cnpj }, { onConflict: "cnpj" })
            .select("id")
            .single();
          supplier_company_id = comp?.id || null;
        }

        await supabase.from("contracts").insert({
          agency_id: agency.id,
          supplier_company_id,
          supplier_cnpj: c.supplier_cnpj,
          supplier_name: c.supplier_name,
          object: c.object,
          modality: c.modality,
          value: c.value,
          signed_at: c.signed_at,
          ends_at: c.ends_at,
          pncp_id: c.pncp_id,
          source_url: c.source_url,
          metadata: { raw: c.raw }
        });
        inserted++;

        if (supplier_company_id) {
          await supabase.from("relationships").insert({
            from_kind: "company", from_id: supplier_company_id,
            to_kind: "agency", to_id: agency.id,
            relationship: "reported", confidence_score: 1,
            metadata: { kind: "contract", pncp_id: c.pncp_id, value: c.value }
          });
        }
      }
    }

    return res.status(200).json({ ok: true, inserted, skipped, agencies_without_cnpj: noCnpj });
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message, source: "PNCP" });
  }
};
