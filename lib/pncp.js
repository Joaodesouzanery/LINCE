// PNCP - Portal Nacional de Contratacoes Publicas (substituto do Compras.gov/SIASG).
// API publica de consulta, sem login. Doc: pncp.gov.br/api/pncp/swagger-ui
const BASE = "https://pncp.gov.br/api/consulta/v1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Lista contratos publicados por um orgao (CNPJ) num intervalo de datas.
// dataInicial/dataFinal no formato AAAAMMDD.
// Resiliente por design (a API do PNCP e instavel): timeout por request, retry
// com backoff em 5xx/429/erro de rede, e 204 (sem contratos) tratado como lista
// vazia — nunca LANCA, sempre retorna { ok, ... } (o caller nao pode morrer por
// um timeout de um orgao).
async function fetchContractsByOrgao(cnpj, dataInicial, dataFinal, { pagina = 1, retries = 3 } = {}) {
  const qs = new URLSearchParams({
    cnpjOrgao: cnpj,
    dataInicial,
    dataFinal,
    pagina: String(pagina)
  }).toString();
  let lastErr = "erro desconhecido";
  for (let attempt = 1; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetch(`${BASE}/contratos?${qs}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(25000)
      });
    } catch (e) {
      lastErr = e?.name === "TimeoutError" ? "timeout" : (e?.message || "fetch falhou");
      if (attempt < retries) await sleep(600 * attempt); // so espera se ainda vai retriar
      continue;
    }
    if (res.status === 204) return { ok: true, items: [], total: 0, pages: 0 }; // sem contratos
    if (!res.ok) {
      lastErr = `HTTP ${res.status}`;
      if (res.status >= 500 || res.status === 429) { if (attempt < retries) await sleep(600 * attempt); continue; }
      return { ok: false, error: lastErr }; // 4xx nao-transiente: nao insiste
    }
    // res.json() LANCA em corpo vazio/nao-JSON (200 com HTML de manutencao, body
    // truncado) ou se o timeout dispara durante o streaming do corpo. Sem este
    // try/catch a excecao subiria e mataria a ingestao inteira — exatamente o que
    // o contrato "nunca LANCA" promete evitar. Tratar como transiente (retria).
    let body;
    try {
      body = await res.json();
    } catch (e) {
      lastErr = e?.name === "TimeoutError" ? "timeout no corpo" : "corpo nao-JSON";
      if (attempt < retries) await sleep(600 * attempt);
      continue;
    }
    return buildResult(body);
  }
  return { ok: false, error: lastErr };
}

function buildResult(body) {
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
    if (!r.ok) {
      // Erro na 1a pagina -> propaga o erro; erro numa pagina > 1 -> devolve o que
      // ja tem, mas marcado partial (dados INCOMPLETOS) para o caller nao achar
      // que pegou tudo.
      if (pagina === 1) return r;
      console.warn(`[pncp] ${cnpj}: erro na pagina ${pagina} (${r.error}) — retornando ${all.length} contratos parciais`);
      return { ok: true, items: all, total: all.length, pages: pagina - 1, partial: true };
    }
    all.push(...r.items);
    pages = r.pages || 1;
    pagina++;
  } while (pagina <= pages && pagina <= maxPages);
  const truncated = pages > maxPages;
  if (truncated) console.warn(`[pncp] ${cnpj}: ${pages} paginas > teto ${maxPages} — contratos alem da pagina ${maxPages} NAO ingeridos`);
  return { ok: true, items: all, total: all.length, pages: Math.min(pages, maxPages), partial: truncated };
}

module.exports = { fetchContractsByOrgao, fetchAllContractsByOrgao };
