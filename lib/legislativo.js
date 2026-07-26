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

// === M20.2: votacao nominal (Camara rica; Senado best-effort) ===

// Votacoes de uma proposicao da Camara (basics: id, data, descricao, aprovacao).
async function fetchVotacoesDaProposicao(camaraId) {
  const r = await fetchJson(`${CAMARA_BASE}/proposicoes/${camaraId}/votacoes?ordem=DESC&ordenarPor=dataHoraRegistro`);
  if (!r.ok) return { ok: false, error: r.error, items: [] };
  const items = (r.body?.dados || []).map((v) => ({
    votacaoId: v.id,
    data: v.data ? String(v.data).slice(0, 10) : (v.dataHoraRegistro ? String(v.dataHoraRegistro).slice(0, 10) : null),
    descricao: v.descricao || null,
    // aprovacao: 1 = aprovado, 0 = rejeitado (quando ha placar). null quando simbolica.
    resultado: v.aprovacao === 1 ? "Aprovado" : (v.aprovacao === 0 ? "Rejeitado" : null),
    siglaOrgao: v.siglaOrgao || null
  }));
  return { ok: true, items };
}

// Votos NOMINAIS de uma votacao da Camara (por deputado).
async function fetchVotosNominais(votacaoId) {
  const r = await fetchJson(`${CAMARA_BASE}/votacoes/${encodeURIComponent(votacaoId)}/votos`);
  if (!r.ok) return { ok: false, error: r.error, items: [] };
  const items = (r.body?.dados || []).map((v) => {
    const d = v.deputado_ || {};
    return {
      camaraId: d.id != null ? String(d.id) : null,
      nome: d.nome || null,
      partido: d.siglaPartido || null,
      uf: d.siglaUf || null,
      voto: v.tipoVoto || null            // "Sim" | "Não" | "Abstenção" | "Obstrução" | "Art. 17"
    };
  }).filter((v) => v.nome);
  return { ok: true, items };
}

// Orientacao de bancada de uma votacao (p/ calcular fidelidade partidaria).
// A `siglaPartidoBloco` pode ser um PARTIDO ("PL"), uma FEDERACAO/BLOCO
// ("PT/PCdoB/PV", "PSDB/CIDADANIA") ou rotulo generico ("Maioria"). Mapeia CADA
// sigla do bloco -> orientacao, p/ casar a sigla INDIVIDUAL do deputado (senao, na
// legislatura atual em que as orientacoes vem por BLOCO, casaria quase nada e a
// fidelidade ficaria inocua).
async function fetchOrientacoes(votacaoId) {
  const r = await fetchJson(`${CAMARA_BASE}/votacoes/${encodeURIComponent(votacaoId)}/orientacoes`);
  if (!r.ok) return { ok: false, error: r.error, map: {} };
  const map = {};
  for (const o of r.body?.dados || []) {
    const orientacao = o.orientacaoVoto || null; // "Sim"|"Não"|"Liberado"|"Obstrução"
    if (!orientacao) continue;
    const tokens = String(o.siglaPartidoBloco || "").toUpperCase().split(/[^A-Z0-9]+/).filter((t) => t.length >= 2);
    for (const t of tokens) if (!(t in map)) map[t] = orientacao; // rotulos genericos nao casam sigla, inofensivos
  }
  return { ok: true, map };
}

// === M21 (stakeholder "sem erros"): comissoes/orgaos + discursos ===

// Limpa HTML -> texto puro: remove tags, decodifica entidades (numericas/hex +
// nomeadas comuns, incl. acentos PT-BR) e colapsa espacos. Numericas primeiro;
// &amp; por ultimo p/ nao re-decodificar. Entidade nomeada desconhecida fica intacta.
const HTML_ENTITIES = {
  nbsp: " ", lt: "<", gt: ">", quot: '"', apos: "'",
  ccedil: "ç", Ccedil: "Ç", atilde: "ã", Atilde: "Ã", otilde: "õ", Otilde: "Õ",
  aacute: "á", Aacute: "Á", eacute: "é", Eacute: "É", iacute: "í", Iacute: "Í",
  oacute: "ó", Oacute: "Ó", uacute: "ú", Uacute: "Ú",
  acirc: "â", Acirc: "Â", ecirc: "ê", Ecirc: "Ê", ocirc: "ô", Ocirc: "Ô",
  agrave: "à", Agrave: "À", uuml: "ü", Uuml: "Ü", ordm: "º", ordf: "ª"
};
function cleanHtmlText(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => { const c = Number(n); return c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : ""; })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { const c = parseInt(h, 16); return c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : ""; })
    .replace(/&([a-zA-Z]+);/g, (m, name) => (name in HTML_ENTITIES ? HTML_ENTITIES[name] : m))
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// Orgaos/comissoes de um deputado (Camara). titulo = cargo ("Titular"/"Presidente"…).
// fim=null (ou futuro) => vinculo ATUAL. Ordena por inicio desc.
async function fetchOrgaosDeputado(camaraId) {
  const r = await fetchJson(`${CAMARA_BASE}/deputados/${encodeURIComponent(camaraId)}/orgaos?itens=100&ordem=DESC&ordenarPor=dataInicio`);
  if (!r.ok) return { ok: false, error: r.error, items: [] };
  // 200-mas-corpo-invalido (JSON nao parseou -> body null) vira ok:false p/ o coletor
  // NAO apagar comissoes boas achando que o deputado ficou sem orgaos.
  if (!r.body || !Array.isArray(r.body.dados)) return { ok: false, error: "resposta sem dados (corpo invalido)", items: [] };
  const items = r.body.dados.map((o) => ({
    externalOrgId: o.idOrgao != null ? String(o.idOrgao) : null,
    sigla: o.siglaOrgao || null,
    nome: o.nomeOrgao || o.nomePublicacao || null,
    cargo: o.titulo || null,
    inicio: o.dataInicio || null,
    fim: o.dataFim || null
  })).filter((o) => o.sigla || o.nome);
  return { ok: true, items };
}

