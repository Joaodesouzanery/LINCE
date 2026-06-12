// PNCP - Portal Nacional de Contratacoes Publicas (substituto do Compras.gov/SIASG).
// API publica de consulta, sem login. Doc: pncp.gov.br/api/pncp/swagger-ui
const BASE = "https://pncp.gov.br/api/consulta/v1";

// Lista contratos publicados por um orgao (CNPJ) num intervalo de datas.
// dataInicial/dataFinal no formato AAAAMMDD.
async function fetchContractsByOrgao(cnpj, dataInicial, dataFinal, { pagina = 1 } = {}) {
  const qs = new URLSearchParams({
    cnpjOrgao: cnpj,
    dataInicial,
    dataFinal,
    pagina: String(pagina)
  }).toString();
  const res = await fetch(`${BASE}/contratos?${qs}`, { headers: { accept: "application/json" } });
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  const body = await res.json();
  const items = (body?.data || []).map((c) => ({
    pncp_id: c?.numeroControlePNCP || `${c?.orgaoEntidade?.cnpj}-${c?.numeroContratoEmpenho}`,
    supplier_cnpj: c?.niFornecedor || null,
    supplier_name: c?.nomeRazaoSocialFornecedor || null,
    object: c?.objetoContrato || null,
    modality: c?.modalidadeNome || null,
    value: Number(c?.valorGlobal || c?.valorInicial || 0) || null,
    signed_at: c?.dataAssinatura || null,
    ends_at: c?.dataVigenciaFim || null,
    source_url: c?.numeroControlePNCP ? `https://pncp.gov.br/app/contratos/${c.numeroControlePNCP}` : null,
    raw: c
  }));
  return { ok: true, items, total: body?.totalRegistros, pages: body?.totalPaginas };
}

module.exports = { fetchContractsByOrgao };
