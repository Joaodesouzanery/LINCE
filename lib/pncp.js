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

// Itera TODAS as paginas de contratos do orgao (o ingestor antigo so pegava a
// pagina 1 -> perdia contratos alem da primeira pagina). Teto de paginas para
// nao rodar sem limite. Erro na pagina 1 propaga; erro em pagina seguinte para
// (retorna o que ja coletou).
async function fetchAllContractsByOrgao(cnpj, dataInicial, dataFinal, { maxPages = 20 } = {}) {
  const all = [];
  let pagina = 1, pages = 1;
  do {
    const r = await fetchContractsByOrgao(cnpj, dataInicial, dataFinal, { pagina });
    if (!r.ok) return pagina === 1 ? r : { ok: true, items: all, total: all.length, pages: pagina - 1 };
    all.push(...r.items);
    pages = r.pages || 1;
    pagina++;
  } while (pagina <= pages && pagina <= maxPages);
  return { ok: true, items: all, total: all.length, pages: Math.min(pages, maxPages) };
}

module.exports = { fetchContractsByOrgao, fetchAllContractsByOrgao };