// Ultimos discursos de um deputado (Camara), best-effort (display-only, sem tabela).
// A API SO retorna com janela de datas (sem dataInicio/dataFim volta vazio) — por isso
// aplica uma janela padrao dos ultimos ~`meses`. timeoutMs curto: o dossie faz esta
// chamada on-the-fly e nao pode pendurar no maxDuration.
async function fetchDiscursos(camaraId, { itens = 8, meses = 18, timeoutMs = 4000 } = {}) {
  const fim = new Date();
  const inicio = new Date(fim.getTime() - meses * 30 * 24 * 3600 * 1000);
  const fmt = (dt) => dt.toISOString().slice(0, 10);
  const r = await fetchJson(`${CAMARA_BASE}/deputados/${encodeURIComponent(camaraId)}/discursos?dataInicio=${fmt(inicio)}&dataFim=${fmt(fim)}&ordem=DESC&ordenarPor=dataHoraInicio&itens=${itens}`, { timeoutMs });
  if (!r.ok) return { ok: false, error: r.error, items: [] };
  const items = (r.body?.dados || []).map((s) => ({
    data: s.dataHoraInicio || null,
    tipo: s.tipoDiscurso || s.faseEvento?.titulo || null,
    sumario: cleanHtmlText(s.sumario || s.transcricao || "").slice(0, 400) || null,
    url: s.urlTexto || null
  })).filter((s) => s.data || s.sumario);
  return { ok: true, items };
}

// === M21 (Painel): import por lista — parse tolerante + resolve por numero/ano ===

const PROP_TIPOS = ["PEC", "PLP", "PLV", "PLC", "PLS", "PDL", "PDC", "PRC", "MPV", "MP", "REQ", "RQS", "RIC", "INC", "PL"];
// Parse de refs coladas: "PEC 42/2024, PL 11/2025" -> [{tipo,numero,ano}]. PL por
// ULTIMO na lista de tipos p/ nao capturar o "PL" dentro de "PLP"/"PLV" antes da hora.
function parseProposicaoRefs(texto) {
  const re = new RegExp(`\\b(${PROP_TIPOS.join("|")})\\s*n?º?\\.?\\s*(\\d{1,6})\\s*[\\/\\-]\\s*(\\d{4})`, "gi");
  const out = []; const seen = new Set();
  let m;
  while ((m = re.exec(String(texto || "")))) {
    const tipo = m[1].toUpperCase(), numero = m[2], ano = m[3];
    const key = `${tipo} ${numero}/${ano}`;
    if (!seen.has(key)) { seen.add(key); out.push({ tipo, numero, ano: Number(ano) }); }
  }
  return out;
}

// Resolve uma ref {tipo,numero,ano} -> candidatos (Camara + Senado). NAO persiste.
// Camara /proposicoes aceita siglaTipo+numero+ano (a busca hoje so usa keyword).
async function resolveProposicaoRef({ tipo, numero, ano }) {
  const jobs = [
    (async () => {
      const params = new URLSearchParams({ siglaTipo: String(tipo).toUpperCase(), numero: String(numero), ano: String(ano), itens: "5" });
      const r = await fetchJson(`${CAMARA_BASE}/proposicoes?${params.toString()}`);
      if (!r.ok) return [];
      return (r.body?.dados || []).map((p) => ({
        id: `camara:${p.id}`, casa: "Camara", tipo: p.siglaTipo, numero: p.numero, ano: p.ano,
        ementa: (p.ementa || "").trim(), titulo: `${p.siglaTipo} ${p.numero}/${p.ano}`,
        url: `https://www.camara.leg.br/proposicoesWeb/fichadetramitacao?idProposicao=${p.id}`
      }));
    })(),
    (async () => {
      // Senado: filtra por numero+ano E tipo (a pesquisa por palavraChave e frouxa;
      // sem o guard de tipo, "PL 11/2025" casaria um "RQS 11/2025" homonimo).
      const r = await searchSenado({ q: `${tipo} ${numero}/${ano}`, ano, limit: 8 });
      return r.ok ? r.items.filter((it) =>
        String(it.numero) === String(numero) && String(it.ano) === String(ano) &&
        String(it.tipo || "").toUpperCase() === String(tipo).toUpperCase()) : [];
    })()
  ];
  const settled = await Promise.allSettled(jobs);
  return settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
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
  fetchDeputados, fetchDeputadoDetalhe, fetchSenadores, fetchAutores, fetchSituacaoCamara,
  fetchVotacoesDaProposicao, fetchVotosNominais, fetchOrientacoes,
  parseProposicaoRefs, resolveProposicaoRef,
  fetchOrgaosDeputado, fetchDiscursos
};
