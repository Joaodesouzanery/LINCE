// M12 - Monitoramento legislativo (inspirado no NOMOS da Arko Advice).
// Consulta as APIs abertas e gratuitas da Camara dos Deputados e do Senado
// Federal para achar proposicoes por tema/palavra-chave. Sem chave de API.
//
// Padrao do projeto: sempre retorna { ok, ... }, nunca lanca para o caller;
// chamadas multiplas via Promise.allSettled toleram falha de uma das casas.

const CAMARA_BASE = "https://dadosabertos.camara.leg.br/api/v2";
const SENADO_BASE = "https://legis.senado.leg.br/dadosabertos";

// fetch com timeout (evita pendurar a serverless em API lenta).
async function fetchJson(url, { headers = {}, timeoutMs = 8000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { headers: { accept: "application/json", ...headers }, signal: ctrl.signal });
    const body = await resp.json().catch(() => null);
    if (!resp.ok) return { ok: false, status: resp.status, error: `HTTP ${resp.status}`, body };
    return { ok: true, body };
  } catch (e) {
    return { ok: false, error: e.name === "AbortError" ? "timeout" : e.message };
  } finally {
    clearTimeout(t);
  }
}

// --- Camara dos Deputados ---
// https://dadosabertos.camara.leg.br/api/v2/proposicoes?keywords=...&ano=...
async function searchCamara({ q, ano, tipo, limit = 20 } = {}) {
  const params = new URLSearchParams({ ordem: "DESC", ordenarPor: "id", itens: String(Math.min(limit, 100)) });
  if (q) params.set("keywords", q);
  if (ano) params.set("ano", String(ano));
  if (tipo) params.set("siglaTipo", String(tipo).toUpperCase());
  const r = await fetchJson(`${CAMARA_BASE}/proposicoes?${params.toString()}`);
  if (!r.ok) return { ok: false, source: "Camara", error: r.error, items: [] };
  const items = (r.body?.dados || []).map((p) => ({
    id: `camara:${p.id}`,
    casa: "Camara",
    tipo: p.siglaTipo,
    numero: p.numero,
    ano: p.ano,
    ementa: (p.ementa || "").trim(),
    titulo: `${p.siglaTipo} ${p.numero}/${p.ano}`,
    url: `https://www.camara.leg.br/proposicoesWeb/fichadetramitacao?idProposicao=${p.id}`
  }));
  return { ok: true, source: "Camara", items };
}

// --- Senado Federal ---
// https://legis.senado.leg.br/dadosabertos/materia/pesquisa/lista?palavraChave=...
// A API do Senado responde JSON com Accept: application/json (estrutura aninhada
// PesquisaBasicaMateria > Materias > Materia). Parse defensivo.
function asArray(v) { return Array.isArray(v) ? v : v ? [v] : []; }

async function searchSenado({ q, ano, limit = 20 } = {}) {
  const params = new URLSearchParams();
  if (q) params.set("palavraChave", q);
  if (ano) params.set("ano", String(ano));
  const url = `${SENADO_BASE}/materia/pesquisa/lista${params.toString() ? "?" + params.toString() : ""}`;
  const r = await fetchJson(url);
  if (!r.ok) return { ok: false, source: "Senado", error: r.error, items: [] };
  const lista = r.body?.PesquisaBasicaMateria?.Materias?.Materia
    || r.body?.ListaMateria?.Materias?.Materia
    || r.body?.Materias?.Materia
    || [];
  const items = asArray(lista).slice(0, limit).map((m) => {
    // Estrutura plana da pesquisa basica do Senado: Codigo, Sigla, Numero, Ano,
    // Ementa, DescricaoIdentificacao (ex.: "RQS 25/2026"), UrlDetalheMateria.
    const codigo = m.Codigo || "";
    const sigla = m.Sigla || "MAT";
    const numero = String(m.Numero || "").replace(/^0+/, "") || m.Numero || "";
    const anoM = m.Ano || "";
    return {
      id: `senado:${codigo || sigla + numero + anoM}`,
      casa: "Senado",
      tipo: sigla,
      numero,
      ano: anoM,
      ementa: (m.Ementa || "").trim(),
      autor: m.Autor || null,
      titulo: m.DescricaoIdentificacao || `${sigla} ${numero}/${anoM}`,
      url: codigo ? `https://www25.senado.leg.br/web/atividade/materias/-/materia/${codigo}` : null
    };
  });
  return { ok: true, source: "Senado", items };
}

// === M20: parlamentares, autores e situacao (para o dossie de parlamentar) ===

