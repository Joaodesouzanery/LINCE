// M14 - Dossie de Contraparte (base do entregavel de due diligence "estilo
// Sherlocker"). Compoe, para um CNPJ: cadastro + rede societaria (QSA
// persistido) + screening PEP/sancoes + sinais de risco. So a composicao de
// dados; a tela/export vem na Fase 2 (Gerador de Dossie).
//
// Padrao do projeto: retorna { ok, ... }, nunca lanca; LGPD (nao expoe CPF).
const { getSupabase } = require("./supabase");
const { onlyDigits, isSituacaoAtiva } = require("./text");
const { screeningByCnpj } = require("./transparencia");

// Compoe o dossie de contraparte a partir do que ja esta no banco + screening
// ao vivo. Requer que o CNPJ ja tenha sido investigado/persistido (api/cnpj.js
// ?persist=1) ou carregado via backfill:qsa para ter rede societaria.
async function composeCounterparty(cnpjRaw) {
  try {
    const cnpj = onlyDigits(cnpjRaw);
    if (cnpj.length !== 14) return { ok: false, error: "CNPJ invalido (14 digitos)." };
    const supabase = getSupabase();

    // 1) Empresa (cadastro + shareholding do QSA).
    const { data: company, error: compErr } = await supabase
      .from("companies")
      .select("id, cnpj, legal_name, trade_name, cnae, registration_status, size_label, shareholding")
      .eq("cnpj", cnpj)
      .maybeSingle();
    // Distingue FALHA de consulta de "nao encontrado" (num dossie de DD, dizer
    // "empresa fora da base" quando a query caiu seria enganoso).
    if (compErr) return { ok: false, error: `Falha ao consultar empresa: ${compErr.message}` };

    // 2) Rede societaria: arestas 'socio' que apontam para esta empresa.
    let socios = [];
    if (company?.id) {
      const { data: rels } = await supabase
        .from("relationships")
        .select("from_kind, from_id, metadata")
        .eq("to_kind", "company").eq("to_id", company.id).eq("relationship", "socio");
      const personIds = (rels || []).filter((r) => r.from_kind === "person").map((r) => r.from_id);
      const companyIds = (rels || []).filter((r) => r.from_kind === "company").map((r) => r.from_id);
      const [people, comps] = await Promise.all([
        personIds.length ? supabase.from("people").select("id, full_name").in("id", personIds) : Promise.resolve({ data: [] }),
        companyIds.length ? supabase.from("companies").select("id, cnpj, legal_name, registration_status").in("id", companyIds) : Promise.resolve({ data: [] })
      ]);
      const pById = Object.fromEntries((people.data || []).map((p) => [p.id, p]));
      const cById = Object.fromEntries((comps.data || []).map((c) => [c.id, c]));
      socios = (rels || []).map((r) => {
        const isPerson = r.from_kind === "person";
        const node = isPerson ? pById[r.from_id] : cById[r.from_id];
        return {
          tipo: isPerson ? "PF" : "PJ",
          nome: isPerson ? (node?.full_name || "?") : (node?.legal_name || node?.cnpj || "?"),
          cnpj: isPerson ? null : node?.cnpj || null,
          situacao: isPerson ? null : node?.registration_status || null,
          papel: r.metadata?.role || null
        };
      });
    }

    // 2b) F-INT1 (F3): contratos PUBLICOS da contraparte — por company_id quando na
    // base, senao por supplier_cnpj (contratos do PNCP chegam antes do cadastro local).
    let contracts = [], contractsSummary = { count: 0, total_value: 0, agencies: [] };
    {
      let q = supabase.from("contracts")
        .select("object, value, signed_at, ends_at, agencies(acronym)")
        .order("signed_at", { ascending: false, nullsFirst: false }).limit(200);
      q = company?.id ? q.or(`supplier_company_id.eq.${company.id},supplier_cnpj.eq.${cnpj}`) : q.eq("supplier_cnpj", cnpj);
      const { data: cts } = await q;
      contracts = (cts || []).map((c) => ({
        object: c.object, value: c.value, signed_at: c.signed_at, ends_at: c.ends_at,
        agency: c.agencies?.acronym || null
      }));
      contractsSummary = {
        count: contracts.length,
        total_value: contracts.reduce((s, c) => s + (Number(c.value) || 0), 0),
        agencies: [...new Set(contracts.map((c) => c.agency).filter(Boolean))],
        truncated: contracts.length >= 200
      };
      contracts = contracts.slice(0, 20);
    }

    // 3) Screening PEP/sancoes (Portal da Transparencia). Degrada sem chave.
    const screening = await screeningByCnpj(cnpj).catch((e) => ({ ok: false, error: e.message }));

    // 4) Sinais de risco rastreaveis.
    const flags = [];
    if (company?.registration_status && !isSituacaoAtiva(company.registration_status)) {
      flags.push({ severity: "high", flag: `Empresa em situacao "${company.registration_status}"` });
    }
    const inaptasSocias = socios.filter((s) => s.tipo === "PJ" && s.situacao && !isSituacaoAtiva(s.situacao));
    if (inaptasSocias.length) flags.push({ severity: "medium", flag: `${inaptasSocias.length} socia(s) PJ inapta(s)/baixada(s)` });
    // screening.flags e um OBJETO { is_pep, has_sanctions, is_servidor }.
    const scr = (screening && screening.flags) || {};
    if (scr.has_sanctions) flags.push({ severity: "high", flag: "Consta em lista(s) de sancao (CEIS/CNEP/CEPIM)" });
    if (scr.is_pep) flags.push({ severity: "medium", flag: "Vinculo com Pessoa Exposta Politicamente (PEP)" });
    if (contractsSummary.count) flags.push({ severity: "info", flag: `Fornecedor publico: ${contractsSummary.count} contrato(s) com ${contractsSummary.agencies.join(", ") || "agencias"}` });
    if (!company) flags.push({ severity: "info", flag: "Empresa fora da base local — investigue o CNPJ (persist=1) ou rode backfill:qsa." });

    return {
      ok: true,
      cnpj,
      company: company || null,
      socios,
      socios_count: socios.length,
      contracts,
      contracts_summary: contractsSummary,
      screening: screening?.flags ? { flags: screening.flags, sources: screening.sources } : { status: screening?.status || "unavailable" },
      flags
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

module.exports = { composeCounterparty };