// Lista de deputados FEDERAIS em exercicio (paginado; ~513). id + nome + partido + UF.
async function fetchDeputados() {
  const out = [];
  for (let pagina = 1; pagina <= 12; pagina++) {
    const r = await fetchJson(`${CAMARA_BASE}/deputados?ordem=ASC&ordenarPor=nome&itens=100&pagina=${pagina}`);
    if (!r.ok) return { ok: false, source: "Camara", error: r.error, items: out };
    const dados = r.body?.dados || [];
    for (const d of dados) out.push({ camaraId: d.id, nome: d.nome, partido: d.siglaPartido || null, uf: d.siglaUf || null });
    if (dados.length < 100) break;
  }
  return { ok: true, source: "Camara", items: out };
}

// Detalhe de um deputado: nome CIVIL (melhor p/ casar patrimonio TSE) + partido/UF atuais.
async function fetchDeputadoDetalhe(camaraId) {
  const r = await fetchJson(`${CAMARA_BASE}/deputados/${camaraId}`);
  if (!r.ok) return { ok: false, error: r.error };
  const d = r.body?.dados || {};
  return {
    ok: true,
    nomeCivil: d.nomeCivil || d.ultimoStatus?.nome || null,
    partido: d.ultimoStatus?.siglaPartido || null,
    uf: d.ultimoStatus?.siglaUf || null
  };
}

// Senadores em exercicio. Parse defensivo (estrutura aninhada do Senado).
async function fetchSenadores() {
  const r = await fetchJson(`${SENADO_BASE}/senador/lista/atual`);
  if (!r.ok) return { ok: false, source: "Senado", error: r.error, items: [] };
  const lista = r.body?.ListaParlamentarEmExercicio?.Parlamentares?.Parlamentar || [];
  const items = asArray(lista).map((p) => {
    const ip = p.IdentificacaoParlamentar || {};
    return {
      senadoId: ip.CodigoParlamentar,
      nome: ip.NomeCompletoParlamentar || ip.NomeParlamentar || null,
      partido: ip.SiglaPartidoParlamentar || null,
      uf: ip.UfParlamentar || null
    };
  }).filter((s) => s.senadoId && s.nome);
  return { ok: true, source: "Senado", items };
}

// Autores de uma proposicao da Camara. O id do deputado autor vem no `uri`.
async function fetchAutores(camaraId) {
  const r = await fetchJson(`${CAMARA_BASE}/proposicoes/${camaraId}/autores`);
  if (!r.ok) return { ok: false, error: r.error, items: [] };
  const items = (r.body?.dados || []).map((a, i) => ({
    nome: (a.nome || "").trim(),
    tipo: a.tipo || null,                       // "Deputado(a)" | "Órgão do Poder..." etc.
    ordem: a.ordemAssinatura ?? i + 1,
    camaraId: (a.uri && /\/deputados\/(\d+)/.exec(a.uri)?.[1]) || null
  })).filter((a) => a.nome);
  return { ok: true, items };
}

// Situacao/tramitacao atual de uma proposicao da Camara (1 call).
async function fetchSituacaoCamara(camaraId) {
  const r = await fetchJson(`${CAMARA_BASE}/proposicoes/${camaraId}`);
  if (!r.ok) return { ok: false, error: r.error };
  const d = r.body?.dados || {};
  return {
    ok: true,
    situacao: d.statusProposicao?.descricaoSituacao || d.statusProposicao?.despacho || null,
    dataApresentacao: d.dataApresentacao ? String(d.dataApresentacao).slice(0, 10) : null
  };
}

// Busca combinada nas duas casas. casa = 'camara' | 'senado' | 'both'.
async function searchProposicoes({ q, ano, tipo, casa = "both", limit = 20 } = {}) {
  const jobs = [];
  if (casa === "camara" || casa === "both") jobs.push(searchCamara({ q, ano, tipo, limit }));
  if (casa === "senado" || casa === "both") jobs.push(searchSenado({ q, ano, limit }));
  const settled = await Promise.allSettled(jobs);
  const results = settled.map((s) => (s.status === "fulfilled" ? s.value : { ok: false, error: s.reason?.message, items: [] }));
  const items = results.flatMap((r) => r.items || []);
  const sources = results.map((r) => ({ source: r.source, ok: r.ok, count: (r.items || []).length, error: r.error || null }));
  return { ok: results.some((r) => r.ok), items, sources };
}

module.exports = {
  searchProposicoes, searchCamara, searchSenado,
  fetchDeputados, fetchDeputadoDetalhe, fetchSenadores, fetchAutores, fetchSituacaoCamara
};
