const sourceStatus = [
  {
    id: "cnpj",
    name: "CNPJ.ws",
    data: "Informacoes basicas, CNAEs, socios, enderecos, telefones e emails",
    method: "/api/cnpj -> publica.cnpj.ws",
    status: "connected",
    help: "Conectado para consulta sob demanda. Limite publico: 3 req/min."
  },
  {
    id: "rdap",
    name: "Registro.br RDAP",
    data: "Dominios .br vinculados ao CNPJ quando a entidade existir no RDAP",
    method: "/api/rdap -> rdap.registro.br",
    status: "connected",
    help: "Conectado sem chave. Retorno depende de disponibilidade no RDAP."
  },
  {
    id: "news",
    name: "Google News RSS",
    data: "Noticias recentes por consulta de razao social ou nome fantasia",
    method: "/api/news -> news.google.com/rss",
    status: "connected",
    help: "Conectado via RSS publico para triagem inicial."
  },
  {
    id: "datajud",
    name: "CNJ DataJud",
    data: "Metadados de processos judiciais",
    method: "/api/external?type=datajud",
    status: "key",
    help: "Endpoint preparado. Requer DATAJUD_API_KEY no ambiente da Vercel."
  },
  {
    id: "transparency",
    name: "Portal da Transparencia",
    data: "Contratos, pagamentos, servidores e sancoes",
    method: "/api/external?type=transparency",
    status: "key",
    help: "Endpoint preparado. Requer PORTAL_TRANSPARENCIA_API_KEY."
  },
  {
    id: "screening",
    name: "Screening PEP/Sancoes",
    data: "PEP, CEIS, CNEP, CEPIM, CEAF e vinculo de servidor",
    method: "/api/external?type=screening",
    status: "key",
    help: "Endpoint preparado. Requer PORTAL_TRANSPARENCIA_API_KEY."
  },
  {
    id: "pgfn",
    name: "PGFN Divida Ativa",
    data: "Divida ativa da Uniao e FGTS",
    method: "Dump trimestral -> Supabase",
    status: "pending",
    help: "Precisa ingestao do arquivo aberto trimestral. Nao ha consulta ficticia."
  },
  {
    id: "regulatory",
    name: "ANEEL / ARTESP / DOU",
    data: "Deliberacoes, votos, atas, pautas e atos oficiais",
    method: "Scrapers + ingestao documental",
    status: "pending",
    help: "Proxima fase. Requer pipeline de PDFs, OCR/extracao e normalizacao."
  }
];

const dossierTabs = [
  ["basic", "Informacoes Basicas"],
  ["cnaes", "CNAEs"],
  ["partners", "Socios"],
  ["movements", "Movimentacoes"],
  ["addresses", "Enderecos"],
  ["phones", "Telefones"],
  ["emails", "Emails"],
  ["social", "Redes Sociais"],
  ["documents", "Documentos"],
  ["processes", "Processos"],
  ["debts", "Dividas"],
  ["publicPayments", "Recebimentos Publicos"],
  ["patrimony", "Patrimonio"],
  ["irregularities", "Irregularidades e Alertas"],
  ["alerts", "Alertas"],
  ["domains", "Dominios"],
  ["news", "Noticias / RSS"],
  ["regulatoryHistory", "Historico Regulatorio"],
  ["decisionPattern", "Padrao Decisorio"]
];

const state = {
  activeView: "overview",
  activeDossierTab: "basic",
  selectedNodeId: null,
  target: null,
  graphNodes: [],
  graphEdges: [],
  dossier: {},
  news: [],
  screening: null,
  holdings: [],
  sources: {},
  graphView: null,
  transform: { x: 80, y: 60, scale: 1 },
  drag: null,
  pan: null,
  gerador: { themesLoaded: false, dossier: null, narrative: null }
};

// Sessao de autenticacao (Supabase Auth). _sb = client; _accessToken = JWT atual.
// Preenchidos por bootstrap() antes do app subir; injetados em requestJson/postJson.
let _sb = null;
let _accessToken = null;

const $ = (selector) => document.querySelector(selector);

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ════════════════════════ Grafo de vínculos (Cytoscape.js) ════════════════════
// Controlador único compartilhado pelos dois grafos (Investigar CNPJ e Grafo
// Nacional). Carrega via CDN (script no index.html). Estilo por tipo de nó e por
// tipo/forca de vínculo, legenda interativa (= filtro), busca, fit e expansão.
// Hexes literais sincronizados com os tokens do styles.css (Cytoscape não
// resolve var(--x) em estilos de nó/aresta — manter os dois lados alinhados).
const NODE_TYPE_META = {
  company:      { color: "#2d72d2", label: "Empresa" },
  agency:       { color: "#9881f3", label: "Agência" },
  person:       { color: "#32a467", label: "Pessoa" },
  partner:      { color: "#32a467", label: "Sócio" },
  contact:      { color: "#48a4dc", label: "Contato" },
  domain:       { color: "#ecaa3b", label: "Domínio" },
  news:         { color: "#d5605c", label: "Notícia" },
  party:        { color: "#d2699e", label: "Partido" },
  deliberation: { color: "#2ea89d", label: "Deliberação" },
  process:      { color: "#c78a3b", label: "Processo" },
  contract:     { color: "#b0b352", label: "Contrato" }
};
const nodeColor = (t) => (NODE_TYPE_META[t] || { color: "#6b757d" }).color;
const nodeTypeLabel = (t) => (NODE_TYPE_META[t] || { label: t }).label;

const REL_META = {
  socio: { color: "#2d72d2", style: "solid" }, Socio: { color: "#2d72d2", style: "solid" },
  owns: { color: "#2d72d2", style: "solid" },
  mandato: { color: "#32a467", style: "solid" }, employs: { color: "#32a467", style: "solid" },
  Contato: { color: "#48a4dc", style: "dashed" }, Dominio: { color: "#ecaa3b", style: "dashed" },
  "Citado em noticia": { color: "#d5605c", style: "dotted" },
  filiacao: { color: "#d2699e", style: "solid" }, doacao: { color: "#d2699e", style: "dashed" },
  reported: { color: "#b0b352", style: "solid" }, Contrato: { color: "#b0b352", style: "solid" },
  Processo: { color: "#c78a3b", style: "solid" },
  relatou: { color: "#2ea89d", style: "solid" }, votou: { color: "#2ea89d", style: "dashed" },
  delibera: { color: "#2ea89d", style: "solid" }, afeta: { color: "#2ea89d", style: "dotted" },
  // Papeis societarios (estilo Sherlocker): rotulo + cor por papel.
  "Sócio": { color: "#2d72d2", style: "solid" },
  "Administrador": { color: "#32a467", style: "solid" },
  "Direção": { color: "#9881f3", style: "solid" }
};
const relColor = (r) => (REL_META[r] || { color: "#4a545c" }).color;
const relStyle = (r) => (REL_META[r] || { style: "solid" }).style;

// Classifica a qualificacao do QSA num papel curto p/ rotular a aresta e a legenda.
function socioRoleBucket(qualification) {
  const q = (qualification || "").toLowerCase();
  if (/administrador/.test(q)) return "Administrador";
  if (/presiden|diretor|conselheir/.test(q)) return "Direção";
  return "Sócio";
}

let CY_LAYOUT = "cose";
(function registerCyLayout() {
  try {
    if (window.cytoscape && window.cytoscapeFcose) { window.cytoscape.use(window.cytoscapeFcose); CY_LAYOUT = "fcose"; }
  } catch { /* fallback p/ 'cose' embutido */ }
})();

const CY_STYLE = [
  { selector: "node", style: {
    "background-color": "data(color)", "label": "data(label)", "color": "#e8eaed",
    "font-family": "IBM Plex Sans, Inter, sans-serif",
    "font-size": 11, "font-weight": 600, "text-wrap": "ellipsis", "text-max-width": 140,
    "text-valign": "center", "text-halign": "right", "text-margin-x": 6,
    "width": "data(size)", "height": "data(size)", "border-width": 2, "border-color": "#10151a", "shape": "ellipse"
  } },
  { selector: "node.central", style: { "border-color": "#e8eaed", "border-width": 3, "font-size": 12, "font-weight": 800 } },
  { selector: "node.alerted", style: { "border-color": "#d5605c", "border-width": 3 } },
  { selector: "node:selected", style: { "border-color": "#b0b352", "border-width": 4 } },
  { selector: "node.dim", style: { "opacity": 0.12 } },
  { selector: "node.hidden", style: { "display": "none" } },
  { selector: "node.highlight", style: { "border-color": "#b0b352", "border-width": 4 } },
  { selector: "edge", style: {
    "width": "data(w)", "line-color": "data(lineColor)", "line-style": "data(lineStyle)", "opacity": "data(op)",
    "curve-style": "bezier", "target-arrow-shape": "triangle", "target-arrow-color": "data(lineColor)", "arrow-scale": 0.7
  } },
  { selector: "edge.dim", style: { "opacity": 0.05 } },
  { selector: "edge.hidden", style: { "display": "none" } }
];

// Tooltip único reaproveitado por todos os grafos.
let _graphTip = null;
function graphTip() {
  if (!_graphTip) { _graphTip = document.createElement("div"); _graphTip.className = "graph-tip"; _graphTip.style.display = "none"; document.body.appendChild(_graphTip); }
  return _graphTip;
}
function hideGraphTip() { if (_graphTip) _graphTip.style.display = "none"; }

function cyElements(nodes, edges) {
  const ids = new Set(nodes.map((n) => n.id));
  const els = [];
  for (const n of nodes) {
    const cls = [n.central ? "central" : "", n.alert ? "alerted" : ""].filter(Boolean).join(" ");
    els.push({ data: { id: n.id, label: n.title || n.id, sub: n.subtitle || "", type: n.type, color: nodeColor(n.type), size: n.central ? 30 : 20 }, classes: cls });
  }
  const seen = new Set();
  for (const e of edges) {
    const from = e.from ?? e[0], to = e.to ?? e[1], rel = e.relationship ?? e[2] ?? "";
    const weight = e.weight ?? e[3] ?? null;
    if (!ids.has(from) || !ids.has(to)) continue;
    const id = `e:${from}->${to}:${rel}`;
    if (seen.has(id)) continue; seen.add(id);
    const cw = weight == null ? null : Math.max(0, Math.min(1, Number(weight)));
    els.push({ data: { id, source: from, target: to, rel, weight,
      w: cw == null ? 2 : 1.5 + cw * 3.5, op: cw == null ? 0.85 : 0.45 + cw * 0.55,
      lineColor: relColor(rel), lineStyle: relStyle(rel) } });
  }
  return els;
}

// Cria um controlador de grafo ligado a um container. Retorna metodos imperativos.
function createGraphView({ container, legendEl, onSelect, onExpand }) {
  let cy = null;
  const disabledTypes = new Set();
  const disabledRels = new Set();

  function ensure() {
    if (cy || !container || !window.cytoscape) return cy;
    cy = window.cytoscape({ container, elements: [], style: CY_STYLE, layout: { name: "preset" }, minZoom: 0.15, maxZoom: 3, wheelSensitivity: 0.25 });
    cy.on("tap", "node", (evt) => onSelect && onSelect(evt.target.id()));
    if (onExpand) cy.on("dbltap", "node", (evt) => onExpand(evt.target.id()));
    cy.on("mouseover", "node", (evt) => {
      const d = evt.target.data(), el = graphTip();
      el.innerHTML = `<strong>${escapeHtml(d.label || "")}</strong><span>${escapeHtml(nodeTypeLabel(d.type))}${d.sub ? " · " + escapeHtml(d.sub) : ""}</span>`;
      positionTip(evt);
    });
    cy.on("mouseover", "edge", (evt) => {
      const d = evt.target.data(), el = graphTip();
      const conf = d.weight == null ? "" : ` · confiança ~${Math.round(Math.max(0, Math.min(1, d.weight)) * 100)}%`;
      el.innerHTML = `<strong>${escapeHtml(d.rel || "vínculo")}</strong><span>${conf}</span>`;
      positionTip(evt);
    });
    cy.on("mouseout", hideGraphTip);
    cy.on("pan zoom drag", hideGraphTip);
    return cy;
  }
  function positionTip(evt) {
    const el = graphTip(), rect = container.getBoundingClientRect(), p = evt.renderedPosition || { x: 0, y: 0 };
    el.style.left = (rect.left + p.x + 14) + "px"; el.style.top = (rect.top + p.y + 6) + "px"; el.style.display = "block";
  }
  function runLayout() {
    if (!cy || cy.elements().length === 0) return;
    const opts = { name: CY_LAYOUT, animate: false, fit: true, padding: 36 };
    if (CY_LAYOUT === "fcose") Object.assign(opts, { quality: "default", nodeRepulsion: 9000, idealEdgeLength: 130, nodeSeparation: 90, randomize: true });
    else Object.assign(opts, { nodeRepulsion: 9000, idealEdgeLength: 130 });
    cy.layout(opts).run();
  }
  function applyFilters() {
    if (!cy) return;
    cy.batch(() => {
      cy.nodes().forEach((n) => n.toggleClass("hidden", disabledTypes.has(n.data("type"))));
      cy.edges().forEach((e) => e.toggleClass("hidden", disabledRels.has(e.data("rel")) || e.source().hasClass("hidden") || e.target().hasClass("hidden")));
    });
  }
  function renderLegend() {
    if (!legendEl || !cy) return;
    const types = [...new Set(cy.nodes().map((n) => n.data("type")))];
    const rels = [...new Set(cy.edges().map((e) => e.data("rel")).filter(Boolean))].sort();
    legendEl.innerHTML =
      `<div class="legend-group"><span class="legend-h">Tipos</span>${types.map((t) =>
        `<button type="button" class="legend-chip${disabledTypes.has(t) ? " off" : ""}" data-tfilter="${escapeHtml(t)}"><i style="background:${nodeColor(t)}"></i>${escapeHtml(nodeTypeLabel(t))}</button>`).join("")}</div>` +
      (rels.length ? `<div class="legend-group"><span class="legend-h">Vínculos</span>${rels.map((r) =>
        `<button type="button" class="legend-chip${disabledRels.has(r) ? " off" : ""}" data-rfilter="${escapeHtml(r)}"><i style="background:${relColor(r)}"></i>${escapeHtml(r)}</button>`).join("")}</div>` : "");
  }
  if (legendEl) legendEl.addEventListener("click", (ev) => {
    const t = ev.target.closest("[data-tfilter]"), r = ev.target.closest("[data-rfilter]");
    if (t) { const v = t.dataset.tfilter; disabledTypes.has(v) ? disabledTypes.delete(v) : disabledTypes.add(v); }
    if (r) { const v = r.dataset.rfilter; disabledRels.has(v) ? disabledRels.delete(v) : disabledRels.add(v); }
    if (t || r) { applyFilters(); renderLegend(); }
  });

  return {
    cy: () => cy,
    setElements(nodes, edges) {
      if (!ensure()) return;
      cy.elements().remove();
      cy.add(cyElements(nodes, edges));
      cy.resize();
      runLayout();
      applyFilters();
      renderLegend();
    },
    fit() { if (cy) cy.animate({ fit: { padding: 36 } }, { duration: 250 }); },
    zoomBy(f) { if (cy) cy.zoom({ level: cy.zoom() * f, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } }); },
    reset() { if (!cy) return; disabledTypes.clear(); disabledRels.clear(); cy.elements().removeClass("hidden dim highlight"); runLayout(); renderLegend(); },
    select(id) { if (!cy) return; cy.$(":selected").unselect(); const el = cy.getElementById(id); if (el && el.length) el.select(); },
    search(term) {
      if (!cy) return;
      const t = (term || "").trim().toLowerCase();
      cy.nodes().removeClass("highlight dim");
      if (!t) return;
      const matches = cy.nodes().filter((n) => (n.data("label") || "").toLowerCase().includes(t) || (n.data("sub") || "").toLowerCase().includes(t));
      if (!matches.length) return;
      cy.nodes().addClass("dim"); matches.removeClass("dim").addClass("highlight");
      cy.animate({ fit: { eles: matches, padding: 90 } }, { duration: 300 });
    }
  };
}

const realDataProvider = {
  async fetchCnpj(cnpj) {
    // persist=1: grava o QSA (sócios) no grafo de vínculos ao investigar.
    return requestJson(`/api/cnpj?cnpj=${onlyDigits(cnpj)}&persist=1`);
  },
  async fetchDomains(cnpj) {
    return requestJson(`/api/rdap?cnpj=${onlyDigits(cnpj)}`);
  },
  async fetchNews(query) {
    return requestJson(`/api/news?q=${encodeURIComponent(query)}`);
  },
  async fetchProcesses(nameOrCnpj) {
    return requestJson(`/api/external?type=datajud&q=${encodeURIComponent(nameOrCnpj)}`);
  },
  async fetchTransparency(cnpj) {
    return requestJson(`/api/external?type=transparency&cnpj=${onlyDigits(cnpj)}`);
  }
};

async function requestJson(url) {
  const headers = _accessToken ? { Authorization: `Bearer ${_accessToken}` } : {};
  const response = await fetch(url, { headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) handleAuthLost(response.status);
    const message = payload.error || payload.message || `Falha HTTP ${response.status}`;
    throw Object.assign(new Error(message), { status: response.status, payload });
  }
  return payload;
}

// Mutacoes (monitores, resumo IA) vao por POST com body JSON.
async function postJson(url, body) {
  const headers = { "Content-Type": "application/json" };
  if (_accessToken) headers.Authorization = `Bearer ${_accessToken}`;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body || {})
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) handleAuthLost(response.status);
    const message = payload.error || payload.message || `Falha HTTP ${response.status}`;
    throw Object.assign(new Error(message), { status: response.status, payload });
  }
  return payload;
}

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function formatCnpj(value) {
  const digits = onlyDigits(value);
  if (digits.length !== 14) return value || "-";
  return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
}

function formatCpf(value) {
  const digits = onlyDigits(value);
  if (digits.length !== 11) return value || "-";
  return digits.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
}

function money(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return value || "Sem dado encontrado";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(number);
}

function text(value, fallback = "Sem dado encontrado") {
  return value === null || value === undefined || value === "" ? fallback : String(value);
}

function sourceClass(status) {
  return {
    connected: "status-ok",
    key: "status-key",
    pending: "status-pending",
    empty: "status-empty",
    error: "status-error"
  }[status] || "status-empty";
}

function sourceLabel(status) {
  return {
    connected: "Conectado",
    key: "Precisa chave/API",
    pending: "Pendente de ingestao",
    empty: "Sem dado encontrado",
    error: "Erro"
  }[status] || status;
}

function setView(view) {
  state.activeView = view;
  document.querySelectorAll(".view").forEach((section) => {
    section.classList.toggle("active", section.id === `view-${view}`);
  });
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  const titles = {
    overview: ["Dados reais", "Overview"],
    investigate: ["Grafo interativo", "Investigar"],
    dossier: ["Relatorio do alvo", "Dossie"],
    sources: ["Conectores", "Fontes reais"],
    dou: ["Diario Oficial da Uniao", "Monitor DOU"],
    directors: ["Dossie de dirigentes", "Diretores"],
    graph: ["Rede de influencia (M7)", "Grafo Nacional"],
    intelligence: ["Inteligencia regulatoria", "Inteligencia Nacional"],
    consultas: ["Participacao social (M5)", "Consultas Publicas"],
    agenda: ["Calendario regulatorio (M8)", "Agenda e Pautas"],
    "agenda-reg": ["Pipeline regulatorio (M8+)", "Agenda Regulatoria"],
    monitors: ["Vigilancia continua (M10)", "Central de Monitoramento"],
    legislativo: ["Radar legislativo (M12)", "Legislativo"],
    radar: ["Risco & Oportunidade (M13)", "Radar"],
    gerador: ["Composição comercial (M14)", "Gerador de Dossiê"],
    person: ["Screening de pessoa", "Consulta Pessoa"]
  };
  const [kicker, title] = titles[view] || ["LINCE", view];
  if (view === "dou") loadDouFeed();
  if (view === "directors") loadDirectors();
  if (view === "graph") loadNationalGraph();
  if (view === "intelligence") loadIntelligence();
  if (view === "consultas") loadConsultas();
  if (view === "agenda") loadAgenda();
  if (view === "agenda-reg") loadAgendaRegulatoria();
  if (view === "monitors") loadMonitors();
  if (view === "legislativo") loadLegislativo();
  if (view === "radar") loadRadar();
  if (view === "gerador") loadGerador();
  $("#view-kicker").textContent = kicker;
  $("#view-title").textContent = title;
}

function setLoading(isLoading) {
  const button = $("#search-form button");
  button.disabled = isLoading;
  button.textContent = isLoading ? "Consultando..." : "Consultar";
}

async function runSearch(cnpjInput) {
  const cnpj = onlyDigits(cnpjInput);
  if (cnpj.length !== 14) {
    showInspectorMessage("CNPJ invalido", "Informe 14 digitos. Nenhuma consulta foi executada.");
    return;
  }

  setLoading(true);
  setView("investigate");
  clearResult();

  const results = await Promise.allSettled([
    realDataProvider.fetchCnpj(cnpj),
    realDataProvider.fetchDomains(cnpj),
    realDataProvider.fetchProcesses(cnpj),
    realDataProvider.fetchTransparency(cnpj),
    requestJson(`/api/external?type=screening&cnpj=${cnpj}`),
    requestJson(`/api/intelligence?type=holdings&cnpj=${cnpj}`)
  ]);

  const cnpjResult = unwrapResult(results[0]);
  const domainResult = unwrapResult(results[1]);
  const processResult = unwrapResult(results[2]);
  const transparencyResult = unwrapResult(results[3]);
  const screeningResult = unwrapResult(results[4]);
  const holdingsResult = unwrapResult(results[5]);

  state.sources.cnpj = resultToSource(cnpjResult);
  state.sources.rdap = resultToSource(domainResult);
  state.sources.datajud = resultToSource(processResult, "key");
  // Transparência: falha real (endpoint/HTTP) mostra "erro", não "requer chave"
  // (a ausência de chave já vem como status:'requires_key' -> rótulo "key").
  state.sources.transparency = resultToSource(transparencyResult);
  state.sources.screening = resultToSource(screeningResult, "key");
  state.screening = screeningResult.ok ? screeningResult.value : null;
  state.holdings = holdingsResult.ok ? holdingsResult.value.items || [] : [];

  if (!cnpjResult.ok || !cnpjResult.value?.data) {
    setLoading(false);
    renderSources();
    renderOverview();
    renderGraph();
    renderDossier();
    showInspectorMessage(
      "CNPJ nao carregado",
      cnpjResult.error || "A fonte principal nao retornou dados. O dossie permanece vazio."
    );
    return;
  }

  const company = normalizeCnpjPayload(cnpjResult.value.data);
  state.target = company;
  state.news = [];

  const newsQuery = company.legalName || company.tradeName || cnpj;
  const newsResult = await settle(realDataProvider.fetchNews(newsQuery));
  state.sources.news = resultToSource(newsResult);
  state.news = newsResult.ok ? newsResult.value.items || [] : [];

  const domains = domainResult.ok ? normalizeDomains(domainResult.value) : [];
  const processes = processResult.ok ? processResult.value.items || [] : [];
  const transparency = transparencyResult.ok ? transparencyResult.value.items || [] : [];

  buildDossier(company, domains, state.news, processes, transparency);
  buildGraph(company, domains, state.news, processes, transparency);
  // Enriquece o grafo com a rede societária PERSISTIDA (holdings, sócio-de-sócio)
  // via QSA. Best-effort: se não houver dado/rede, o grafo ao vivo segue igual.
  state.graphRootCompanyId = cnpjResult.value?.persisted?.company_id || null;
  if (state.graphRootCompanyId) {
    await mergeSocioNetwork(state.graphRootCompanyId).catch(() => {});
  }
  renderAll();
  setLoading(false);
}

// Mescla o subgrafo societário do banco (api/graph expand=socio) no grafo de
// investigação, remapeando o nó-raiz do banco para o nó central "company".
async function mergeSocioNetwork(companyId) {
  const g = await requestJson(`/api/graph?node=company:${encodeURIComponent(companyId)}&expand=socio&depth=2`);
  if (!g?.nodes?.length) return;
  const rootId = `company:${companyId}`;
  const remap = (id) => (id === rootId ? "company" : id);
  const existing = new Set(state.graphNodes.map((n) => n.id));
  const dbNodeById = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
  for (const e of g.edges || []) {
    const a = remap(e.from), b = remap(e.to);
    // Pula aresta direta raiz<->pessoa: o sócio direto já aparece via QSA ao vivo.
    const other = a === "company" ? e.to : (b === "company" ? e.from : null);
    if (other && dbNodeById[other]?.type === "person") continue;
    for (const endId of [e.from, e.to]) {
      const mid = remap(endId);
      if (existing.has(mid)) continue;
      const dn = dbNodeById[endId];
      if (!dn) continue;
      state.graphNodes.push({ id: mid, type: dn.type === "company" ? "company" : "partner",
        title: dn.title, subtitle: dn.subtitle || "", fields: [["Fonte", "Rede societária (Receita/QSA)"]] });
      existing.add(mid);
    }
    state.graphEdges.push([a, b, socioRoleBucket(e.meta?.role), e.weight ?? 0.9]);
  }
}

// Duplo-clique num nó com id de banco (kind:uuid) expande a rede societária dele.
async function expandCnpjNode(nodeId) {
  let target = nodeId;
  if (nodeId === "company" && state.graphRootCompanyId) target = `company:${state.graphRootCompanyId}`;
  if (!target || !target.includes(":")) return; // só nós com id de banco
  try {
    const g = await requestJson(`/api/graph?node=${encodeURIComponent(target)}&expand=socio&depth=1`);
    const existing = new Set(state.graphNodes.map((n) => n.id));
    const dbNodeById = Object.fromEntries((g.nodes || []).map((n) => [n.id, n]));
    const remap = (id) => (id === target ? nodeId : id);
    for (const e of g.edges || []) {
      for (const endId of [e.from, e.to]) {
        const mid = remap(endId);
        if (existing.has(mid) || !dbNodeById[endId]) continue;
        const dn = dbNodeById[endId];
        state.graphNodes.push({ id: mid, type: dn.type === "company" ? "company" : "partner",
          title: dn.title, subtitle: dn.subtitle || "", fields: [["Fonte", "Rede societária (Receita/QSA)"]] });
        existing.add(mid);
      }
      state.graphEdges.push([remap(e.from), remap(e.to), socioRoleBucket(e.meta?.role), e.weight ?? 0.9]);
    }
    renderGraph();
  } catch { /* silencioso */ }
}

// ── Mini-gráfico SVG de barras semanais (sem D3) ──────────────────────────
function buildMiniChart(series, baseline) {
  if (!series?.length) return "";
  const W = 200, H = 52, pad = 4;
  const maxVal = Math.max(...series.map((s) => s.total), baseline * 1.5 || 1, 1);
  const colW = (W - pad * 2) / series.length;
  const bw = Math.max(1, colW - 2);
  const bars = series.map((s, i) => {
    const bh = Math.max(2, (s.total / maxVal) * (H - pad * 2));
    const x = pad + i * colW;
    const y = H - pad - bh;
    const hot = baseline > 0 && s.total > baseline * 1.5;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" fill="${hot ? "var(--amber)" : "var(--blue)"}" rx="1"/>`;
  }).join("");
  const baseY = baseline > 0 ? H - pad - (baseline / maxVal) * (H - pad * 2) : null;
  const line = baseY !== null
    ? `<line x1="${pad}" y1="${baseY.toFixed(1)}" x2="${W - pad}" y2="${baseY.toFixed(1)}" stroke="var(--blue-bright)" stroke-width="1" stroke-dasharray="3,2"/>`
    : "";
  return `<svg class="mini-chart" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${bars}${line}</svg>`;
}

// ── Painel de objeto estilo Palantir Gotham ───────────────────────────────
async function renderNatInspector(nodeId) {
  const body = $("#nat-inspector-body");
  if (!body) return;
  const node = natGraph.nodes.find((n) => n.id === nodeId) || natGraph.allNodes.find((n) => n.id === nodeId);
  if (!node) return;
  const [kind, id] = nodeId.split(":");
  body.innerHTML = `<p style="opacity:.5;font-size:.8rem;padding:8px 0">Carregando...</p>`;

  const isExpanded = natGraph.expanded.has(nodeId);
  const neighborSet = new Set(
    natGraph.allEdges.filter((e) => e.from === nodeId || e.to === nodeId)
      .map((e) => (e.from === nodeId ? e.to : e.from))
  );
  const nNeighbors = neighborSet.size;
  const nEdges = natGraph.allEdges.filter((e) => e.from === nodeId || e.to === nodeId).length;
  const expandBtn = `<button type="button" class="entity-pill" id="nat-expand" style="cursor:pointer">${isExpanded ? "Colapsar" : "Expandir conexões"}</button>`;

  if (kind === "agency") {
    const acronym = node.subtitle || node.title;
    const stats = await requestJson(`/api/intelligence?type=agency_stats&agency=${encodeURIComponent(acronym)}`).catch(() => null);
    const series = stats?.weekly_series || [];
    const lastWeek = series[series.length - 1]?.total ?? 0;
    const aboveBaseline = stats?.baseline_avg > 0 && lastWeek > stats.baseline_avg * 1.5;
    const alertItems = (stats?.alerts || []).map((a) => `
      <div class="activity-alert${a.severity !== "high" ? " info" : ""}">
        <span class="alert-icon">${a.severity === "high" ? "⚠" : "ℹ"}</span>
        <div style="flex:1;min-width:0">
          <p style="margin:0;font-size:.78rem;font-weight:700">${escapeHtml(a.title || "")}</p>
          ${a.body ? `<p style="margin:2px 0 0;font-size:.72rem;opacity:.65">${escapeHtml(a.body.slice(0, 100))}</p>` : ""}
          <div class="alert-actions">
            <button type="button" class="alert-btn primary nat-alert-view">Ver atos</button>
            <button type="button" class="alert-btn nat-alert-dismiss" data-alert-id="${escapeHtml(a.id)}">Dispensar</button>
          </div>
        </div>
      </div>`).join("");
    body.innerHTML = `
      <div class="object-section">
        <p class="object-section-title">Detalhes</p>
        <p style="font-size:.78rem;opacity:.6;margin:0 0 8px">${escapeHtml(stats?.agency_name || node.title)}</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
          <div class="detail-stat"><span>${stats?.total_docs ?? "—"}</span><small>atos totais</small></div>
          <div class="detail-stat"><span>${stats?.docs_30d ?? "—"}</span><small>últimos 30d</small></div>
          <div class="detail-stat"><span>${stats?.active_directors ?? nNeighbors}</span><small>diretores</small></div>
          <div class="detail-stat"><span>${nNeighbors}</span><small>conexões</small></div>
        </div>
      </div>
      ${series.length ? `
      <div class="object-section">
        <p class="object-section-title">Atividade semanal ${aboveBaseline ? '<span class="status-pill status-error" style="font-size:.65rem">Acima do baseline</span>' : ""}</p>
        ${aboveBaseline ? `<div class="activity-alert" style="margin-bottom:8px"><span class="alert-icon">⚠</span><span style="font-size:.78rem">Volume atual &gt;1,5× a média histórica</span></div>` : ""}
        ${buildMiniChart(series, stats.baseline_avg)}
        <p style="font-size:.68rem;opacity:.45;margin:2px 0 0">— baseline avg: ${stats.baseline_avg} atos/sem.</p>
      </div>` : ""}
      ${alertItems ? `
      <div class="object-section">
        <p class="object-section-title">Observações (${stats?.open_alerts || 0} pendentes)</p>
        ${alertItems}
      </div>` : ""}
      <div class="object-section"><div class="entity-row">${expandBtn}</div></div>`;
  } else if (kind === "person") {
    const dossier = await requestJson(`/api/dossier-person?id=${encodeURIComponent(id)}`).catch(() => null);
    const intel = dossier?.intelligence || {};
    const mandates = dossier?.mandates || [];
    const agencies = [...new Set(mandates.map((m) => m.agencies?.acronym).filter(Boolean))];
    const relPills = [...new Set(
      natGraph.allEdges.filter((e) => e.from === nodeId || e.to === nodeId).map((e) => e.relationship)
    )].map((r) => `<span class="entity-pill">${escapeHtml(r)}</span>`).join(" ");
    const score = intel.capture_score ?? 0;
    body.innerHTML = `
      <div class="object-section">
        <p class="object-section-title">Detalhes</p>
        <p style="font-size:.78rem;opacity:.6;margin:0 0 4px">${escapeHtml(node.subtitle || dossier?.person?.role || "Dirigente")}</p>
        ${agencies.length ? `<p style="font-size:.78rem;margin:2px 0">Agência(s): <strong>${escapeHtml(agencies.join(", "))}</strong></p>` : ""}
        <p style="font-size:.78rem;margin:2px 0">Mandato ativo: <strong>${intel.active_mandate ? "Sim" : "Não"}</strong></p>
        <p style="font-size:.78rem;margin:2px 0">${nNeighbors} conexão(ões) · ${nEdges} relação(ões)</p>
      </div>
      <div class="object-section">
        <p class="object-section-title">Score de captura</p>
        <div style="display:flex;align-items:baseline;gap:6px;margin-bottom:6px">
          <span style="font-size:1.4rem;font-weight:800;color:${score < 30 ? "var(--green)" : score < 60 ? "var(--yellow)" : "var(--red)"}">${score}</span>
          <span style="font-size:.75rem;opacity:.5">/ 100 &nbsp;·&nbsp; ${intel.dissent_votes ?? 0} voto(s) divergente(s)</span>
        </div>
        <div class="score-bar-wrap"><div class="score-bar-fill" style="width:${score}%"></div></div>
      </div>
      ${(dossier?.assets?.items || []).length ? (() => {
        const years = Object.entries(dossier.assets.total_by_year || {}).sort(([a], [b]) => b.localeCompare(a));
        return `
      <div class="object-section">
        <p class="object-section-title">Patrimônio declarado (TSE)${dossier.assets.weak_match ? ' <span class="status-pill status-key" style="font-size:.6rem">match por nome</span>' : ""}</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
          <div class="detail-stat"><span>${escapeHtml(money(years[0]?.[1] ?? 0))}</span><small>total ${escapeHtml(years[0]?.[0] || "")}</small></div>
          <div class="detail-stat"><span>${dossier.assets.items.length}</span><small>bens declarados</small></div>
        </div>
      </div>`;
      })() : ""}
      ${relPills ? `<div class="object-section"><p class="object-section-title">Relações</p><div class="entity-row">${relPills}</div></div>` : ""}
      <div class="object-section">
        <div class="entity-row">
          ${expandBtn}
          <button type="button" class="alert-btn primary" id="nat-open-dossier">Abrir dossiê</button>
        </div>
      </div>`;
    $("#nat-open-dossier")?.addEventListener("click", () => {
      document.querySelector("[data-view='directors']")?.click();
      openDirectorDossier(id);
    });
  } else {
    const cnpj = node.subtitle || "";
    const relPills = [...new Set(
      natGraph.allEdges.filter((e) => e.from === nodeId || e.to === nodeId).map((e) => e.relationship)
    )].map((r) => `<span class="entity-pill">${escapeHtml(r)}</span>`).join(" ");
    body.innerHTML = `
      <div class="object-section">
        <p class="object-section-title">Detalhes</p>
        ${cnpj ? `<p style="font-size:.78rem;opacity:.6;margin:0 0 4px">CNPJ: ${escapeHtml(cnpj)}</p>` : ""}
        <p style="font-size:.78rem;margin:2px 0">${nNeighbors} conexão(ões) · ${nEdges} relação(ões)</p>
      </div>
      ${relPills ? `<div class="object-section"><p class="object-section-title">Relações</p><div class="entity-row">${relPills}</div></div>` : ""}
      <div class="object-section">
        <div class="entity-row">
          ${expandBtn}
          ${cnpj ? `<button type="button" class="alert-btn primary" id="nat-investigate-cnpj">Investigar CNPJ</button>` : ""}
        </div>
      </div>`;
    $("#nat-investigate-cnpj")?.addEventListener("click", () => {
      const el = $("#global-search");
      if (el) { el.value = cnpj; el.form?.requestSubmit(); }
    });
  }

  // Wire expand/collapse
  $("#nat-expand")?.addEventListener("click", () =>
    (natGraph.expanded.has(nodeId) ? collapseNatNode : expandNatNode)(nodeId));

  // Wire alert action buttons
  body.querySelectorAll(".nat-alert-dismiss").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true; btn.textContent = "...";
      await requestJson(`/api/intelligence?type=dismiss_alert&id=${encodeURIComponent(btn.dataset.alertId)}`).catch(() => {});
      const card = btn.closest(".activity-alert");
      if (card) { card.style.transition = "opacity .3s"; card.style.opacity = "0"; setTimeout(() => card.remove(), 320); }
    });
  });
  body.querySelectorAll(".nat-alert-view").forEach((btn) => {
    btn.addEventListener("click", () => setView("dou"));
  });
}

async function runKeywordSearch(query) {
  setView("dou");
  const url = `/api/intelligence?type=search&q=${encodeURIComponent(query)}&limit=30`;
  const r = await requestJson(url).catch(() => null);
  const items = r?.items || [];
  const douFeed = $("#dou-list");
  if (!douFeed) return;
  if (!items.length) {
    douFeed.innerHTML = emptyCard("Busca", `Nenhum ato encontrado para "${escapeHtml(query)}".`);
    return;
  }
  douFeed.innerHTML = `<p style="margin:0 0 12px;color:var(--muted)">${items.length} resultado(s) para <strong>"${escapeHtml(query)}"</strong></p>` +
    items.map((d) => `
      <article class="news-card target-card">
        <div class="card-body">
          <div class="card-head">
            ${TARGET_ICO}
            <div>
              <strong>${escapeHtml(d.title || "Sem título")}</strong>
              <span class="card-sub">${escapeHtml(d.date || "sem data")} ${d.type ? `· <span class="tag ${escapeHtml(d.type)}">${escapeHtml(d.type.replace("_", " "))}</span>` : ""}</span>
            </div>
            <span class="card-prio">${escapeHtml(d.agency || "DOU")}</span>
          </div>
          ${safeUrl(d.link) ? `<div class="entity-row"><a class="entity-pill" href="${escapeHtml(safeUrl(d.link))}" target="_blank" rel="noopener">Abrir no DOU</a></div>` : ""}
        </div>
        ${cardFoot("var(--blue)", "Busca textual", `DOU//${d.agency || "BR"}`)}
      </article>`).join("");
}

function unwrapResult(result) {
  if (result.status === "fulfilled") return { ok: true, value: result.value };
  return {
    ok: false,
    error: result.reason?.payload?.error || result.reason?.message || "Falha na consulta",
    payload: result.reason?.payload
  };
}

async function settle(promise) {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error: error.payload?.error || error.message, payload: error.payload };
  }
}

function resultToSource(result, fallbackBlockedStatus = "error") {
  if (result.ok) return { status: "connected", detail: "Consulta real executada" };
  if (result.payload?.status === "requires_key") return { status: "key", detail: result.error };
  if (result.payload?.status === "pending_ingestion") return { status: "pending", detail: result.error };
  return { status: fallbackBlockedStatus, detail: result.error };
}

function normalizeCnpjPayload(data) {
  const est = data.estabelecimento || {};
  const city = est.cidade?.nome || est.cidade_nome || "";
  const stateCode = est.estado?.sigla || est.estado_sigla || "";
  const mainActivity = est.atividade_principal || {};
  const secondary = est.atividades_secundarias || [];
  return {
    cnpj: est.cnpj || data.cnpj || "",
    legalName: data.razao_social || data.nome || "",
    tradeName: est.nome_fantasia || "",
    status: est.situacao_cadastral || "",
    openingDate: est.data_inicio_atividade || "",
    legalNature: data.natureza_juridica?.descricao || "",
    size: data.porte?.descricao || data.porte || "",
    capital: data.capital_social,
    mainCnae: {
      code: mainActivity.id || mainActivity.codigo || "",
      description: mainActivity.descricao || ""
    },
    secondaryCnaes: secondary.map((item) => ({
      code: item.id || item.codigo || "",
      description: item.descricao || ""
    })),
    partners: (data.socios || data.qsa || []).map((partner) => ({
      name: partner.nome || partner.nome_socio || "",
      qualification: partner.qualificacao_socio?.descricao || partner.qualificacao_socio || partner.qualificacao || "",
      entryDate: partner.data_entrada || ""
    })),
    address: {
      street: [est.tipo_logradouro, est.logradouro].filter(Boolean).join(" "),
      number: est.numero || "",
      complement: est.complemento || "",
      district: est.bairro || "",
      zip: est.cep || "",
      city,
      state: stateCode
    },
    phones: [est.ddd1 && est.telefone1 ? `(${est.ddd1}) ${est.telefone1}` : "", est.ddd2 && est.telefone2 ? `(${est.ddd2}) ${est.telefone2}` : ""].filter(Boolean),
    email: est.email || "",
    raw: data
  };
}

function normalizeDomains(payload) {
  if (!payload?.data) return [];
  const events = Array.isArray(payload.data.events) ? payload.data.events : [];
  const links = Array.isArray(payload.data.links) ? payload.data.links : [];
  const names = new Set();

  for (const link of links) {
    const href = link.href || "";
    const match = href.match(/domain\/([^/?#]+)/i);
    if (match) names.add(decodeURIComponent(match[1]));
  }

  const notices = Array.isArray(payload.data.notices) ? payload.data.notices : [];
  for (const notice of notices) {
    const description = (notice.description || []).join(" ");
    for (const match of description.matchAll(/\b[a-z0-9-]+\.com\.br\b/gi)) {
      names.add(match[0]);
    }
  }

  const domains = [...names].map((name) => ({
    name,
    source: "Registro.br RDAP",
    date: events[0]?.eventDate || ""
  }));

  if (!domains.length && Number.isFinite(Number(payload.data.nicbr_domainCount))) {
    domains.push({
      name: `${payload.data.nicbr_domainCount} dominios .br vinculados`,
      source: "Registro.br RDAP",
      date: events[0]?.eventDate || "",
      aggregate: true
    });
  }

  return domains;
}

function buildDossier(company, domains, news, processes, transparency) {
  const addressLine = [
    company.address.street,
    company.address.number,
    company.address.complement,
    company.address.district,
    company.address.city,
    company.address.state,
    company.address.zip
  ]
    .filter(Boolean)
    .join(", ");

  state.dossier = {
    basic: compactItems([
      item("Razao social", company.legalName, "CNPJ.ws / Receita Federal"),
      item("Nome fantasia", company.tradeName, "CNPJ.ws / Receita Federal"),
      item("CNPJ", formatCnpj(company.cnpj), "CNPJ.ws / Receita Federal"),
      item("Situacao cadastral", company.status, "CNPJ.ws / Receita Federal"),
      item("Data de abertura", company.openingDate, "CNPJ.ws / Receita Federal"),
      item("Natureza juridica", company.legalNature, "CNPJ.ws / Receita Federal"),
      item("Porte", company.size, "CNPJ.ws / Receita Federal"),
      item("Capital social", money(company.capital), "CNPJ.ws / Receita Federal")
    ]),
    cnaes: compactItems([
      item("CNAE principal", [company.mainCnae.code, company.mainCnae.description].filter(Boolean).join(" - "), "CNPJ.ws / Receita Federal"),
      ...company.secondaryCnaes.map((cnae) => item("CNAE secundario", [cnae.code, cnae.description].filter(Boolean).join(" - "), "CNPJ.ws / Receita Federal"))
    ]),
    partners: company.partners.map((partner) =>
      item(partner.name, [partner.qualification, partner.entryDate ? `Entrada: ${partner.entryDate}` : ""].filter(Boolean).join(" | "), "QSA / CNPJ.ws")
    ),
    addresses: compactItems([item("Endereco cadastral", addressLine, "CNPJ.ws / Receita Federal")]),
    phones: company.phones.map((phone) => item("Telefone cadastral", phone, "CNPJ.ws / Receita Federal")),
    emails: compactItems([item("Email cadastral", company.email, "CNPJ.ws / Receita Federal")]),
    domains: domains.map((domain) =>
      item(domain.name, domain.aggregate ? "Contagem real retornada pelo RDAP; lista pode estar truncada por politica do servidor." : domain.date ? `Evento RDAP: ${domain.date}` : "Dominio vinculado no RDAP", domain.source)
    ),
    news: news.map((newsItem) => item(newsItem.title, `${newsItem.source} | ${newsItem.date || "sem data"}`, "Google News RSS")),
    processes: processes.map((process) => item(process.title || process.numeroProcesso || "Processo", process.description || "Retornado pelo DataJud", "CNJ DataJud")),
    publicPayments: transparency.map((entry) => item(entry.title || "Registro", entry.description || "Portal da Transparencia", "Portal da Transparencia")),
    movements: [],
    social: [],
    documents: [],
    debts: [],
    irregularities: screeningToItems(state.screening),
    alerts: [],
    regulatoryHistory: [],
    decisionPattern: []
  };
}

function item(label, value, source) {
  return { label, value: text(value), source, empty: !value };
}

// Aba Patrimônio do dossiê de empresa: capital social (CNPJ.ws), participações
// societárias locais (dump da Receita) e contratos públicos (Transparência).
function renderCompanyPatrimony() {
  if (!state.target) {
    return emptyCard("Patrimonio", emptyMessageForTab("patrimony"));
  }
  const capital = `
    <article class="dossier-item patrimony-block">
      <span class="field-source">CNPJ.ws / Receita Federal</span>
      <strong>Capital social: ${escapeHtml(money(state.target.capital))}</strong>
      <p>Valor declarado no cadastro da Receita Federal.</p>
    </article>`;

  const holdings = state.holdings.length
    ? `<article class="dossier-item patrimony-block">
        <span class="field-source">Receita Federal (dump SOCIO)</span>
        <strong>Quadro societário local (${state.holdings.length})</strong>
        <div style="overflow-x:auto">
          <table class="data-table assets-table">
            <thead><tr><th>Sócio</th><th>Papel</th><th>Fonte</th></tr></thead>
            <tbody>${state.holdings.map((h) => `
              <tr>
                <td>${escapeHtml(h.name)}</td>
                <td>${escapeHtml(h.role || "Sócio")}</td>
                <td>${escapeHtml(h.source || "Receita")}</td>
              </tr>`).join("")}</tbody>
          </table>
        </div>
      </article>`
    : `<article class="dossier-item empty patrimony-block">
        <span class="field-source">Sem dado conectado</span>
        <strong>Participações societárias</strong>
        <p>Sem registros na base local. Rode load:receita-socio com o dump da Receita.</p>
      </article>`;

  const contracts = (state.dossier.publicPayments || []).length
    ? `<article class="dossier-item patrimony-block">
        <span class="field-source">Portal da Transparência</span>
        <strong>Contratos públicos recebidos (${state.dossier.publicPayments.length})</strong>
        <div style="overflow-x:auto">
          <table class="data-table assets-table">
            <thead><tr><th>Objeto</th><th>Órgão</th></tr></thead>
            <tbody>${state.dossier.publicPayments.map((c) => `
              <tr><td>${escapeHtml(c.label)}</td><td>${escapeHtml(c.value)}</td></tr>`).join("")}</tbody>
          </table>
        </div>
      </article>`
    : `<article class="dossier-item empty patrimony-block">
        <span class="field-source">Sem dado conectado</span>
        <strong>Contratos públicos</strong>
        <p>Nenhum contrato retornado pelo Portal da Transparência (ou chave ausente).</p>
      </article>`;

  return capital + holdings + contracts;
}

function compactItems(items) {
  return items.filter((entry) => !entry.empty);
}

function buildGraph(company, domains, news, processes = [], transparency = []) {
  const nodes = [];
  const edges = [];
  const companyInapta = !!(company.status && !/ativ/i.test(company.status));
  nodes.push({
    id: "company",
    type: "company",
    title: company.legalName || formatCnpj(company.cnpj),
    subtitle: formatCnpj(company.cnpj),
    central: true,
    alert: companyInapta,
    status: company.status || "Conectado",
    fields: [
      ["Fonte", "CNPJ.ws"],
      ["Situacao", company.status || "Sem dado"],
      ["Capital social", money(company.capital)],
      ["CNAE", [company.mainCnae.code, company.mainCnae.description].filter(Boolean).join(" - ") || "Sem dado"],
      ["Cidade/UF", [company.address.city, company.address.state].filter(Boolean).join("/") || "Sem dado"]
    ]
  });

  company.partners.slice(0, 12).forEach((partner, index) => {
    const id = `partner-${index}`;
    const role = socioRoleBucket(partner.qualification); // Sócio/Administrador/Direção
    nodes.push({
      id, type: "partner",
      title: partner.name || "Socio sem nome",
      subtitle: partner.qualification || "QSA",
      status: "QSA",
      fields: [["Fonte", "CNPJ.ws"], ["Papel", partner.qualification || role], ["Entrada", partner.entryDate || "Sem dado"]]
    });
    edges.push([id, "company", role, 0.9]);
  });

  company.phones.forEach((phone, index) => {
    const id = `phone-${index}`;
    nodes.push({ id, type: "contact", title: "Telefone", subtitle: phone, status: "Fonte publica", fields: [["Fonte", "CNPJ.ws"]] });
    edges.push(["company", id, "Contato", 0.7]);
  });

  if (company.email) {
    nodes.push({ id: "email", type: "contact", title: "Email", subtitle: company.email, status: "Fonte publica", fields: [["Fonte", "CNPJ.ws"]] });
    edges.push(["company", "email", "Contato", 0.7]);
  }

  domains.slice(0, 8).forEach((domain, index) => {
    const id = `domain-${index}`;
    nodes.push({ id, type: "domain", title: domain.name, subtitle: domain.aggregate ? "Contagem RDAP" : "Registro.br RDAP", status: "RDAP", fields: [["Fonte", "Registro.br"]] });
    edges.push(["company", id, "Dominio", 0.6]);
  });

  news.slice(0, 6).forEach((newsItem, index) => {
    const id = `news-${index}`;
    nodes.push({ id, type: "news", title: newsItem.title, subtitle: newsItem.source, status: "RSS", fields: [["Data", newsItem.date || "Sem data"], ["Fonte", "Google News RSS"]] });
    edges.push([id, "company", "Citado em noticia", 0.5]);
  });

  // Processos judiciais (DataJud) — antes eram buscados mas descartados do grafo.
  (processes || []).slice(0, 12).forEach((proc, index) => {
    const id = `process-${index}`;
    nodes.push({ id, type: "process", title: proc.title || "Processo", subtitle: proc.description || "CNJ DataJud", status: "DataJud", fields: [["Fonte", "CNJ DataJud"]] });
    edges.push(["company", id, "Processo", 0.8]);
  });

  // Contratos/recebimentos públicos (Portal da Transparência) — idem.
  (transparency || []).slice(0, 12).forEach((c, index) => {
    const id = `contract-${index}`;
    nodes.push({ id, type: "contract", title: c.title || "Contrato público", subtitle: c.description || "Portal da Transparência", status: "Transparência", fields: [["Fonte", "Portal da Transparência"]] });
    edges.push(["company", id, "Contrato", 0.8]);
  });

  state.graphNodes = nodes;
  state.graphEdges = edges;
  state.selectedNodeId = "company";
}

function clearResult() {
  state.target = null;
  state.graphNodes = [];
  state.graphEdges = [];
  state.dossier = {};
  state.news = [];
  state.screening = null;
  state.holdings = [];
  state.selectedNodeId = null;
  renderAll();
}

function renderAll() {
  renderOverview();
  renderSources();
  renderGraph();
  renderInspector();
  renderDossier();
}

function renderOverview() {
  // Overview agora é orientado a dados regulatorios (ver loadOverviewMetrics).
  // Mantido defensivo caso elementos antigos nao existam.
  const last = $("#metric-last");
  if (last) last.textContent = state.target ? formatCnpj(state.target.cnpj) : "-";
  const lastLabel = $("#metric-last-label");
  if (lastLabel) lastLabel.textContent = state.target?.legalName || "Nenhum CNPJ consultado";
  const sourceList = $("#overview-source-list");
  if (sourceList) {
    sourceList.innerHTML = sourceStatus.map((source) => {
      const runtime = state.sources[source.id];
      const status = runtime?.status || source.status;
      const detail = runtime?.detail || source.help;
      return `<article class="source-row"><span class="status-pill ${sourceClass(status)}">${sourceLabel(status)}</span><div><strong>${source.name}</strong><p class="status-help">${detail}</p></div></article>`;
    }).join("");
  }
}

function renderSources() {
  $("#source-grid").innerHTML = sourceStatus
    .map((source) => {
      const runtime = state.sources[source.id];
      const status = runtime?.status || source.status;
      const detail = runtime?.detail || source.help;
      return `
        <article class="source-card">
          <span class="source-meta">${source.method}</span>
          <strong>${source.name}</strong>
          <p>${source.data}</p>
          <span class="status-pill ${sourceClass(status)}">${sourceLabel(status)}</span>
          <p>${detail}</p>
        </article>
      `;
    })
    .join("");

  if (!state.news.length) {
    $("#news-list").innerHTML = emptyCard("Noticias / RSS", "Sem consulta executada ou sem noticias retornadas por fonte real.");
    return;
  }

  $("#news-list").innerHTML = state.news
    .map(
      (entry) => `
        <article class="news-card target-card">
          <div class="card-body">
            <div class="card-head">
              <div>
                <strong>${escapeHtml(entry.title)}</strong>
                <span class="card-sub">${escapeHtml(entry.date || "sem data")}</span>
              </div>
            </div>
            <p>${escapeHtml(entry.summary || "Sem resumo disponivel no RSS.")}</p>
            <div class="entity-row">
              ${safeUrl(entry.link) ? `<a class="entity-pill" href="${escapeHtml(safeUrl(entry.link))}" target="_blank" rel="noreferrer">Abrir fonte</a>` : ""}
            </div>
          </div>
          ${cardFoot("var(--red)", entry.source || "RSS", "RSS//OSINT")}
        </article>
      `
    )
    .join("");
}

const DOU_TYPE_LABEL = { norma: "Norma", ato_pessoal: "Ato de pessoal", contrato: "Contrato", ato: "Ato" };

async function loadDouFeed() {
  const list = $("#dou-list");
  if (!list) return;
  list.innerHTML = emptyCard("Monitor DOU", "Carregando atos do Diario Oficial...");
  const date = $("#dou-date")?.value;
  const agency = $("#dou-agency")?.value;
  const params = new URLSearchParams();
  if (date) params.set("date", date);
  if (agency) params.set("agency", agency);
  const qs = params.toString();
  const url = qs ? `/api/dou-feed?${qs}` : "/api/dou-feed";
  try {
    const payload = await requestJson(url);
    const items = payload.items || [];
    if (!items.length) {
      list.innerHTML = emptyCard("Monitor DOU", "Sem atos das agencias ingeridos para este periodo. Rode /api/ingest-dou.");
      return;
    }
    const queueColor = (type) => ({ norma: "var(--blue)", ato_pessoal: "var(--purple)", contrato: "var(--yellow)" }[type] || "var(--muted)");
    list.innerHTML = items
      .map((entry) => `
        <article class="news-card target-card">
          <div class="card-body">
            <div class="card-head">
              ${TARGET_ICO}
              <div>
                <strong>${escapeHtml(entry.title)}</strong>
                <span class="card-sub">${escapeHtml(DOU_TYPE_LABEL[entry.type] || entry.type)} · ${escapeHtml(entry.date || "sem data")}</span>
              </div>
              <span class="card-prio">${escapeHtml(entry.agency || "DOU")}</span>
            </div>
            <p>${highlightEntities(entry.summary || "Sem resumo de IA.", entry.entities)}</p>
            <div class="entity-row">
              ${(entry.entities || []).slice(0, 4).map((e) => `<span class="entity-pill">${escapeHtml(e.name || "")}</span>`).join("")}
              ${entry.link ? `<a class="entity-pill" href="${escapeHtml(entry.link)}" target="_blank" rel="noreferrer">Abrir DOU</a>` : ""}
            </div>
          </div>
          ${cardFoot(queueColor(entry.type), DOU_TYPE_LABEL[entry.type] || entry.type || "Ato", `DOU//${entry.agency || "BR"}`)}
        </article>
      `)
      .join("");
  } catch (error) {
    list.innerHTML = emptyCard("Monitor DOU", `Falha ao carregar: ${error.message}`);
  }
}

// Lista de diretores (busca incremental por ?q= ou lista completa por ?list=1).
async function loadDirectors() {
  const list = $("#directors-list");
  if (!list) return;
  const name = $("#director-search")?.value?.trim();
  list.innerHTML = emptyCard("Diretores", name ? "Buscando..." : "Carregando diretores...");
  try {
    const url = name
      ? `/api/dossier-person?q=${encodeURIComponent(name)}`
      : `/api/dossier-person?list=1`;
    const data = await requestJson(url);
    const people = data.people || [];
    if (!people.length) {
      list.innerHTML = emptyCard("Diretores", name ? `Nenhum diretor com "${name}".` : "Nenhum diretor mapeado ainda. Rode a ingestao do DOU.")
        + (name ? `<article class="dossier-item"><span class="field-source">Screening externo</span><button type="button" class="alert-btn primary" id="director-screening-btn">Consultar "${escapeHtml(name)}" como pessoa (PEP/sanções)</button></article>` : "");
      $("#director-screening-btn")?.addEventListener("click", () => runPersonSearch({ name }));
      return;
    }
    list.innerHTML = people
      .map((p) => `
        <article class="news-card target-card director-row selectable" data-person-id="${escapeHtml(p.id)}">
          <div class="card-body">
            <div class="card-head">
              ${TARGET_ICO}
              <div>
                <strong>${escapeHtml(p.full_name)}</strong>
                <span class="card-sub">${escapeHtml(p.role || "Dirigente")}</span>
              </div>
              <span class="card-prio">${escapeHtml(p.agency || "?")}</span>
            </div>
          </div>
          ${cardFoot("var(--red)", p.agency || "Agência", "LINCE//DIR")}
        </article>`)
      .join("");
    list.querySelectorAll(".director-row").forEach((el) => {
      el.addEventListener("click", () => openDirectorDossier(el.dataset.personId));
    });
  } catch (error) {
    list.innerHTML = emptyCard("Diretores", `Falha: ${error.message}`);
  }
}

// Abre o dossie completo de um diretor por id.
async function openDirectorDossier(id) {
  const list = $("#directors-list");
  if (!list) return;
  list.innerHTML = emptyCard("Diretores", "Montando dossie...");
  try {
    // Busca o dossie e o risco politico em paralelo (o risco degrada se falhar).
    const [dRes, prRes] = await Promise.allSettled([
      requestJson(`/api/dossier-person?id=${encodeURIComponent(id)}`),
      requestJson(`/api/intelligence?type=political_risk&id=${encodeURIComponent(id)}`)
    ]);
    if (dRes.status !== "fulfilled") throw dRes.reason;
    const d = dRes.value;
    const pr = prRes.status === "fulfilled" && prRes.value?.ok ? prRes.value : null;
    const intel = d.intelligence || {};
    const mandates = (d.mandates || []).map((m) => `<span class="entity-pill">${escapeHtml(m.agencies?.acronym || "")} ${escapeHtml(m.role || "")}</span>`).join("");
    const parties = (d.party_links || []).map((p) => `<span class="entity-pill">${escapeHtml(p.party)}</span>`).join("");
    const rels = (d.relationships || []).length;
    const socios = (d.relationships || []).filter((r) => r.relationship === "socio").length;
    const ties = intel.corporate_ties ?? socios;
    const tiesPill = ties ? `<span class="entity-pill${intel.corporate_inactive ? " score-high" : ""}">${ties} vínculo(s) societário(s)${intel.corporate_inactive ? ` · ${intel.corporate_inactive} inapta(s)` : ""}</span>` : "";
    list.innerHTML = `
      <article class="news-card">
        <button type="button" class="entity-pill" id="director-back">&larr; Voltar a lista</button>
        <span class="source-meta">${escapeHtml(d.person.full_name)} | ${escapeHtml(d.person.role || "dirigente")}</span>
        <strong>Score de captura: ${intel.capture_score ?? "-"}/100 | Votos vencidos: ${intel.dissent_votes ?? 0}</strong>
        <p>Mandato ativo: ${intel.active_mandate ? "sim" : "nao"} | Conexoes: ${rels} | SIAPE: ${(d.siape || []).length} registro(s)</p>
        <div class="entity-row">${mandates}${parties}${tiesPill}</div>
        <div class="entity-row">
          <button type="button" class="alert-btn primary" id="director-export">Exportar PDF</button>
        </div>
      </article>
      ${renderPoliticalRisk(pr)}
      ${renderCorporateNetwork(d)}
      ${renderPersonPatrimony(d, socios)}`;
    $("#director-back")?.addEventListener("click", () => loadDirectors());
    $("#director-export")?.addEventListener("click", () => exportPersonPdf(d));
  } catch (error) {
    list.innerHTML = emptyCard("Diretores", `Falha: ${error.message}`);
  }
}

// Patrimônio declarado (TSE) + vínculos societários no dossiê de pessoa.
function renderPersonPatrimony(d, socios) {
  const assets = d.assets?.items || [];
  const totals = d.assets?.total_by_year || {};
  const weakMatch = d.assets?.weak_match;
  if (!assets.length) {
    return `
      <article class="dossier-item empty">
        <span class="field-source">Patrimônio (TSE)</span>
        <strong>Sem bens declarados na base local</strong>
        <p>Rode load:tse-bens com os dumps do TSE (consulta_cand + bem_candidato) para popular.</p>
      </article>`;
  }
  const totalsLine = Object.entries(totals)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([year, total]) => `<span class="entity-pill">${escapeHtml(year)}: ${escapeHtml(money(total))}</span>`)
    .join("");
  return `
    <article class="news-card">
      <span class="source-meta">Patrimônio declarado ao TSE${weakMatch ? " | match por nome (possível homônimo)" : ""}</span>
      <strong>${assets.length} bem(ns) declarado(s)</strong>
      ${weakMatch ? `<div class="activity-alert info"><span class="alert-icon">ℹ</span><span style="font-size:.78rem">Vínculo por nome normalizado — confirme antes de citar (homônimos possíveis).</span></div>` : ""}
      <div class="entity-row" style="margin-bottom:8px">${totalsLine}</div>
      <div style="overflow-x:auto">
        <table class="data-table assets-table">
          <thead><tr><th>Bem</th><th>Valor</th><th>Ano</th></tr></thead>
          <tbody>${assets.slice(0, 30).map((a) => `
            <tr>
              <td>${escapeHtml([a.asset_type, a.description].filter(Boolean).join(" — ").slice(0, 120))}</td>
              <td>${escapeHtml(money(a.value))}</td>
              <td>${escapeHtml(String(a.reference_year || "-"))}</td>
            </tr>`).join("")}</tbody>
        </table>
      </div>
      ${socios ? `<div class="entity-row"><span class="entity-pill">${socios} participação(ões) societária(s) na base local</span></div>` : ""}
    </article>`;
}

// Rede societária (QSA): empresas em que a pessoa figura como sócia.
function renderCorporateNetwork(d) {
  const cn = d.corporate_network || { companies: [], count: 0, inactive_count: 0 };
  if (!cn.count) {
    return `
      <article class="dossier-item empty">
        <span class="field-source">Rede societária (QSA)</span>
        <strong>Sem vínculos societários na base local</strong>
        <p>Investigue um CNPJ desta pessoa (aba Investigar) ou rode backfill:qsa / load:receita-socio para popular.</p>
      </article>`;
  }
  const statusPill = (s) => {
    if (!s) return "";
    const inactive = !/ativ/i.test(s);
    return `<span class="entity-pill${inactive ? " score-high" : " score-low"}">${escapeHtml(s)}</span>`;
  };
  return `
    <article class="news-card">
      <span class="source-meta">Rede societária (Receita/QSA)</span>
      <strong>${cn.count} participação(ões) societária(s)</strong>
      <div class="entity-row" style="margin-bottom:8px">
        <span class="entity-pill">${cn.count} empresa(s)</span>
        ${cn.inactive_count ? `<span class="entity-pill score-high">${cn.inactive_count} inapta(s)/baixada(s)</span>` : `<span class="entity-pill score-low">todas ativas</span>`}
      </div>
      <div style="overflow-x:auto">
        <table class="data-table">
          <thead><tr><th>CNPJ</th><th>Razão social</th><th>Situação</th><th>Qualificação</th><th>Entrada</th></tr></thead>
          <tbody>${cn.companies.slice(0, 40).map((c) => `
            <tr>
              <td>${escapeHtml(c.cnpj ? formatCnpj(c.cnpj) : "-")}</td>
              <td>${escapeHtml(c.legal_name || c.trade_name || "-")}</td>
              <td>${statusPill(c.registration_status) || "-"}</td>
              <td>${escapeHtml(c.role || "-")}</td>
              <td>${escapeHtml(String(c.data_entrada || "-"))}</td>
            </tr>`).join("")}</tbody>
        </table>
      </div>
    </article>`;
}

// Selo de risco político (inteligência política estilo Arko). pr pode ser null.
function renderPoliticalRisk(pr) {
  if (!pr || !pr.ok) return "";
  const score = Number(pr.score) || 0;
  const color = score < 40 ? "var(--green)" : score < 70 ? "var(--yellow)" : "var(--red)";
  const bandLabel = { alto: "ALTO", medio: "MÉDIO", baixo: "BAIXO" }[pr.band] || String(pr.band || "").toUpperCase();
  const COMP_LABEL = {
    partidario: "Partidário/doações",
    porta_giratoria: "Porta giratória",
    rede_societaria: "Rede societária",
    empresas_inaptas: "Empresas inaptas"
  };
  const comps = Object.entries(pr.components || {})
    .map(([k, v]) => `<span class="entity-pill ${v > 0 ? "score-mid" : "score-low"}">${escapeHtml(COMP_LABEL[k] || k)}: ${Number(v) || 0}</span>`)
    .join("");
  return `
    <article class="news-card">
      <span class="source-meta">Risco político (sinais de captura)</span>
      <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:6px">
        <span style="font-size:1.6rem;font-weight:800;color:${color}">${score}</span>
        <span style="font-size:.8rem;opacity:.6">/ 100 · risco ${escapeHtml(bandLabel)}</span>
      </div>
      <div class="score-bar-wrap"><div class="score-bar-fill" style="width:${score}%"></div></div>
      <div class="entity-row" style="margin-top:8px">${comps}</div>
    </article>`;
}

// ══════════════════ Central de Monitoramento (M10) ═════════════════════════
// Monitores de vigilância estilo Arko Alerta: o matcher roda a cada ingestão
// do DOU e gera alertas com alert_type='monitor'.
const MONITOR_TYPE_LABEL = { keyword: "Palavra-chave", person: "Pessoa", company: "Empresa", agency: "Agência" };
const MONITOR_TYPE_COLOR = { keyword: "var(--blue)", person: "var(--green)", company: "var(--blue-bright)", agency: "var(--purple)" };

// Radar legislativo (M12): busca proposicoes da Camara/Senado sob demanda.
// Chamada sem termo (ao entrar na view) mostra o estado inicial; com termo, busca.
async function loadLegislativo(q) {
  const list = $("#legislativo-list");
  if (!list) return;
  const term = (q || "").trim();
  if (!term) {
    list.innerHTML = emptyCard("Legislativo", "Digite um tema (ex.: energia, saneamento) e clique em Buscar.");
    return;
  }
  const casa = $("#leg-casa")?.value || "both";
  list.innerHTML = emptyCard("Legislativo", `Buscando "${escapeHtml(term)}" na Câmara e Senado...`);
  try {
    const payload = await requestJson(
      `/api/rss-feeds?type=proposicoes&casa=${encodeURIComponent(casa)}&q=${encodeURIComponent(term)}`
    );
    renderLegislativo(payload.items || []);
  } catch (err) {
    list.innerHTML = emptyCard("Legislativo", `Falha na busca: ${escapeHtml(err?.message || "erro")}`);
  }
}

function renderLegislativo(items) {
  const list = $("#legislativo-list");
  if (!list) return;
  if (!items.length) {
    list.innerHTML = emptyCard("Legislativo", "Nenhuma proposição encontrada para esse tema.");
    return;
  }
  list.innerHTML = items
    .map((p) => {
      const url = safeUrl(p.url);
      return `
      <article class="news-card target-card">
        <div class="card-body">
          <div class="card-head">
            ${TARGET_ICO}
            <div>
              <strong>${escapeHtml(p.titulo || `${p.tipo || ""} ${p.numero || ""}`)}</strong>
              <span class="card-sub">${escapeHtml(p.casa || "")}${p.autor ? " · " + escapeHtml(p.autor) : ""}</span>
            </div>
          </div>
          <p>${escapeHtml((p.ementa || "Sem ementa.").slice(0, 300))}</p>
          <div class="entity-row">
            <span class="entity-pill">${escapeHtml(p.casa || "")}</span>
            ${p.tipo ? `<span class="entity-pill">${escapeHtml(p.tipo)}</span>` : ""}
            ${url ? `<a class="entity-pill" href="${escapeHtml(url)}" target="_blank" rel="noopener">Abrir ↗</a>` : ""}
          </div>
        </div>
        ${cardFoot("var(--purple)", (p.casa || "Legislativo"), "LINCE//LEG")}
      </article>`;
    })
    .join("");
}

// Radar de Risco & Oportunidade (M13): sintetiza captura/porta-giratória,
// contratos a vencer, consultas abertas e proposições recentes.
async function loadRadar() {
  const risksEl = $("#radar-risks"), oppEl = $("#radar-opportunities"), legEl = $("#radar-legislative");
  const corrEl = $("#radar-correlations"), anomEl = $("#radar-anomalies");
  if (!risksEl) return;
  if (corrEl) corrEl.innerHTML = emptyCard("Conexões", "Cruzando sinais...");
  risksEl.innerHTML = emptyCard("Riscos", "Carregando radar...");
  if (anomEl) anomEl.innerHTML = emptyCard("Movimentos", "Analisando padrões semanais...");
  if (oppEl) oppEl.innerHTML = emptyCard("Oportunidades", "Carregando...");
  if (legEl) legEl.innerHTML = "";

  // Tres motores em paralelo; cada painel degrada sozinho.
  const [radarRes, corrRes, anomRes] = await Promise.allSettled([
    requestJson("/api/intelligence?type=radar_intel"),
    requestJson("/api/intelligence?type=correlations"),
    requestJson("/api/intelligence?type=trends_anomalies")
  ]);

  if (radarRes.status === "fulfilled") {
    const r = radarRes.value;
    renderRadarRisks(r.risks || []);
    renderRadarOpportunities(r.opportunities || []);
    renderRadarLegislative(r.legislative || []);
    const rc = $("#radar-risk-count"), oc = $("#radar-opp-count");
    if (rc) { rc.hidden = !(r.risks || []).length; rc.textContent = String((r.risks || []).length); }
    if (oc) { oc.hidden = !(r.opportunities || []).length; oc.textContent = String((r.opportunities || []).length); }
  } else {
    risksEl.innerHTML = emptyCard("Riscos", `Falha: ${escapeHtml(radarRes.reason?.message || "erro")}. Verifique ingestões/migração.`);
    if (oppEl) oppEl.innerHTML = "";
  }

  if (corrEl) {
    if (corrRes.status === "fulfilled") {
      renderRadarCorrelations(corrRes.value.correlations || []);
      const cc = $("#radar-corr-count");
      if (cc) { cc.hidden = !(corrRes.value.correlations || []).length; cc.textContent = String((corrRes.value.correlations || []).length); }
    } else corrEl.innerHTML = emptyCard("Conexões", `Falha: ${escapeHtml(corrRes.reason?.message || "erro")}`);
  }

  if (anomEl) {
    if (anomRes.status === "fulfilled") {
      renderRadarAnomalies(anomRes.value.anomalies || []);
      const ac = $("#radar-anom-count");
      if (ac) { ac.hidden = !(anomRes.value.anomalies || []).length; ac.textContent = String((anomRes.value.anomalies || []).length); }
    } else anomEl.innerHTML = emptyCard("Movimentos", `Falha: ${escapeHtml(anomRes.reason?.message || "erro")}`);
  }
}

// Conexões críticas: correlações de sinais com evidências rastreáveis.
function renderRadarCorrelations(items) {
  const el = $("#radar-correlations");
  if (!el) return;
  if (!items.length) { el.innerHTML = emptyCard("Conexões", "Nenhuma correlação crítica com os dados atuais (rode as ingestões e backfill:qsa para ampliar a base)."); return; }
  const KIND_LABEL = {
    nomeacao_x_fornecedor: "nomeação × fornecedor",
    dirigente_x_inapta: "dirigente × empresa inapta",
    janela_regulatoria: "janela regulatória",
    monitor_x_vinculos: "monitor × vínculos"
  };
  el.innerHTML = items.slice(0, 20).map((c) => {
    const sev = c.severity === "high" ? "high" : c.severity === "medium" ? "mid" : "low";
    const personEnt = (c.entities || []).find((e) => e.kind === "person" && e.id);
    return `
    <article class="news-card target-card${personEnt ? " selectable corr-person" : ""}"${personEnt ? ` data-person-id="${escapeHtml(personEnt.id)}"` : ""}>
      <div class="card-body">
        <div class="card-head">
          ${TARGET_ICO}
          <div><strong>${escapeHtml(c.title || "Correlação")}</strong>
          <span class="card-sub">${escapeHtml(KIND_LABEL[c.kind] || c.kind || "")}</span></div>
          <span class="card-prio">${c.severity === "high" ? "ALTA" : c.severity === "medium" ? "MÉDIA" : "BAIXA"}</span>
        </div>
        ${(c.evidence || []).slice(0, 4).map((ev) => `<p style="margin:2px 0;font-size:.8rem">· ${escapeHtml(ev)}</p>`).join("")}
        <div class="entity-row">
          ${c.suggested_action ? `<span class="entity-pill score-${sev}">${escapeHtml(c.suggested_action)}</span>` : ""}
          ${personEnt ? `<span class="entity-pill">Abrir dossiê →</span>` : ""}
        </div>
      </div>
      ${cardFoot(c.severity === "high" ? "var(--red)" : "var(--yellow)", KIND_LABEL[c.kind] || "correlação", "LINCE//CORR")}
    </article>`;
  }).join("");
  // Clique numa conexão com pessoa abre o dossiê dela (na view Diretores).
  el.querySelectorAll(".corr-person").forEach((card) => card.addEventListener("click", () => {
    const id = card.dataset.personId;
    if (!id) return;
    setView("directors");
    openDirectorDossier(id);
  }));
}

// Movimentos anômalos: picos e silêncios semanais por agência.
function renderRadarAnomalies(items) {
  const el = $("#radar-anomalies");
  if (!el) return;
  if (!items.length) { el.innerHTML = emptyCard("Movimentos", "Nenhum pico ou silêncio anômalo nesta semana."); return; }
  const METRIC_LABEL = { total: "atividade", norma: "normas", ato_pessoal: "atos de pessoal", contrato: "contratos" };
  el.innerHTML = items.slice(0, 15).map((a) => {
    const isSpike = a.kind === "pico";
    return `
    <article class="news-card target-card">
      <div class="card-body">
        <div class="card-head">
          ${TARGET_ICO}
          <div><strong>${escapeHtml(a.agency)}: ${escapeHtml(METRIC_LABEL[a.metric] || a.metric)} ${isSpike ? `${escapeHtml(String(a.ratio))}× acima do padrão ↗` : "zeraram esta semana ↓"}</strong>
          <span class="card-sub">semana atual: ${a.current} · baseline: ${a.baseline}/sem</span></div>
          <span class="card-prio">${isSpike ? "PICO" : "SILÊNCIO"}</span>
        </div>
        <div class="entity-row">
          <span class="entity-pill score-${isSpike ? "high" : "mid"}">${isSpike ? "algo está se movendo nesta agência" : "queda abrupta de publicação"}</span>
        </div>
      </div>
      ${cardFoot(isSpike ? "var(--red)" : "var(--yellow)", isSpike ? "pico" : "silêncio", "LINCE//ANOM")}
    </article>`;
  }).join("");
}

function renderRadarRisks(items) {
  const el = $("#radar-risks");
  if (!items.length) { el.innerHTML = emptyCard("Riscos", "Nenhum risco de captura detectado (ou faltam dados de mandatos/sócios)."); return; }
  el.innerHTML = items.map((x) => `
    <article class="news-card target-card">
      <div class="card-body">
        <div class="card-head">
          ${TARGET_ICO}
          <div><strong>${escapeHtml(x.name || "?")}</strong><span class="card-sub">${escapeHtml(x.agency || "")}${x.role ? " · " + escapeHtml(x.role) : ""}</span></div>
          <span class="card-prio">${x.inaptas ? "ALTO" : "MÉDIO"}</span>
        </div>
        <div class="entity-row">
          <span class="entity-pill score-${x.inaptas ? "high" : "mid"}">${x.companies} empresa(s)${x.inaptas ? ` · ${x.inaptas} inapta(s)` : ""}</span>
          <span class="entity-pill">porta giratória</span>
        </div>
      </div>
      ${cardFoot(x.inaptas ? "var(--red)" : "var(--yellow)", "captura", "LINCE//RISCO")}
    </article>`).join("");
}

function renderRadarOpportunities(items, sel = "#radar-opportunities") {
  const el = $(sel);
  if (!el) return;
  if (!items.length) { el.innerHTML = emptyCard("Oportunidades", "Sem contratos a vencer nem consultas abertas na janela."); return; }
  el.innerHTML = items.map((x) => {
    const isContract = x.kind === "contrato_vencendo";
    const meta = isContract
      ? `${escapeHtml(x.agency || "")}${x.value ? " · " + escapeHtml(money(x.value)) : ""} · vence ${escapeHtml(x.ends_at || "-")}`
      : `${escapeHtml(x.agency || "")} · ${escapeHtml(x.date || "-")}`;
    const url = safeUrl(x.link);
    return `
    <article class="news-card target-card">
      <div class="card-body">
        <div class="card-head">
          ${TARGET_ICO}
          <div><strong>${escapeHtml((x.label || "").slice(0, 120))}</strong><span class="card-sub">${meta}</span></div>
          <span class="card-prio">${isContract ? "CONTRATO" : "CONSULTA"}</span>
        </div>
        <div class="entity-row">
          ${x.supplier ? `<span class="entity-pill">${escapeHtml(x.supplier)}</span>` : ""}
          ${url ? `<a class="entity-pill" href="${escapeHtml(url)}" target="_blank" rel="noopener">Abrir ↗</a>` : ""}
        </div>
      </div>
      ${cardFoot("var(--green)", isContract ? "contrato a vencer" : "consulta aberta", "LINCE//OPORT")}
    </article>`;
  }).join("");
}

function renderRadarLegislative(items) {
  const el = $("#radar-legislative");
  if (!el) return;
  if (!items.length) { el.innerHTML = emptyCard("Legislativo", "Sem proposições recentes."); return; }
  el.innerHTML = items.map((p) => {
    const url = safeUrl(p.url);
    return `
    <article class="news-card">
      <span class="source-meta">${escapeHtml(p.casa || "")}</span>
      <strong>${escapeHtml(p.titulo || "Proposição")}</strong>
      <p>${escapeHtml((p.ementa || "").slice(0, 180))}</p>
      ${url ? `<div class="entity-row"><a class="entity-pill" href="${escapeHtml(url)}" target="_blank" rel="noopener">Abrir ↗</a></div>` : ""}
    </article>`;
  }).join("");
}

async function loadMonitors() {
  const list = $("#monitors-list");
  const feed = $("#monitor-alerts");
  if (!list) return;
  list.innerHTML = emptyCard("Monitores", "Carregando monitores...");
  if (feed) feed.innerHTML = emptyCard("Alertas", "Carregando disparos...");
  const [monitors, alerts] = await Promise.allSettled([
    requestJson("/api/intelligence?type=monitors"),
    requestJson("/api/intelligence?type=monitor_alerts&limit=30")
  ]);
  if (monitors.status === "fulfilled") {
    renderMonitorCards(monitors.value.items || []);
  } else {
    list.innerHTML = emptyCard("Monitores", `Falha: ${monitors.reason?.message || "erro"}. A tabela monitors existe? Rode a migração (Fase 5) no Supabase.`);
  }
  if (feed) {
    if (alerts.status === "fulfilled") renderMonitorAlerts(alerts.value.items || []);
    else feed.innerHTML = emptyCard("Alertas", `Falha: ${alerts.reason?.message || "erro"}`);
  }
}

function renderMonitorCards(monitors) {
  const list = $("#monitors-list");
  const count = $("#monitors-count");
  if (count) {
    const actives = monitors.filter((m) => m.active).length;
    count.hidden = !monitors.length;
    count.textContent = `${actives} ativo${actives === 1 ? "" : "s"}`;
  }
  if (!monitors.length) {
    list.innerHTML = emptyCard("Monitores", "Nenhum monitor criado. Use o formulário acima — leva menos de 1 minuto.");
    return;
  }
  list.innerHTML = monitors
    .map((m) => `
      <article class="news-card target-card monitor-card${m.active ? "" : " inactive"}" data-monitor-id="${escapeHtml(m.id)}">
        <div class="card-body">
          <div class="card-head">
            ${TARGET_ICO}
            <div>
              <strong>${escapeHtml(m.label)}</strong>
              <span class="card-sub">${escapeHtml(MONITOR_TYPE_LABEL[m.kind] || m.kind)} · <code>${escapeHtml(m.pattern)}</code></span>
            </div>
            <span class="card-prio">${m.hit_count ?? 0} hit${(m.hit_count ?? 0) === 1 ? "" : "s"}</span>
          </div>
          <div class="entity-row">
            <span class="entity-pill">${m.last_hit_at ? `Último disparo: ${escapeHtml(String(m.last_hit_at).slice(0, 10))}` : "Nunca disparou"}</span>
            <label class="switch-wrap" title="${m.active ? "Desativar" : "Ativar"}">
              <input type="checkbox" class="mon-toggle" ${m.active ? "checked" : ""} />
              <span class="switch"></span>
            </label>
            <button type="button" class="alert-btn mon-delete">Excluir</button>
          </div>
        </div>
        ${cardFoot(MONITOR_TYPE_COLOR[m.kind] || "var(--muted)", MONITOR_TYPE_LABEL[m.kind] || "Monitor", "LINCE//MON")}
      </article>`)
    .join("");
}

function renderMonitorAlerts(items) {
  const feed = $("#monitor-alerts");
  if (!feed) return;
  if (!items.length) {
    feed.innerHTML = emptyCard("Alertas", "Nenhum alerta disparado ainda. Os monitores rodam junto com a ingestão diária do DOU.");
    return;
  }
  feed.innerHTML = items
    .map((a) => `
      <article class="news-card target-card">
        <div class="card-body">
          <div class="card-head">
            <div>
              <strong>${escapeHtml(a.title || "Monitor")}</strong>
              <span class="card-sub">${escapeHtml((a.created_at || "").slice(0, 10))}${a.acknowledged_at ? " · dispensado" : ""}</span>
            </div>
            <span class="card-prio">${escapeHtml(a.metadata?.agency_acronym || "DOU")}</span>
          </div>
          <p>${escapeHtml(a.body || "")}</p>
        </div>
        ${cardFoot(a.severity === "high" ? "var(--red)" : "var(--yellow)", `match: ${a.metadata?.matched || "texto"}`, "LINCE//MON")}
      </article>`)
    .join("");
}

async function saveMonitorFromForm(event) {
  event.preventDefault();
  const button = event.target.querySelector("button[type=submit]");
  const label = $("#mon-name")?.value?.trim();
  const kind = $("#mon-type")?.value;
  const pattern = $("#mon-pattern")?.value?.trim();
  if (!pattern) return;
  button.disabled = true;
  button.textContent = "Criando...";
  try {
    await postJson("/api/intelligence?type=monitor_save", {
      kind,
      label: label || pattern,
      pattern,
      active: $("#mon-active")?.checked ?? true
    });
    event.target.reset();
    const active = $("#mon-active");
    if (active) active.checked = true;
    await loadMonitors();
  } catch (error) {
    $("#monitors-list").insertAdjacentHTML("afterbegin", `<div class="activity-alert"><span class="alert-icon">⚠</span><span style="font-size:.78rem">${escapeHtml(error.message)}</span></div>`);
  } finally {
    button.disabled = false;
    button.textContent = "Criar monitor";
  }
}

function wireMonitorList() {
  const list = $("#monitors-list");
  if (!list) return;
  list.addEventListener("change", async (event) => {
    const toggle = event.target.closest(".mon-toggle");
    if (!toggle) return;
    const card = toggle.closest("[data-monitor-id]");
    const id = card?.dataset.monitorId;
    if (!id) return;
    const wanted = toggle.checked;
    card.classList.toggle("inactive", !wanted);
    try {
      await postJson("/api/intelligence?type=monitor_toggle", { id, active: wanted });
    } catch {
      toggle.checked = !wanted;
      card.classList.toggle("inactive", wanted);
    }
  });
  list.addEventListener("click", async (event) => {
    const del = event.target.closest(".mon-delete");
    if (!del) return;
    const card = del.closest("[data-monitor-id]");
    const id = card?.dataset.monitorId;
    if (!id || !confirm("Excluir este monitor? O histórico de hits será perdido.")) return;
    del.disabled = true;
    try {
      await postJson("/api/intelligence?type=monitor_delete", { id });
      card.style.transition = "opacity .3s";
      card.style.opacity = "0";
      setTimeout(() => card.remove(), 320);
    } catch (error) {
      del.disabled = false;
      alert(`Falha ao excluir: ${error.message}`);
    }
  });
}

// ══════════════════ Dossiê exportável (versão de impressão) ════════════════
// Estratégia: #print-root oculto + window.print() — sem popup blocker, um CSS
// só (@media print). O resumo executivo IA nunca bloqueia a exportação.

function printItemsTable(items) {
  return `<table class="print-table">
    <thead><tr><th>Campo</th><th>Valor</th><th>Fonte</th></tr></thead>
    <tbody>${items.map((entry) => `
      <tr>
        <td>${escapeHtml(entry.label)}</td>
        <td>${escapeHtml(entry.value)}</td>
        <td>${escapeHtml(entry.source || "")}</td>
      </tr>`).join("")}</tbody>
  </table>`;
}

function sourceNamesInUse() {
  const used = new Set();
  for (const [id, runtime] of Object.entries(state.sources)) {
    if (runtime?.status === "connected" || runtime?.status === "empty") {
      const meta = sourceStatus.find((s) => s.id === id);
      used.add(meta?.name || id);
    }
  }
  return used.size ? [...used] : ["Fontes públicas conectadas"];
}

function buildPrintDoc({ title, subtitle, classification, ai, sections, sourcesUsed, kicker }) {
  const summaryBlock = ai?.summary
    ? `<section class="print-summary">
        <h2>Resumo executivo (IA)</h2>
        <p>${escapeHtml(ai.summary)}</p>
        ${(ai.risk_flags || []).length ? `<p><strong>Riscos:</strong> ${ai.risk_flags.map((r) => escapeHtml(r)).join(" · ")}</p>` : ""}
        ${(ai.highlights || []).length ? `<p><strong>Destaques:</strong> ${ai.highlights.map((h) => escapeHtml(h)).join(" · ")}</p>` : ""}
      </section>`
    : `<section class="print-summary"><h2>Resumo executivo</h2><p>Resumo por IA indisponível (configure ANTHROPIC_API_KEY para habilitar).</p></section>`;
  return `
    <div class="print-doc">
      <div class="print-class-bar">${escapeHtml(classification)} — USO RESTRITO</div>
      <header class="print-head">
        <div>
          <p class="print-kicker">${escapeHtml(kicker || "LINCE · INTELIGÊNCIA REGULATÓRIA · REAL-ONLY")}</p>
          <h1>${escapeHtml(title)}</h1>
          <p class="print-sub">${escapeHtml(subtitle)}</p>
        </div>
        <div class="print-badge"><span>Classificação</span><strong>${escapeHtml(classification)}</strong></div>
      </header>
      ${summaryBlock}
      ${sections.map((s) => `<section class="print-section"><h2>${escapeHtml(s.heading)}</h2>${s.html}</section>`).join("")}
      <footer class="print-foot">
        <p>Fontes consultadas: ${sourcesUsed.map((s) => escapeHtml(s)).join(" · ")}</p>
        <p>Gerado em ${new Date().toLocaleString("pt-BR")} · LINCE real-only — sem dados fictícios · ${escapeHtml(classification)}</p>
      </footer>
    </div>`;
}

function runPrint(html) {
  const root = $("#print-root");
  if (!root) return;
  root.innerHTML = html;
  requestAnimationFrame(() => window.print());
}

window.addEventListener("afterprint", () => {
  const root = $("#print-root");
  if (root) root.innerHTML = "";
});

// Empresa: dossiê montado em state; resumo IA via POST exec_summary.
async function exportDossierPdf() {
  if (!state.target) return;
  const btn = $("#export-dossier");
  if (btn) { btn.disabled = true; btn.textContent = "Gerando..."; }
  const compact = {
    kind: "company",
    company: { name: state.target.legalName, cnpj: formatCnpj(state.target.cnpj), status: state.target.status },
    dossier: Object.fromEntries(Object.entries(state.dossier).filter(([, v]) => (v || []).length)),
    screening_flags: state.screening?.flags || null,
    holdings: state.holdings
  };
  const ai = await postJson("/api/intelligence?type=exec_summary", compact).catch(() => null);
  const sections = dossierTabs
    .map(([id, label]) => ({ heading: label, items: id === "patrimony" ? [] : state.dossier[id] || [] }))
    .filter((s) => s.items.length)
    .map((s) => ({ heading: s.heading, html: printItemsTable(s.items) }));
  if (state.holdings.length) {
    sections.push({
      heading: "Patrimônio — Quadro societário local",
      html: printItemsTable(state.holdings.map((h) => item(h.name, h.role, h.source)))
    });
  }
  runPrint(buildPrintDoc({
    title: state.target.legalName || "Empresa",
    subtitle: `CNPJ ${formatCnpj(state.target.cnpj)}`,
    classification: "LINCE//REAL",
    ai,
    sections,
    sourcesUsed: sourceNamesInUse()
  }));
  if (btn) { btn.disabled = false; btn.textContent = "Exportar PDF"; }
}

// Pessoa: dossiê vem do backend; resumo IA via ?ai=1 (dossiê já montado lá).
async function exportPersonPdf(d) {
  const withAi = await requestJson(`/api/dossier-person?id=${encodeURIComponent(d.person.id)}&ai=1`).catch(() => null);
  const ai = withAi?.ai || null;
  const intel = d.intelligence || {};
  const sections = [];
  sections.push({
    heading: "Perfil",
    html: printItemsTable([
      item("Nome", d.person.full_name, "LINCE / DOU"),
      item("Cargo", d.person.role, "DOU Seção 2"),
      item("Score de captura", `${intel.capture_score ?? "-"}/100`, "LINCE"),
      item("Mandato ativo", intel.active_mandate ? "Sim" : "Não", "LINCE"),
      item("Votos divergentes", String(intel.dissent_votes ?? 0), "LINCE")
    ])
  });
  if ((d.mandates || []).length) {
    sections.push({
      heading: "Mandatos",
      html: printItemsTable(d.mandates.map((m) => item(m.agencies?.acronym || "Agência", `${m.role || ""} ${m.started_at ? `desde ${m.started_at}` : ""}`.trim(), "DOU Seção 2")))
    });
  }
  if ((d.party_links || []).length) {
    sections.push({
      heading: "Filiação partidária",
      html: printItemsTable(d.party_links.map((p) => item(p.party, p.joined_at ? `Filiado desde ${p.joined_at}` : "Filiação registrada", "TSE")))
    });
  }
  const assets = d.assets?.items || [];
  if (assets.length) {
    sections.push({
      heading: `Patrimônio declarado (TSE)${d.assets.weak_match ? " — match por nome (verificar homônimo)" : ""}`,
      html: printItemsTable(assets.slice(0, 40).map((a) => item(
        [a.asset_type, a.description].filter(Boolean).join(" — ").slice(0, 120),
        money(a.value),
        `TSE ${a.reference_year || ""}`
      )))
    });
  }
  runPrint(buildPrintDoc({
    title: d.person.full_name,
    subtitle: d.person.role || "Dirigente de agência reguladora",
    classification: "LINCE//DIR",
    ai,
    sections,
    sourcesUsed: ["DOU / INLABS", "TSE", "Portal da Transparência", "LINCE (base local)"]
  }));
}

// ══════════════════ Gerador de Dossiê Comercial (M14) ═════════════════════
// Compõe os feeds (Landscape por tema + Briefing de decisores + Memo de
// risco/oportunidade + Contraparte) num dossiê exportável em PDF — o módulo que
// transforma o motor em entregável comercial. Privado: só o operador gera.

// Abre a view: popula o dropdown de temas (uma vez) e mostra a distribuição.
async function loadGerador() {
  const sel = $("#ger-theme");
  const hint = $("#gerador-hint");
  if (!sel || state.gerador.themesLoaded) return;
  if (hint) hint.textContent = "Carregando temas do acervo…";
  try {
    const r = await requestJson("/api/intelligence?type=landscape");
    const labels = r.themes_available || [];
    const dist = Object.fromEntries((r.distribution || []).map((d) => [d.theme, d.count]));
    sel.innerHTML = `<option value="">Selecione um tema…</option>` + labels.map((t) => {
      const n = dist[t] || 0;
      return `<option value="${escapeHtml(t)}">${escapeHtml(t)}${n ? ` (${n})` : ""}</option>`;
    }).join("");
    state.gerador.themesLoaded = true;
    if (!hint) return;
    if (r.note === "themes_not_ready") {
      hint.innerHTML = `⚠️ Classificação por tema ainda não ativada. Aplique a migração <strong>documents.themes</strong> e rode <strong>backfill:themes</strong>. Já dá para gerar (o Landscape virá vazio até lá).`;
    } else {
      const top = (r.distribution || []).slice(0, 3).map((d) => `${d.theme} (${d.count})`).join(" · ");
      hint.textContent = top ? `Temas mais ativos: ${top}` : "Escolha um tema e gere o dossiê.";
    }
  } catch (e) {
    if (hint) hint.textContent = `Falha ao carregar temas: ${e.message}`;
  }
}

// Gera o dossiê: 1 GET compõe os DADOS (render imediato) + 1 POST traz a
// narrativa IA (não bloqueia). Guarda em state para o export PDF.
async function runGerador(event) {
  event?.preventDefault();
  const theme = $("#ger-theme").value;
  const agency = ($("#ger-agency").value || "").trim();
  const cnpjRaw = ($("#ger-cnpj").value || "").trim();
  const cnpj = onlyDigits(cnpjRaw);
  const days = $("#ger-window").value || "180";
  const hint = $("#gerador-hint");
  if (cnpjRaw && cnpj.length !== 14) {
    if (hint) hint.textContent = "CNPJ inválido: informe 14 dígitos (ou deixe vazio).";
    return;
  }
  if (!theme && !agency && cnpj.length !== 14) {
    if (hint) hint.textContent = "Selecione um tema (ou informe agências/CNPJ) para gerar.";
    return;
  }

  const btn = $("#gerador-form button[type=submit]");
  const exportBtn = $("#gerador-export");
  if (btn) { btn.disabled = true; btn.textContent = "Gerando…"; }
  if (exportBtn) exportBtn.hidden = true;
  $("#gerador-result").hidden = false;
  $("#ger-narrative").innerHTML = emptyCard("Leitura estratégica", "Compondo o dossiê…");
  $("#ger-landscape").innerHTML = emptyCard("Landscape", "Consultando atos por tema…");
  $("#ger-directors").innerHTML = "";
  $("#ger-risks").innerHTML = "";
  $("#ger-opportunities").innerHTML = "";
  $("#ger-counterparty-panel").hidden = true;

  const params = new URLSearchParams({ type: "deal_dossier", days });
  if (theme) params.set("theme", theme);
  if (agency) params.set("agency", agency);
  if (cnpj.length === 14) params.set("cnpj", cnpj);

  try {
    const dossier = await requestJson(`/api/intelligence?${params.toString()}`);
    state.gerador.dossier = dossier;
    state.gerador.narrative = null;
    renderGerador(dossier);
    if (exportBtn) exportBtn.hidden = false;
    // Narrativa IA (não bloqueia os dados; degrada sem chave).
    $("#ger-narrative").innerHTML = emptyCard("Leitura estratégica", "Gerando interpretação por IA…");
    const narr = await postJson("/api/intelligence?type=deal_narrative", dossier).catch(() => null);
    state.gerador.narrative = narr;
    renderGeradorNarrative(narr);
  } catch (e) {
    const msg = `Não foi possível gerar: ${e.message}`;
    $("#ger-narrative").innerHTML = emptyCard("Falha", msg);
    $("#ger-landscape").innerHTML = emptyCard("Falha", "Consulta não concluída — verifique as ingestões/migração e tente de novo.");
    $("#ger-directors").innerHTML = "";
    $("#ger-risks").innerHTML = "";
    $("#ger-opportunities").innerHTML = "";
    const lc = $("#ger-land-count"); if (lc) lc.hidden = true;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Gerar dossiê"; }
  }
}

function renderGerador(d) {
  // Mapa de Landscape (por agência).
  const landEl = $("#ger-landscape");
  const byAg = d.landscape?.by_agency || [];
  const landCount = $("#ger-land-count");
  if (landCount) { landCount.hidden = !byAg.length; landCount.textContent = String(d.landscape?.total || 0); }
  if (!byAg.length) {
    const base = d.theme ? `Nenhum ato do tema “${d.theme}” na janela.` : "Selecione um tema para o recorte por agência.";
    const needBackfill = d.landscape_ready === false ? " Classificação por tema ainda não ativada — rode a migração + backfill:themes." : "";
    landEl.innerHTML = emptyCard("Mapa de Landscape", base + needBackfill);
  } else {
    const maxN = Math.max(...byAg.map((a) => a.count), 1);
    landEl.innerHTML = byAg.map((a) => {
      const pct = Math.round(100 * a.count / maxN);
      const recent = (a.recent || []).slice(0, 3).map((it) => {
        const url = safeUrl(it.link);
        const t = escapeHtml((it.title || "").slice(0, 110));
        return `<li>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${t}</a>` : t} <span class="ger-muted">${escapeHtml(it.date || "")}</span></li>`;
      }).join("");
      return `
      <article class="dossier-item">
        <div class="ger-land-head"><strong>${escapeHtml(a.agency || "?")}</strong><span class="ger-count">${a.count}</span></div>
        <div class="ger-bar"><span style="width:${pct}%"></span></div>
        ${recent ? `<ul class="ger-recent">${recent}</ul>` : ""}
      </article>`;
    }).join("");
  }

  // Briefing de decisores.
  const dirEl = $("#ger-directors");
  const dirs = d.directors || [];
  if (!dirs.length) {
    dirEl.innerHTML = emptyCard("Decisores", d.target_agencies?.length ? "Sem dirigentes ativos cadastrados nas agências-alvo." : "Defina tema/agências para listar os decisores.");
  } else {
    dirEl.innerHTML = dirs.slice(0, 20).map((p) => {
      const meta = [p.agency, p.role].filter(Boolean).join(" · ");
      const links = p.socio_links ? `${p.socio_links} vínculo(s) societário(s)${p.inaptas ? ` · ${p.inaptas} inapta(s)` : ""}` : "sem vínculo societário na base";
      const sev = p.inaptas ? "var(--red)" : p.socio_links ? "var(--yellow)" : "var(--green)";
      return `
      <article class="news-card">
        <span class="source-meta">${escapeHtml(meta || "Dirigente")}</span>
        <strong>${escapeHtml(p.name || "?")}</strong>
        <p>${escapeHtml(links)}${p.since ? ` · desde ${escapeHtml(p.since)}` : ""}</p>
        ${cardFoot(sev, "decisor", "LINCE//DIR")}
      </article>`;
    }).join("");
  }

  // Memo — riscos.
  const riskEl = $("#ger-risks");
  const risks = d.risks || [];
  if (!risks.length) {
    riskEl.innerHTML = emptyCard("Riscos", "Sem sinais de porta-giratória entre os decisores das agências-alvo.");
  } else {
    riskEl.innerHTML = risks.slice(0, 20).map((r) => `
      <article class="news-card">
        <span class="source-meta">${escapeHtml([r.agency, r.role].filter(Boolean).join(" · ") || "Risco")}</span>
        <strong>${escapeHtml(r.name || "?")}</strong>
        <p>Sócio(a) de ${r.companies} empresa(s)${r.inaptas ? ` — ${r.inaptas} inapta(s)/baixada(s)` : ""}.</p>
        ${cardFoot(r.severity === "high" ? "var(--red)" : "var(--yellow)", "captura", "LINCE//RISCO")}
      </article>`).join("");
  }

  // Memo — oportunidades (reusa o renderer do radar, apontando pro container do Gerador).
  renderRadarOpportunities(d.opportunities || [], "#ger-opportunities");

  // Contraparte (opcional).
  const cpPanel = $("#ger-counterparty-panel");
  const cpEl = $("#ger-counterparty");
  if (d.counterparty && d.counterparty.ok) {
    cpPanel.hidden = false;
    cpEl.innerHTML = renderCounterpartyHtml(d.counterparty);
  } else if (d.counterparty) {
    cpPanel.hidden = false;
    cpEl.innerHTML = emptyCard("Contraparte", `Falha: ${escapeHtml(d.counterparty.error || "não foi possível compor.")}`);
  } else {
    cpPanel.hidden = true;
  }
}

function renderCounterpartyHtml(cp) {
  const c = cp.company;
  const flags = (cp.flags || []).map((f) => `<li class="ger-flag sev-${escapeHtml(f.severity)}">${escapeHtml(f.flag)}</li>`).join("");
  const socios = (cp.socios || []).slice(0, 12).map((s) => {
    const meta = [s.papel, s.tipo, s.situacao].filter(Boolean).join(" · ");
    return `<li>${escapeHtml(s.nome || "?")} ${meta ? `<span class="ger-muted">${escapeHtml(meta)}</span>` : ""}</li>`;
  }).join("");
  return `
    <article class="dossier-item">
      <span class="field-source">Cadastro + rede societária + screening</span>
      <strong>${escapeHtml(c?.legal_name || "Empresa")}${c?.registration_status ? ` — ${escapeHtml(c.registration_status)}` : ""}</strong>
      <p>CNPJ ${escapeHtml(formatCnpj(cp.cnpj))}${c?.cnae ? ` · CNAE ${escapeHtml(c.cnae)}` : ""} · ${cp.socios_count || 0} sócio(s)</p>
      ${flags ? `<ul class="ger-flags">${flags}</ul>` : ""}
      ${socios ? `<div class="ger-sub">Quadro societário</div><ul class="ger-recent">${socios}</ul>` : ""}
    </article>`;
}

function renderGeradorNarrative(narr) {
  const el = $("#ger-narrative");
  const badge = $("#ger-narr-badge");
  if (!el) return;
  if (!narr || (!narr.summary && !(narr.scenarios || []).length)) {
    const why = narr?.skipped === "no_api_key"
      ? "Configure ANTHROPIC_API_KEY para habilitar a interpretação por IA — os dados abaixo já compõem o dossiê."
      : (narr?.error ? `IA indisponível: ${narr.error}.` : "Interpretação por IA indisponível no momento.");
    if (badge) badge.hidden = true;
    el.innerHTML = emptyCard("Leitura estratégica", why);
    return;
  }
  if (badge) badge.hidden = false;
  const list = (title, arr) => (arr && arr.length)
    ? `<div class="ger-narr-block"><h4>${title}</h4><ul>${arr.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul></div>`
    : "";
  el.innerHTML = `
    <div class="ger-narrative">
      <p class="ger-narr-summary">${escapeHtml(narr.summary || "")}</p>
      ${narr.recommendation ? `<p class="ger-narr-reco"><strong>Recomendação:</strong> ${escapeHtml(narr.recommendation)}</p>` : ""}
      ${list("Cenários prováveis", narr.scenarios)}
      ${list("Oportunidades", narr.opportunities)}
      ${list("Riscos", narr.risks)}
      ${narr.confidence ? `<p class="ger-muted">Confiança da IA: ${Math.round(narr.confidence * 100)}%</p>` : ""}
    </div>`;
}

// Exporta o dossiê comercial em PDF (reusa o motor de impressão). Marca
// comercial no cabeçalho (IRIS fora do entregável faturado).
async function exportGeradorPdf() {
  const d = state.gerador.dossier;
  if (!d) return;
  const btn = $("#gerador-export");
  if (btn) { btn.disabled = true; btn.textContent = "Gerando…"; }
  let narr = state.gerador.narrative;
  if (!narr) narr = await postJson("/api/intelligence?type=deal_narrative", d).catch(() => null);

  const sections = [];
  const byAg = d.landscape?.by_agency || [];
  if (byAg.length) {
    sections.push({
      heading: `Mapa de Landscape${d.theme ? ` — ${d.theme}` : ""}`,
      html: printItemsTable(byAg.map((a) => item(a.agency, `${a.count} iniciativa(s)`, "DOU / INLABS")))
    });
  }
  const dirs = d.directors || [];
  if (dirs.length) {
    sections.push({
      heading: "Briefing de decisores",
      html: printItemsTable(dirs.slice(0, 25).map((p) => item(
        p.name,
        `${[p.agency, p.role].filter(Boolean).join(" · ")}${p.socio_links ? ` · ${p.socio_links} vínculo(s)${p.inaptas ? `, ${p.inaptas} inapta(s)` : ""}` : ""}`,
        "DOU / Receita"
      )))
    });
  }
  const risks = d.risks || [];
  if (risks.length) {
    sections.push({
      heading: "Memo — Riscos",
      html: printItemsTable(risks.slice(0, 25).map((r) => item(
        r.name,
        `${[r.agency, r.role].filter(Boolean).join(" · ")} — sócio(a) de ${r.companies} empresa(s)${r.inaptas ? `, ${r.inaptas} inapta(s)` : ""}`,
        r.severity === "high" ? "ALTO" : "MÉDIO"
      )))
    });
  }
  const opps = d.opportunities || [];
  if (opps.length) {
    sections.push({
      heading: "Memo — Oportunidades",
      html: printItemsTable(opps.slice(0, 30).map((o) => item(
        (o.label || "").slice(0, 110),
        o.kind === "contrato_vencendo"
          ? `${o.agency || ""} · vence ${o.ends_at || "-"}${o.value ? ` · ${money(o.value)}` : ""}`
          : `${o.agency || ""} · consulta ${o.date || ""}`,
        o.kind === "contrato_vencendo" ? "PNCP" : "DOU"
      )))
    });
  }
  const cp = d.counterparty;
  if (cp && cp.ok) {
    const rows = [
      item("Razão social", cp.company?.legal_name || "-", "Receita"),
      item("CNPJ", formatCnpj(cp.cnpj), "Receita"),
      item("Situação", cp.company?.registration_status || "-", "Receita"),
      item("Sócios na base", String(cp.socios_count || 0), "Receita / QSA")
    ];
    for (const f of (cp.flags || [])) rows.push(item(`Sinal (${f.severity})`, f.flag, "LINCE"));
    sections.push({ heading: "Contraparte — Due diligence", html: printItemsTable(rows) });
  }

  // Narrativa IA -> bloco "Resumo executivo (IA)" do print.
  const ai = narr && narr.summary ? {
    summary: narr.summary,
    risk_flags: narr.risks || [],
    highlights: [
      ...(narr.recommendation ? [`Recomendação: ${narr.recommendation}`] : []),
      ...(narr.scenarios || []),
      ...(narr.opportunities || [])
    ]
  } : null;

  const themeLabel = d.theme || "Panorama regulatório";
  const agencyLabel = (d.target_agencies || []).map((a) => a.acronym).join(", ");
  runPrint(buildPrintDoc({
    title: `Dossiê Comercial — ${themeLabel}`,
    subtitle: agencyLabel ? `Agências-alvo: ${agencyLabel}` : "Panorama nas agências reguladoras",
    classification: "CONFIDENCIAL//COMERCIAL",
    kicker: "INTELIGÊNCIA REGULATÓRIA · USO COMERCIAL RESTRITO",
    ai,
    sections,
    sourcesUsed: ["DOU / INLABS", "PNCP Contratos", "Receita Federal (QSA)", "Portal da Transparência", "Câmara/Senado"]
  }));
  if (btn) { btn.disabled = false; btn.textContent = "Exportar PDF"; }
}

// ══════════════════ Consulta de pessoa (CPF ou nome) ═══════════════════════
// CPF (11 dígitos) na busca global ou prefixo "p: nome". Fontes públicas
// (Portal da Transparência) + match na base local de dirigentes.
async function runPersonSearch({ cpf, name }) {
  setView("person");
  $("#person-title").textContent = cpf ? formatCpf(cpf) : name;
  const scrEl = $("#person-screening");
  const localEl = $("#person-local");
  scrEl.innerHTML = emptyCard("Screening", "Consultando listas do Portal da Transparência...");
  localEl.innerHTML = emptyCard("Base local", "Buscando na base de diretores...");

  if (cpf) {
    try {
      const data = await requestJson(`/api/external?type=cpf&cpf=${cpf}`);
      $("#person-title").textContent = `CPF ${data.cpf_masked || formatCpf(cpf)}`;
      renderPersonScreening(data.screening);
      renderPersonLocal(data.local_matches || []);
    } catch (error) {
      scrEl.innerHTML = emptyCard("Screening", `Falha: ${error.message}`);
      localEl.innerHTML = emptyCard("Base local", "Consulta não executada.");
    }
    return;
  }

  const [scr, local] = await Promise.allSettled([
    requestJson(`/api/external?type=screening&q=${encodeURIComponent(name)}`),
    requestJson(`/api/dossier-person?q=${encodeURIComponent(name)}`)
  ]);
  if (scr.status === "fulfilled") renderPersonScreening(scr.value);
  else renderPersonScreening({ ok: false, status: scr.reason?.payload?.status, error: scr.reason?.message });
  renderPersonLocal(local.status === "fulfilled" ? local.value.people || [] : []);
}

// screening: {flags, sources} | {ok:false, status:"requires_key"} | {ok:false, error}
function renderPersonScreening(screening) {
  const el = $("#person-screening");
  if (!el) return;
  const mode = screening?.sources ? "ok" : screening?.status === "requires_key" ? "key" : "err";
  const flags = screening?.flags || {};
  const flagPills = mode === "ok"
    ? `<div class="entity-row" style="margin-bottom:10px">
        ${flags.is_pep ? `<span class="entity-pill score-high">PEP</span>` : ""}
        ${flags.has_sanctions ? `<span class="entity-pill score-high">SANCIONADO</span>` : ""}
        ${flags.is_servidor ? `<span class="entity-pill score-mid">SERVIDOR FEDERAL</span>` : ""}
        ${!flags.is_pep && !flags.has_sanctions && !flags.is_servidor ? `<span class="entity-pill score-low">SEM APONTAMENTOS</span>` : ""}
      </div>`
    : "";
  // Matches detalhados (até 5 por lista com registro).
  let details = "";
  if (mode === "ok") {
    for (const [key, label] of SCREENING_LISTS.map(([k, l]) => [k, l])) {
      const src = screening.sources[key];
      if (!src?.ok || !src.total) continue;
      details += (src.items || []).slice(0, 5).map((entry) => {
        const info = screeningMatchInfo(entry);
        return `<article class="dossier-item">
          <span class="field-source">${escapeHtml(label)} | Portal da Transparência</span>
          <strong>${escapeHtml(info.name)}</strong>
          <p>${escapeHtml(info.detail || `Registro na lista ${label}.`)}</p>
        </article>`;
      }).join("");
    }
  }
  const errNote = mode === "err" && screening?.error
    ? `<p class="screening-note">Falha na consulta: ${escapeHtml(screening.error)}</p>`
    : "";
  el.innerHTML = flagPills + renderScreeningPanel(screening, "person", mode) + errNote + details;
}

function renderPersonLocal(matches) {
  const el = $("#person-local");
  if (!el) return;
  if (!matches.length) {
    el.innerHTML = emptyCard("Base local", "Sem correspondência na base local de dirigentes.");
    return;
  }
  el.innerHTML = matches
    .map((p) => `
      <article class="news-card target-card director-row selectable" data-person-id="${escapeHtml(p.id)}">
        <div class="card-body">
          <div class="card-head">
            ${TARGET_ICO}
            <div>
              <strong>${escapeHtml(p.full_name)}</strong>
              <span class="card-sub">${escapeHtml(p.role || "Dirigente")}</span>
            </div>
            <span class="card-prio">${escapeHtml(p.agency || "?")}</span>
          </div>
        </div>
        ${cardFoot("var(--red)", p.agency || "Agência", "LINCE//DIR")}
      </article>`)
    .join("");
  el.querySelectorAll(".director-row").forEach((row) => {
    row.addEventListener("click", () => {
      setView("directors");
      openDirectorDossier(row.dataset.personId);
    });
  });
}

// Estado do grafo nacional (separado do estado do grafo CNPJ).
// allNodes/allEdges = dataset completo da agencia; nodes/edges = visiveis.
// expanded = ids ja expandidos (comportamento Sherlocker: revela vizinhos ao clicar).
const natGraph = {
  allNodes: [],
  allEdges: [],
  nodes: [],
  edges: [],
  expanded: new Set(),
  centerId: null,
  graphView: null,
  transform: { x: 80, y: 60, scale: 0.7 },
  selectedId: null,
  drag: null,
  pan: null,
  panoramic: false
};

const NAT_EXPAND_LIMIT = 80; // teto de vizinhos por expansao (legibilidade do grafo).
const NAT_PANORAMIC_MAX = 600; // teto de nos na visao panoramica (performance do Cytoscape).

// Reconstroi nodes/edges visiveis a partir do dataset completo e do conjunto expanded.
function rebuildNatVisible() {
  const allById = Object.fromEntries(natGraph.allNodes.map((n) => [n.id, n]));

  // Visao panoramica (sem filtro de agencia): mostra a rede inteira (capada por
  // performance), em vez de colapsar num no arbitrario. Evita o "2 entidades".
  if (natGraph.panoramic) {
    const capped = natGraph.allNodes.slice(0, NAT_PANORAMIC_MAX);
    const idset = new Set(capped.map((n) => n.id));
    natGraph.nodes = capped.map((n) => ({ id: n.id, type: n.type, title: n.title, subtitle: n.subtitle || "", central: false }));
    natGraph.edges = natGraph.allEdges.filter((e) => idset.has(e.from) && idset.has(e.to));
    renderNatGraph();
    return;
  }

  const visible = new Set();
  if (natGraph.centerId) visible.add(natGraph.centerId);
  for (const srcId of natGraph.expanded) {
    visible.add(srcId);
    const uniqueNeighbors = [...new Set(
      natGraph.allEdges
        .filter((e) => e.from === srcId || e.to === srcId)
        .map((e) => (e.from === srcId ? e.to : e.from))
        .filter((id) => allById[id])
    )];
    uniqueNeighbors.slice(0, NAT_EXPAND_LIMIT).forEach((id) => visible.add(id));
  }
  natGraph.nodes = [...visible].map((id) => allById[id]).filter(Boolean)
    .map((n) => ({ id: n.id, type: n.type, title: n.title, subtitle: n.subtitle || "", central: n.id === natGraph.centerId }));
  const visibleSet = new Set(visible);
  natGraph.edges = natGraph.allEdges.filter((e) => visibleSet.has(e.from) && visibleSet.has(e.to));
  renderNatGraph();
}

function ensureNatGraphView() {
  if (natGraph.graphView || !$("#nat-graph-cy")) return natGraph.graphView;
  natGraph.graphView = createGraphView({
    container: $("#nat-graph-cy"),
    legendEl: $("#nat-graph-legend"),
    onSelect: (id) => {
      natGraph.selectedId = id;
      const node = natGraph.nodes.find((n) => n.id === id);
      const title = $("#nat-inspector-title");
      if (title) title.textContent = node?.title || id;
      renderNatInspector(id).catch(() => {});
    },
    onExpand: (id) => expandNatNode(id)
  });
  return natGraph.graphView;
}

function renderNatGraph() {
  const hasNodes = natGraph.nodes.length > 0;
  if (hasNodes && !window.cytoscape) { showGraphLibError("#nat-graph-empty"); return; }
  $("#nat-graph-empty")?.classList.toggle("hidden", hasNodes);
  $("#nat-graph-legend")?.classList.toggle("hidden", !hasNodes);
  if (!hasNodes) return;
  const view = ensureNatGraphView();
  if (!view) return;
  view.setElements(natGraph.nodes, natGraph.edges);
  if (natGraph.selectedId) view.select(natGraph.selectedId);
}

// Popula o dropdown de agencias do grafo (uma vez).
let natAgenciesLoaded = false;
async function populateGraphAgencies() {
  if (natAgenciesLoaded) return;
  const sel = $("#graph-agency");
  if (!sel) return;
  try {
    const sc = await requestJson("/api/intelligence?type=score");
    const opts = `<option value="">Todas as agências</option>` +
      (sc.scores || []).map((s) => `<option value="${escapeHtml(s.agency)}">${escapeHtml(s.agency)}</option>`).join("");
    sel.innerHTML = opts;
    natAgenciesLoaded = true;
    const douSel = $("#dou-agency");
    if (douSel && douSel.options.length <= 1) {
      douSel.innerHTML = `<option value="">Todas as agencias</option>` +
        (sc.scores || []).map((s) => `<option value="${escapeHtml(s.agency)}">${escapeHtml(s.agency)}</option>`).join("");
    }
  } catch { /* silencioso */ }
}

async function loadNationalGraph() {
  await populateGraphAgencies();
  const agency = $("#graph-agency")?.value?.trim();
  const url = `/api/graph${agency ? `?agency=${encodeURIComponent(agency)}&limit=800` : "?limit=800"}`;
  try {
    const g = await requestJson(url);
    if (!g.nodes?.length) {
      natGraph.allNodes = []; natGraph.allEdges = [];
      natGraph.nodes = []; natGraph.edges = []; natGraph.expanded = new Set(); natGraph.centerId = null;
      const empty = $("#nat-graph-empty");
      if (empty) { empty.classList.remove("hidden"); empty.querySelector("p").textContent = "Sem conexões para esta agência ainda. Rode as ingestões (DOU/PNCP/Receita)."; }
      $("#nat-graph-legend")?.classList.add("hidden");
      return;
    }
    natGraph.allNodes = g.nodes.slice();
    natGraph.allEdges = g.edges.slice();
    natGraph.selectedId = null;
    if (agency) {
      // Modo focado: centraliza na agencia e revela seus vizinhos.
      natGraph.panoramic = false;
      const center = g.nodes.find((n) => n.type === "agency" && (n.subtitle || "").toUpperCase() === agency.toUpperCase());
      natGraph.centerId = center ? center.id : g.nodes[0].id;
      natGraph.expanded = new Set([natGraph.centerId]);
    } else {
      // Visao panoramica: a rede inteira (sem colapsar num no).
      natGraph.panoramic = true;
      natGraph.centerId = null;
      natGraph.expanded = new Set();
    }
    rebuildNatVisible();
    const trunc = g.meta?.truncated ? ` · amostra de ${g.meta.limit} (refine por agência)` : "";
    $("#nat-graph-title").textContent = `${natGraph.nodes.length} entidades · ${natGraph.edges.length} vínculos${trunc}`;
    natGraph.graphView?.fit();
  } catch (error) {
    const empty = $("#nat-graph-empty");
    if (empty) { empty.classList.remove("hidden"); empty.querySelector("p").textContent = `Falha: ${error.message}`; }
  }
}

// Expande um no: revela seus vizinhos diretos a partir do dataset ja carregado.
function expandNatNode(nodeId) {
  // Na visao panoramica a rede inteira ja esta visivel: expandir e no-op
  // (evita botao "Colapsar" enganoso sem revelar nada).
  if (!nodeId || natGraph.panoramic) return;
  natGraph.expanded.add(nodeId);
  rebuildNatVisible();
  $("#nat-graph-title").textContent = `${natGraph.nodes.length} entidades · ${natGraph.edges.length} vínculos`;
}

// Colapsa um no: esconde os vizinhos revelados por ele (mantem o central).
function collapseNatNode(nodeId) {
  if (!nodeId || natGraph.panoramic || nodeId === natGraph.centerId) return;
  natGraph.expanded.delete(nodeId);
  rebuildNatVisible();
  $("#nat-graph-title").textContent = `${natGraph.nodes.length} entidades · ${natGraph.edges.length} vínculos`;
}

function wireNatGraph() {
  ensureNatGraphView();
  $("#nat-zoom-in")?.addEventListener("click", () => natGraph.graphView?.zoomBy(1.2));
  $("#nat-zoom-out")?.addEventListener("click", () => natGraph.graphView?.zoomBy(1 / 1.2));
  $("#nat-fit-graph")?.addEventListener("click", () => natGraph.graphView?.fit());
  $("#nat-reset-graph")?.addEventListener("click", () => {
    // Reset volta ao no central (Sherlocker) e recarrega o layout.
    natGraph.expanded = new Set(natGraph.centerId ? [natGraph.centerId] : []);
    natGraph.selectedId = null;
    natGraph.graphView?.reset();
    rebuildNatVisible();
    natGraph.graphView?.fit();
    $("#nat-graph-title").textContent = `${natGraph.nodes.length} entidades · ${natGraph.edges.length} vínculos`;
  });
  $("#graph-agency")?.addEventListener("change", () => loadNationalGraph());
  const search = $("#graph-search");
  if (search) {
    const run = () => natGraph.graphView?.search(search.value);
    search.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
    search.addEventListener("input", debounce(() => { if (search.value.length === 0 || search.value.length >= 3) run(); }, 200));
  }
}

async function loadIntelligence() {
  const score = $("#intel-score"), radar = $("#intel-radar");
  if (score) score.innerHTML = emptyCard("Score", "Calculando...");
  if (radar) radar.innerHTML = emptyCard("Radar", "Calculando...");
  try {
    const [sc, rd, daily] = await Promise.all([
      requestJson("/api/intelligence?type=score"),
      requestJson("/api/intelligence?type=radar"),
      requestJson("/api/intelligence?type=daily")
    ]);
    // Score
    if (score) {
      if (!sc.scores?.length) { score.innerHTML = emptyCard("Score", "Sem dados. Rode a ingestao do DOU."); }
      else score.innerHTML = sc.scores.map((s) => {
        const level = s.score > 60 ? "high" : s.score > 30 ? "mid" : "low";
        const qColor = s.score > 60 ? "var(--red)" : s.score > 30 ? "var(--yellow)" : "var(--green)";
        return `
        <article class="news-card target-card">
          <div class="card-body">
            <div class="card-head">
              ${TARGET_ICO}
              <div>
                <strong>${escapeHtml(s.name)}</strong>
                <span class="card-sub">${s.docs} atos · ${s.open_alerts} alertas abertos · ${s.active_directors} diretores ativos</span>
              </div>
              <span class="card-prio">P${Math.max(1, Math.min(5, Math.ceil(s.score / 20)))}</span>
            </div>
            <div class="entity-row">
              <span class="entity-pill score-${level}">Score ${s.score}/100</span>
            </div>
          </div>
          ${cardFoot(qColor, s.agency || "Agência", `LINCE//${s.agency || "AG"}`)}
        </article>`;
      }).join("");
    }
    // Radar
    if (radar) {
      const all = [...(rd.radar?.["30d"] || []).map((i) => ({ ...i, window: "30d" })),
                   ...(rd.radar?.["60d"] || []).map((i) => ({ ...i, window: "60d" })),
                   ...(rd.radar?.["90d"] || []).map((i) => ({ ...i, window: "90d" }))];
      if (!all.length) { radar.innerHTML = emptyCard("Radar", "Nenhum contrato a vencer nos proximos 90 dias. Rode ingest-pncp."); }
      else radar.innerHTML = all.map((c) => `
        <article class="news-card target-card">
          <div class="card-body">
            <div class="card-head">
              <div>
                <strong>${escapeHtml(c.label)}</strong>
                <span class="card-sub">Vence: ${escapeHtml(c.date || "sem data")}</span>
              </div>
              <span class="card-prio">${escapeHtml(c.window)}</span>
            </div>
            <p>${escapeHtml(c.supplier || "Fornecedor nao identificado")}</p>
          </div>
          ${cardFoot(c.window === "30d" ? "var(--red)" : c.window === "60d" ? "var(--yellow)" : "var(--green)", `Vencimento ${c.window}`, `PNCP//${c.agency || "BR"}`)}
        </article>`).join("");
    }
    // Overview daily
    const dailyEl = $("#overview-daily");
    if (dailyEl && daily.by_agency) {
      const entries = Object.entries(daily.by_agency);
      if (!entries.length) { dailyEl.innerHTML = emptyCard("Diario", "Nenhum ato nas ultimas 24h. O cron roda ao meio-dia UTC."); }
      else dailyEl.innerHTML = entries.map(([ac, d]) => `
        <article class="news-card">
          <span class="source-meta">${escapeHtml(ac)} | ${d.normas} normas · ${d.pessoal} atos pessoal · ${d.contratos} contratos</span>
          ${(d.destaques || []).slice(0, 2).map((s) => `<p>${escapeHtml(s)}</p>`).join("")}
        </article>`).join("");
    }
  } catch (error) {
    if (score) score.innerHTML = emptyCard("Score", `Erro: ${error.message}`);
  }
}

async function loadConsultas() {
  const list = $("#consultas-list");
  if (!list) return;
  list.innerHTML = emptyCard("Consultas", "Buscando consultas e audiencias publicas abertas...");
  try {
    const data = await requestJson("/api/rss-feeds?type=consultas");
    if (!data.items?.length) { list.innerHTML = emptyCard("Consultas", "Nenhuma consulta identificada nos RSS das agencias no momento."); return; }
    list.innerHTML = data.items.map((c) => `
      <article class="news-card target-card">
        <div class="card-body">
          <div class="card-head">
            <div>
              <strong>${escapeHtml(c.title)}</strong>
              <span class="card-sub">${escapeHtml(c.date || "sem data")}</span>
            </div>
            <span class="card-prio">${escapeHtml(c.agency)}</span>
          </div>
          <p>${escapeHtml(c.summary || "")}</p>
          <div class="entity-row">
            ${c.link ? `<a class="entity-pill" href="${escapeHtml(c.link)}" target="_blank" rel="noreferrer">Abrir</a>` : ""}
          </div>
        </div>
        ${cardFoot("var(--green)", "Consulta pública", `RSS//${c.agency || "AGÊNCIA"}`)}
      </article>`).join("");
  } catch (error) {
    list.innerHTML = emptyCard("Consultas", `Erro: ${error.message}`);
  }
}

async function loadAgenda() {
  const list = $("#agenda-list");
  if (!list) return;
  list.innerHTML = emptyCard("Agenda", "Buscando pautas e reunioes das agencias...");
  try {
    const data = await requestJson("/api/rss-feeds?type=agenda");
    if (!data.items?.length) { list.innerHTML = emptyCard("Agenda", "Nenhuma pauta identificada nos RSS das agencias no momento."); return; }
    list.innerHTML = data.items.map((c) => `
      <article class="news-card target-card">
        <div class="card-body">
          <div class="card-head">
            <div>
              <strong>${escapeHtml(c.title)}</strong>
              <span class="card-sub">${escapeHtml(c.date || "sem data")}</span>
            </div>
            <span class="card-prio">${escapeHtml(c.agency)}</span>
          </div>
          <p>${escapeHtml(c.summary || "")}</p>
          <div class="entity-row">
            ${c.link ? `<a class="entity-pill" href="${escapeHtml(c.link)}" target="_blank" rel="noreferrer">Abrir</a>` : ""}
          </div>
        </div>
        ${cardFoot("var(--blue-bright)", "Pauta / reunião", `RSS//${c.agency || "AGÊNCIA"}`)}
      </article>`).join("");
  } catch (error) {
    list.innerHTML = emptyCard("Agenda", `Erro: ${error.message}`);
  }
}

// ══════════════════ Agenda Regulatória (M8+) ══════════════════════════════
// Board por agência: temas formais (regulatory_agenda) + atos de agenda +
// consultas abertas + pautas, do DOU já ingerido. Notícias só ao clicar.
async function loadAgendaRegulatoria() {
  const board = $("#agreg-board");
  const hint = $("#agreg-hint");
  if (!board) return;
  const sector = $("#agreg-filter")?.value || "";
  board.innerHTML = "";
  if (hint) hint.textContent = "Carregando agenda regulatória…";
  try {
    const data = await requestJson(`/api/rss-feeds?type=agenda_regulatoria${sector ? `&sector=${encodeURIComponent(sector)}` : ""}`);
    const ags = data.agencies || [];
    if (hint) {
      hint.textContent = ags.length
        ? `${ags.length} agência(s) com movimento regulatório recente.${data.temas_ready ? "" : " (Temas formais itemizados ainda não carregados — precisa do load:agenda com a IA.)"}`
        : "Sem movimento recente no DOU para este recorte.";
    }
    board.innerHTML = ags.map(renderAgregAgency).join("");
    board.querySelectorAll("[data-agreg-news]").forEach((btn) => {
      btn.addEventListener("click", () => loadAgregNews(btn.dataset.agregNews, btn.dataset.agregName, btn));
    });
  } catch (e) {
    if (hint) hint.textContent = `Falha ao carregar: ${e.message}`;
  }
}

function agregLane(title, items, kind) {
  if (!items || !items.length) return "";
  const li = items.map((it) => {
    const url = safeUrl(it.link);
    const t = escapeHtml((it.title || it.theme_title || "").slice(0, 130));
    const meta = kind === "tema"
      ? [it.status, it.area, it.biennium].filter(Boolean).map((x) => escapeHtml(x)).join(" · ")
      : escapeHtml(it.date || "");
    return `<li>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${t}</a>` : t}${meta ? ` <span class="ger-muted">${meta}</span>` : ""}</li>`;
  }).join("");
  return `<div class="agreg-lane"><h4>${escapeHtml(title)}</h4><ul class="ger-recent">${li}</ul></div>`;
}

function renderAgregAgency(a) {
  return `
  <section class="panel agreg-card">
    <div class="panel-header">
      <div><h3 class="agreg-ag">${escapeHtml(a.agency)}</h3><p class="kicker">${escapeHtml(a.agency_name || "")}</p></div>
      <button type="button" class="ghost-button" data-agreg-news="${escapeHtml(a.agency)}" data-agreg-name="${escapeHtml(a.agency_name || a.agency)}">Notícias</button>
    </div>
    <div class="agreg-lanes">
      ${agregLane("Agenda formal — temas", a.temas, "tema")}
      ${agregLane("Atos de Agenda Regulatória", a.agenda, "ato")}
      ${agregLane("Consultas / audiências abertas", a.consultas, "ato")}
      ${agregLane("Pautas / deliberações", a.pautas, "ato")}
    </div>
    <div class="agreg-news" id="agreg-news-${escapeHtml(a.agency)}" hidden></div>
  </section>`;
}

async function loadAgregNews(agency, agencyName, btn) {
  const el = document.getElementById(`agreg-news-${agency}`);
  if (!el) return;
  if (el.dataset.loaded) { el.hidden = !el.hidden; return; } // já carregado -> só alterna
  el.hidden = false;
  el.innerHTML = emptyCard("Notícias", "Buscando notícias recentes…");
  btn.disabled = true;
  try {
    const data = await requestJson(`/api/news?q=${encodeURIComponent(`${agencyName} agenda regulatória`)}`);
    el.dataset.loaded = "1";
    const items = data.items || [];
    el.innerHTML = items.length
      ? `<div class="agreg-news-list">${items.slice(0, 6).map((n) => {
          const url = safeUrl(n.link);
          return `<article class="news-card"><span class="source-meta">${escapeHtml(n.source || "")} · ${escapeHtml((n.date || "").slice(0, 16))}</span><strong>${escapeHtml((n.title || "").slice(0, 140))}</strong>${url ? `<div class="entity-row"><a class="entity-pill" href="${escapeHtml(url)}" target="_blank" rel="noopener">Abrir ↗</a></div>` : ""}</article>`;
        }).join("")}</div>`
      : emptyCard("Notícias", "Nenhuma notícia recente encontrada.");
  } catch (e) {
    el.innerHTML = emptyCard("Notícias", `Falha: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

function ensureCnpjGraphView() {
  if (state.graphView || !$("#graph-cy")) return state.graphView;
  state.graphView = createGraphView({
    container: $("#graph-cy"),
    legendEl: $("#graph-legend"),
    onSelect: (id) => { state.selectedNodeId = id; renderInspector(); },
    onExpand: (id) => expandCnpjNode(id)
  });
  return state.graphView;
}

function renderGraph() {
  const hasNodes = state.graphNodes.length > 0;
  $("#graph-title").textContent = state.target?.legalName || "Aguardando CNPJ";
  if (hasNodes && !window.cytoscape) { showGraphLibError("#graph-empty"); return; }
  $("#graph-empty")?.classList.toggle("hidden", hasNodes);
  $("#graph-legend")?.classList.toggle("hidden", !hasNodes);
  if (!hasNodes) return;
  const view = ensureCnpjGraphView();
  if (!view) return;
  view.setElements(state.graphNodes, state.graphEdges);
  if (state.selectedNodeId) view.select(state.selectedNodeId);
}

// Mensagem amigavel se a lib de grafo (CDN) nao carregar.
function showGraphLibError(emptySelector) {
  const el = $(emptySelector);
  if (el) { el.classList.remove("hidden"); el.innerHTML = `<strong>Não foi possível carregar o grafo</strong><p>A biblioteca de visualização (Cytoscape) não respondeu. Verifique a conexão e recarregue a página.</p>`; }
}

function iconFor(type) {
  return { company: "C", partner: "S", contact: "@", domain: "D", news: "N", agency: "A", person: "P" }[type] || "I";
}

function renderInspector() {
  const node = state.graphNodes.find((entry) => entry.id === state.selectedNodeId);
  if (!node) {
    showInspectorMessage("Sem selecao", "Consulte um CNPJ real para selecionar nos e ver a origem dos dados.");
    return;
  }
  $("#inspector-title").textContent = node.title;
  // Screening de sanções da empresa central (Portal da Transparência).
  const screeningSection = node.id === "company"
    ? `<div class="object-section">
        <p class="object-section-title">Screening de sanções</p>
        ${renderScreeningPanel(state.screening, "company", state.sources.screening?.status === "key" ? "key" : state.screening ? "ok" : "err")}
      </div>`
    : "";
  $("#inspector-body").innerHTML = `
    <article class="detail-card">
      <span class="field-source">${escapeHtml(node.type)} | ${escapeHtml(node.status)}</span>
      <strong>${escapeHtml(node.subtitle)}</strong>
      <p>Dado exibido somente porque foi retornado por fonte real conectada.</p>
    </article>
    ${screeningSection}
    ${node.fields
      .filter(([, value]) => value)
      .map(
        ([label, value]) => `
          <article class="detail-card">
            <span class="field-source">${escapeHtml(label)}</span>
            <strong>${escapeHtml(value)}</strong>
            <p>Origem rastreavel no dossie.</p>
          </article>
        `
      )
      .join("")}
  `;
}

function showInspectorMessage(title, message) {
  $("#inspector-title").textContent = title;
  $("#inspector-body").innerHTML = `<article class="detail-card"><p>${escapeHtml(message)}</p></article>`;
}

function renderDossier() {
  renderDossierTabs();
  const title = state.target?.legalName || "Nenhum alvo consultado";
  $("#dossier-title").textContent = title;
  const exportBtn = $("#export-dossier");
  if (exportBtn) exportBtn.hidden = !state.target;
  $("#dossier-summary").textContent = state.target
    ? `Dossie real-only para ${formatCnpj(state.target.cnpj)}. Apenas seções com dado de fonte real são exibidas.`
    : "As secoes so aparecem quando houver dado retornado por fonte real.";

  // Aba Patrimônio tem layout próprio (blocos de largura total).
  if (state.activeDossierTab === "patrimony") {
    $("#dossier-content").innerHTML = renderCompanyPatrimony();
    return;
  }

  const items = state.dossier[state.activeDossierTab] || [];
  if (!items.length) {
    $("#dossier-content").innerHTML = emptyCard(
      dossierTabs.find(([id]) => id === state.activeDossierTab)?.[1] || "Secao",
      emptyMessageForTab(state.activeDossierTab)
    );
    return;
  }

  $("#dossier-content").innerHTML = items
    .map(
      (entry) => `
        <article class="dossier-item">
          <span class="field-source">${escapeHtml(entry.source)}</span>
          <strong>${escapeHtml(entry.label)}</strong>
          <p>${escapeHtml(entry.value)}</p>
        </article>
      `
    )
    .join("");
}

// So exibe abas com fonte real: Basicas sempre; Patrimonio (tem renderer proprio)
// quando ha alvo; as demais so quando tem dado. Evita "dossie rico" fantasma.
function visibleDossierTabs() {
  return dossierTabs.filter(([id]) => {
    if (id === "basic") return true;
    if (id === "patrimony") return !!state.target;
    return ((state.dossier[id] || []).length) > 0;
  });
}

function renderDossierTabs() {
  const tabs = visibleDossierTabs();
  // Se a aba ativa deixou de existir (ex.: novo alvo sem aquela fonte), volta p/ basic.
  if (!tabs.some(([id]) => id === state.activeDossierTab)) state.activeDossierTab = "basic";
  $("#dossier-tabs").innerHTML = tabs
    .map(
      ([id, label]) => `<button class="dossier-tab ${state.activeDossierTab === id ? "active" : ""}" type="button" data-dossier-tab="${id}">${label}</button>`
    )
    .join("");
}

function emptyMessageForTab(tab) {
  const messages = {
    movements: "Movimentacoes exigem REDESIM/Junta Comercial ou ingestao do dump da Receita. Ainda nao conectado.",
    social: "Redes sociais dependem de OSINT permitido ou base licenciada. Nao ha dado real retornado.",
    documents: "Documentos regulatorios exigem ingestao de agencias/DOU. Ainda nao conectado.",
    processes: "DataJud esta preparado, mas requer chave no ambiente para consulta real.",
    debts: "PGFN exige ingestao do dump trimestral ou API contratada. Ainda nao conectado.",
    publicPayments: "Portal da Transparencia requer chave gratuita no ambiente.",
    patrimony: "Patrimonio exige consulta de CNPJ executada. Participacoes societarias dependem do dump da Receita (load:receita-socio).",
    irregularities: state.screening
      ? "Screening executado no Portal da Transparencia: nada consta nas listas consultadas (CEIS, CNEP, CEPIM)."
      : "Screening PEP/sancoes requer PORTAL_TRANSPARENCIA_API_KEY no ambiente da Vercel.",
    alerts: "Sem alerta real gerado para este alvo.",
    regulatoryHistory: "Historico regulatorio e exclusivo LINCE, mas exige ingestao de deliberações.",
    decisionPattern: "Padrao decisorio exige votos/deliberacoes ingeridos."
  };
  return messages[tab] || "Sem dado encontrado em fonte real conectada.";
}

function emptyCard(title, message) {
  return `<article class="dossier-item empty"><span class="field-source">Sem dado conectado</span><strong>${escapeHtml(title)}</strong><p>${escapeHtml(message)}</p></article>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}

// ── Componentes de card estilo Gotham ─────────────────────────────────────
// Rodapé do card de alvo: diamante colorido + fila à esquerda, marcação de
// classificação à direita (ex. "DOU//ANEEL").
function cardFoot(queueColor, queueLabel, classification) {
  return `<div class="card-foot"><span><i class="q-diamond" style="--q:${queueColor}"></i>${escapeHtml(queueLabel)}</span><span class="card-class">${escapeHtml(classification)}</span></div>`;
}

// Ícone de alvo (crosshair vermelho em círculo, como no Gotham).
const TARGET_ICO = `<span class="target-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="7"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/></svg></span>`;

// ── Screening PEP/Sanções (badges por lista consultada) ───────────────────
const SCREENING_LISTS = [
  ["peps", "PEP", "Pessoa exposta politicamente"],
  ["ceis", "CEIS", "Inidôneas e suspensas"],
  ["cnep", "CNEP", "Punidas — Lei Anticorrupção"],
  ["cepim", "CEPIM", "Entidades impedidas"],
  ["ceaf", "CEAF", "Expulsos da adm. federal"],
  ["servidores", "SIAPE", "Vínculo de servidor federal"]
];
const SCREENING_SUBSET = {
  company: ["ceis", "cnep", "cepim"],
  person: ["peps", "ceis", "cnep", "ceaf", "servidores"]
};

// Extrai nome/descrição de um registro (campos variam por lista do Portal).
function screeningMatchInfo(entry) {
  const name = entry?.sancionado?.nome || entry?.pessoaJuridica?.nome || entry?.pessoa?.nome
    || entry?.servidor?.pessoa?.nome || entry?.nome || entry?.nomeSancionado || "Registro";
  const detail = entry?.tipoSancao?.descricaoResumida || entry?.motivo || entry?.descricaoFuncao
    || entry?.punicao?.descricao || entry?.cargo?.descricao || entry?.orgaoSancionador?.nome || "";
  return { name: String(name), detail: String(detail || "") };
}

// screening = payload de /api/external?type=screening ({flags, sources}) ou
// null. mode: "ok" | "key" (requer chave) | "err".
function renderScreeningPanel(screening, kind, mode) {
  const keys = SCREENING_SUBSET[kind] || SCREENING_LISTS.map(([k]) => k);
  const lists = SCREENING_LISTS.filter(([k]) => keys.includes(k));
  const badges = lists.map(([key, label, desc]) => {
    const src = screening?.sources?.[key];
    let cls = "err", verdict = "SEM DADO";
    if (mode === "key") { cls = "key"; verdict = "REQUER CHAVE"; }
    else if (src?.ok && src.total > 0) { cls = "hit"; verdict = `${src.total}${src.truncated ? "+" : ""} REGISTRO(S)`; }
    else if (src?.ok) { cls = "clear"; verdict = "NADA CONSTA"; }
    else if (src) { cls = "err"; verdict = "FALHA NA FONTE"; }
    return `<div class="screening-badge ${cls}">
      <span class="sb-list">${escapeHtml(label)}</span>
      <span class="sb-verdict">${escapeHtml(verdict)}</span>
      <span class="sb-desc">${escapeHtml(desc)}</span>
    </div>`;
  }).join("");
  const note = mode === "key"
    ? `<p class="screening-note">Configure PORTAL_TRANSPARENCIA_API_KEY no ambiente da Vercel para habilitar o screening.</p>`
    : "";
  return `<div class="screening-grid">${badges}</div>${note}`;
}

// Hits do screening viram itens da aba Irregularidades do dossiê.
function screeningToItems(screening) {
  if (!screening?.sources) return [];
  const items = [];
  for (const [key, label] of SCREENING_LISTS.map(([k, l]) => [k, l])) {
    const src = screening.sources[key];
    if (!src?.ok || !src.total) continue;
    for (const entry of (src.items || []).slice(0, 5)) {
      const info = screeningMatchInfo(entry);
      items.push(item(`${label}: ${info.name}`, info.detail || `Registro na lista ${label}`, "Portal da Transparencia"));
    }
  }
  return items;
}

// Destaca nomes de entidades dentro do texto com <mark> azul.
// Escapa o texto ANTES e o nome ao montar o regex — sem risco de XSS.
function highlightEntities(rawText, entities) {
  let html = escapeHtml(rawText || "");
  for (const e of (entities || []).slice(0, 8)) {
    const name = escapeHtml(String(e?.name || e || "").trim());
    if (name.length < 3) continue;
    const pattern = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    html = html.replace(new RegExp(pattern, "i"), (m) => `<mark class="entity-mark">${m}</mark>`);
  }
  return html;
}

// Aceita apenas URLs http/https; bloqueia esquemas perigosos (javascript:, data:) vindos de fontes externas.
function safeUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  return /^https?:\/\//i.test(raw) ? raw : "";
}

function wireEvents() {
  $("#view-nav").addEventListener("click", (event) => {
    const button = event.target.closest("[data-view]");
    if (!button) return;
    setView(button.dataset.view);
  });

  // Sidebar recolhível: restaura a preferência e liga o toggle.
  const sidebar = $("#sidebar");
  if (sidebar && localStorage.getItem("lince-sidebar") === "expanded") sidebar.classList.add("expanded");
  $("#sidebar-toggle")?.addEventListener("click", () => {
    if (!sidebar) return;
    const expanded = sidebar.classList.toggle("expanded");
    localStorage.setItem("lince-sidebar", expanded ? "expanded" : "collapsed");
  });

  $("#search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const raw = ($("#global-search").value || "").trim();
    const digits = onlyDigits(raw);
    const personPrefix = raw.match(/^p(?:essoa)?:\s*(.+)$/i);
    if (digits.length === 14) {
      // CNPJ -> investigação tradicional
      runSearch(raw).catch((error) => {
        setLoading(false);
        showInspectorMessage("Erro de consulta", error.message);
      });
    } else if (digits.length === 11) {
      // CPF -> screening de pessoa (fontes públicas + base local)
      runPersonSearch({ cpf: digits }).catch((error) => {
        showInspectorMessage("Erro de consulta", error.message);
      });
    } else if (personPrefix) {
      // "p: fulano" -> screening de pessoa por nome
      runPersonSearch({ name: personPrefix[1] }).catch((error) => {
        showInspectorMessage("Erro de consulta", error.message);
      });
    } else if (raw.length >= 3) {
      // Texto -> busca por palavra-chave nos atos do DOU
      runKeywordSearch(raw).catch((error) => {
        showInspectorMessage("Erro de busca", error.message);
      });
    } else {
      showInspectorMessage("Busca", "Informe CNPJ (14 dígitos), CPF (11 dígitos), termo (mín. 3 letras) ou p: nome.");
    }
  });

  $("#dou-date")?.addEventListener("change", () => loadDouFeed());
  $("#dou-agency")?.addEventListener("change", () => loadDouFeed());
  $("#director-search")?.addEventListener("input", debounce(() => loadDirectors(), 300));
  wireNatGraph();

  $("#open-dossier").addEventListener("click", () => setView("dossier"));
  $("#center-graph").addEventListener("click", centerGraph);
  $("#reset-graph")?.addEventListener("click", () => state.graphView?.reset());
  $("#fit-graph")?.addEventListener("click", () => state.graphView?.fit());
  $("#zoom-in")?.addEventListener("click", () => state.graphView?.zoomBy(1.2));
  $("#zoom-out")?.addEventListener("click", () => state.graphView?.zoomBy(1 / 1.2));

  $("#dossier-tabs").addEventListener("click", (event) => {
    const tab = event.target.closest("[data-dossier-tab]");
    if (!tab) return;
    state.activeDossierTab = tab.dataset.dossierTab;
    renderDossier();
  });

  // Ctrl+Space foca a busca global (hint exibido no input, estilo Gotham).
  document.addEventListener("keydown", (event) => {
    if (event.ctrlKey && event.code === "Space") {
      event.preventDefault();
      $("#global-search")?.focus();
    }
  });

  $("#monitor-form")?.addEventListener("submit", saveMonitorFromForm);
  $("#leg-form")?.addEventListener("submit", (e) => { e.preventDefault(); loadLegislativo($("#leg-search")?.value); });
  wireMonitorList();
  $("#export-dossier")?.addEventListener("click", () => {
    exportDossierPdf().catch((error) => alert(`Falha ao exportar: ${error.message}`));
  });

  // Gerador de Dossiê Comercial (M14).
  $("#gerador-form")?.addEventListener("submit", (e) => {
    runGerador(e).catch((error) => {
      $("#gerador-hint").textContent = `Falha ao gerar: ${error.message}`;
    });
  });
  $("#gerador-export")?.addEventListener("click", () => {
    exportGeradorPdf().catch((error) => alert(`Falha ao exportar: ${error.message}`));
  });

  // Agenda Regulatória: filtro de setor recarrega o board.
  $("#agreg-filter")?.addEventListener("change", () => loadAgendaRegulatoria());

  // B3 — "Atualizar agora": dispara a ingestão do DOU de hoje (via type=refresh,
  // JWT-gated; repassa o CRON_SECRET server-side). Pode demorar; feedback no status.
  $("#refresh-btn")?.addEventListener("click", async () => {
    const btn = $("#refresh-btn"), ds = $("#ds-text");
    const prev = btn.textContent;
    btn.disabled = true; btn.textContent = "Atualizando…";
    if (ds) ds.textContent = "Disparando ingestão do DOU de hoje… (pode levar até 1 min)";
    try {
      const r = await postJson("/api/intelligence?type=refresh", {});
      if (ds) ds.textContent = r?.ok
        ? `Ingestão concluída: ${r.inserted ?? 0} novo(s) ato(s), ${r.skipped ?? 0} já existente(s).`
        : `Falha na ingestão: ${r?.error || "erro"}`;
      loadOverviewMetrics();
    } catch (e) {
      if (ds) ds.textContent = `Falha ao atualizar: ${e.message}`;
    } finally {
      btn.disabled = false; btn.textContent = prev;
    }
  });
}

function centerGraph() {
  setView("investigate");
  state.graphView?.fit();
}

const TREND_MAX_CELLS = 12; // teto de quadradinhos por barra (cada um = bloco de atos)

function renderTrendChart(series) {
  const chart = $("#trend-chart");
  if (!chart) return;
  if (!series?.length) {
    chart.innerHTML = `<p style="color:var(--faint);padding:20px">Sem atos no periodo. Rode a ingestao do DOU.</p>`;
    return;
  }
  const maxTotal = Math.max(...series.map((d) => d.total), 1);
  const scale = Math.min(1, TREND_MAX_CELLS / maxTotal);
  chart.innerHTML = series.map((d) => {
    const cell = (type, n) => Array.from({ length: Math.round(n * scale) }, () => `<i class="trend-cell ${type}"></i>`).join("");
    const stack = cell("contrato", d.contrato) + cell("ato_pessoal", d.ato_pessoal) + cell("norma", d.norma);
    const day = (d.date || "").slice(8, 10);
    return `<div class="trend-col" title="${escapeHtml(d.date)}: ${d.total} atos">
      <div class="trend-stack">${stack || '<i class="trend-cell" style="background:#222"></i>'}</div>
      <span class="trend-x">${day}</span>
    </div>`;
  }).join("");
}

function renderSparkline(series) {
  const el = $("#spark-docs");
  if (!el || !series?.length) return;
  const last = series.slice(-16);
  const max = Math.max(...last.map((d) => d.total), 1);
  el.innerHTML = last.map((d, i) => {
    const h = Math.max(3, Math.round((d.total / max) * 34));
    const hot = i >= last.length - 3 ? " hot" : "";
    return `<i class="${hot.trim()}" style="height:${h}px"></i>`;
  }).join("");
}

function renderRecentActs(items) {
  const tbody = $("#recent-tbody");
  if (!tbody) return;
  if (!items?.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:var(--faint)">Sem atos ingeridos. Rode <b>npm run ingest:dou</b>.</td></tr>`;
    return;
  }
  const conf = (c) => {
    if (c == null) return `<span class="conf-badge">regex</span>`;
    const cls = c >= 0.8 ? "high" : c >= 0.5 ? "mid" : "";
    return `<span class="conf-badge ${cls}">${Math.round(c * 100)}%</span>`;
  };
  tbody.innerHTML = items.map((it) => `
    <tr>
      <td><strong>${escapeHtml(it.agency || "?")}</strong></td>
      <td><span class="tag ${escapeHtml(it.type || "ato")}">${escapeHtml((it.type || "ato").replace("_", " "))}</span></td>
      <td>${it.link ? `<a href="${escapeHtml(it.link)}" target="_blank" rel="noreferrer" style="color:inherit">${escapeHtml(it.title)}</a>` : escapeHtml(it.title)}</td>
      <td>${escapeHtml(it.date || "")}</td>
      <td>${conf(it.confidence)}</td>
    </tr>`).join("");
}

async function loadTrend(days = 30) {
  const trend = await requestJson(`/api/intelligence?type=trend&days=${days}`).catch(() => null);
  if (trend?.series) { renderTrendChart(trend.series); renderSparkline(trend.series); }
  const docEl = $("#metric-docs");
  if (docEl && trend) docEl.textContent = trend.total;
}

// Painel "Saúde dos dados" (cobertura + lacunas acionáveis). Reusa type=data_health.
async function loadDataHealth() {
  const countsEl = $("#dh-counts"), gapsEl = $("#dh-gaps"), fresh = $("#dh-fresh");
  if (!countsEl) return;
  try {
    const d = await requestJson("/api/intelligence?type=data_health");
    const c = d.counts || {};
    const cell = (label, val) => `<div class="dh-cell"><strong>${val == null ? "—" : val}</strong><span>${escapeHtml(label)}</span></div>`;
    countsEl.innerHTML = [
      cell("Atos DOU", c.documents), cell("Sem resumo IA", c.raw), cell("Diretores", c.people),
      cell("Empresas", c.companies), cell("Contratos", c.contracts), cell("Vínculos", c.relationships),
      cell("Vínc. partidário", c.party_links), cell("Patrimônio TSE", c.assets),
      cell("Proposições", c.proposicoes), cell("Deliberações", c.deliberations),
      cell("Agenda (temas)", c.regulatory_agenda), cell("Monitores", c.monitors)
    ].join("");
    if (fresh) {
      const stale = d.days_stale;
      fresh.hidden = false;
      fresh.textContent = d.last_ingest ? `DOU ${d.last_ingest}${stale != null ? ` · ${stale}d` : ""}` : "sem ingestão";
      fresh.className = "status-pill " + (stale != null && stale > 3 ? "status-key" : "status-ok");
    }
    gapsEl.innerHTML = (d.gaps || []).length
      ? `<ul class="dh-gap-list">${d.gaps.map((g) => `<li>⚠ ${escapeHtml(g)}</li>`).join("")}</ul>`
      : `<p class="dh-ok">✓ Sem lacunas críticas.</p>`;
  } catch (e) {
    if (gapsEl) gapsEl.innerHTML = emptyCard("Saúde dos dados", `Falha: ${e.message}`);
  }
}

async function loadOverviewMetrics() {
  try {
    loadTrend(30);
    loadDataHealth();
    requestJson("/api/intelligence?type=recent&limit=20").then((r) => {
      renderRecentActs(r?.items);
      const ds = $("#ds-text");
      const last = r?.items?.[0]?.date;
      if (ds) ds.textContent = last ? `Ato mais recente no acervo: ${last}` : "Sem atos ingeridos ainda — use “Atualizar agora”.";
    }).catch(() => {});

    const [score, daily] = await Promise.all([
      requestJson("/api/intelligence?type=score").catch(() => null),
      requestJson("/api/intelligence?type=daily").catch(() => null)
    ]);
    if (score?.scores) {
      const people = score.scores.reduce((s, a) => s + a.active_directors, 0);
      const alerts = score.scores.reduce((s, a) => s + a.open_alerts, 0);
      const ppEl = $("#metric-people"), alEl = $("#metric-alerts");
      if (ppEl) ppEl.textContent = people;
      if (alEl) alEl.textContent = alerts;
    }
    const dailyEl = $("#overview-daily");
    if (dailyEl && daily?.by_agency) {
      const entries = Object.entries(daily.by_agency);
      dailyEl.innerHTML = entries.length
        ? entries.map(([ac, d]) => `<article class="news-card"><span class="source-meta">${escapeHtml(ac)}</span><strong>${d.normas} normas · ${d.pessoal} atos pessoal · ${d.contratos} contratos</strong>${(d.destaques||[]).slice(0,1).map(s=>`<p>${escapeHtml(s)}</p>`).join("")}</article>`).join("")
        : emptyCard("Diario", "Nenhum ato nas ultimas 24h.");
    }
    const contracts = await requestJson("/api/intelligence?type=radar").catch(() => null);
    if (contracts) {
      const total = (contracts.radar?.["30d"]?.length || 0) + (contracts.radar?.["60d"]?.length || 0) + (contracts.radar?.["90d"]?.length || 0);
      const el = $("#metric-contracts");
      if (el) el.textContent = total;
    }

    const alertsData = await requestJson("/api/intelligence?type=alerts&limit=10").catch(() => null);
    const alertsEl = $("#overview-alerts");
    if (alertsEl && alertsData?.items?.length) {
      alertsEl.innerHTML = alertsData.items.map((a) => `
        <div class="activity-alert${a.severity !== "high" ? " info" : ""}" data-alert-card="${escapeHtml(a.id)}">
          <span class="alert-icon">${a.severity === "high" ? "⚠" : "ℹ"}</span>
          <div style="flex:1;min-width:0">
            <p style="margin:0;font-size:.78rem;font-weight:700">${escapeHtml(a.title || "")}</p>
            ${a.body ? `<p style="margin:2px 0 0;font-size:.72rem;opacity:.65">${escapeHtml(a.body.slice(0, 120))}</p>` : ""}
            <p style="margin:2px 0 0;font-size:.68rem;opacity:.45">${escapeHtml(a.alert_type || "")} · ${escapeHtml((a.created_at || "").slice(0, 10))}</p>
            <div class="alert-actions">
              <button type="button" class="alert-btn primary overview-alert-view">Ver atos</button>
              <button type="button" class="alert-btn overview-alert-dismiss" data-alert-id="${escapeHtml(a.id)}">Dispensar</button>
            </div>
          </div>
        </div>`).join("");
      // Wire action buttons
      alertsEl.querySelectorAll(".overview-alert-dismiss").forEach((btn) => {
        btn.addEventListener("click", async () => {
          btn.disabled = true; btn.textContent = "...";
          await requestJson(`/api/intelligence?type=dismiss_alert&id=${encodeURIComponent(btn.dataset.alertId)}`).catch(() => {});
          const card = alertsEl.querySelector(`[data-alert-card="${btn.dataset.alertId}"]`);
          if (card) { card.style.transition = "opacity .3s"; card.style.opacity = "0"; setTimeout(() => card.remove(), 320); }
        });
      });
      alertsEl.querySelectorAll(".overview-alert-view").forEach((btn) => {
        btn.addEventListener("click", () => setView("dou"));
      });
      // (P4) NAO sobrescrever #metric-alerts aqui — o valor de type=score (soma
      // real das agencias, sem teto) ja foi setado; este feed e capado em 10.
    } else if (alertsEl) {
      alertsEl.innerHTML = `<p style="color:var(--green);font-size:.85rem">✓ Nenhum alerta pendente.</p>`;
    }
  } catch { /* sem dados ainda */ }
}

function wireTrendToggle() {
  const toggle = $("#trend-toggle");
  if (!toggle) return;
  toggle.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-days]");
    if (!btn) return;
    toggle.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
    loadTrend(Number(btn.dataset.days));
  });
}

function init() {
  renderAll();
  wireEvents();
  wireTrendToggle();
  loadOverviewMetrics();
  // Deep-link/QA: #view=monitors abre a view direto (não há roteamento por URL).
  const hashParams = new URLSearchParams(location.hash.slice(1));
  if (hashParams.get("view")) setView(hashParams.get("view"));
}

// ══════════════════ Autenticação (Supabase Auth) ══════════════════════════
// Gate de UX no front: sem sessão, mostra a tela de login antes do app subir.
// A proteção real dos DADOS é no middleware (JWT no /api/*). Fail-open quando o
// Auth não está configurado (auth_config.authEnabled=false) — o app roda direto.

function traduzAuthErro(msg) {
  const m = String(msg || "").toLowerCase();
  if (m.includes("invalid login") || m.includes("invalid credentials")) return "e-mail ou senha incorretos.";
  if (m.includes("already registered") || m.includes("already been registered")) return "e-mail já cadastrado — use Entrar.";
  if (m.includes("email not confirmed")) return "confirme seu e-mail antes de entrar.";
  if (m.includes("password") && m.includes("6")) return "a senha precisa de ao menos 6 caracteres.";
  if (m.includes("rate limit")) return "muitas tentativas — aguarde um instante.";
  return msg || "erro de autenticação.";
}

let _appStarted = false;
let _authLost = false;
let _loginWired = false;

function showApp(user) {
  const overlay = $("#login-overlay");
  if (overlay) overlay.hidden = true;
  const em = $("#user-email");
  if (em && user?.email) em.textContent = user.email;
  const logout = $("#logout-btn");
  // (#16/#17) "Sair" só aparece quando há usuário autenticado (não no fail-open).
  if (logout && user) {
    logout.hidden = false;
    if (!logout.dataset.wired) {
      logout.dataset.wired = "1";
      logout.addEventListener("click", async () => {
        try { await _sb?.auth?.signOut(); } catch { /* ignora */ }
        location.reload();
      });
    }
  }
}

// Sucesso de login (inicial ou re-login após expiração). Inicia o app só 1 vez.
function onAuthSuccess(session, user) {
  _accessToken = session?.access_token || null;
  _authLost = false;
  showApp(user);
  if (!_appStarted) { _appStarted = true; init(); }
}

// Sessão perdida/negada durante o uso (401/403): volta ao login sem deixar o
// app renderizado e quebrado. (#6, #11)
function handleAuthLost(status) {
  if (_authLost) return;
  _authLost = true;
  _accessToken = null;
  const ov = $("#login-overlay"); if (ov) ov.hidden = false;
  const msg = $("#login-msg");
  if (msg) msg.textContent = status === 403
    ? "Seu e-mail não está autorizado a acessar o LINCE."
    : "Sua sessão expirou. Entre novamente.";
  wireLoginForm();
}

function showLoginError(text) {
  const ov = $("#login-overlay"); if (ov) ov.hidden = false;
  const msg = $("#login-msg"); if (msg) msg.textContent = text;
}

function wireLoginForm() {
  if (_loginWired) return;
  _loginWired = true;
  const form = $("#login-form");
  const msg = $("#login-msg");
  if (!form) return;
  const email = () => ($("#login-email").value || "").trim();
  const pass = () => $("#login-pass").value || "";
  const setBusy = (b) => { $("#login-submit").disabled = b; $("#login-signup").disabled = b; };
  const fail = (e) => { if (msg) msg.textContent = `Falha: ${traduzAuthErro(e)}`; setBusy(false); };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (msg) msg.textContent = "Entrando…"; setBusy(true);
    try {
      const { data, error } = await _sb.auth.signInWithPassword({ email: email(), password: pass() });
      if (error) return fail(error.message);
      setBusy(false); onAuthSuccess(data.session, data.user);
    } catch (err) { fail(err.message); }
  });

  $("#login-signup").addEventListener("click", async () => {
    if (!email() || pass().length < 6) { if (msg) msg.textContent = "Informe e-mail e senha (mín. 6 caracteres)."; return; }
    if (msg) msg.textContent = "Criando conta…"; setBusy(true);
    try {
      const { data, error } = await _sb.auth.signUp({ email: email(), password: pass() });
      if (error) return fail(error.message);
      setBusy(false);
      if (data.session) onAuthSuccess(data.session, data.user);
      else if (msg) msg.textContent = "Conta criada. Se pedirem confirmação por e-mail, confirme e clique em Entrar.";
    } catch (err) { fail(err.message); }
  });
}

async function bootstrap() {
  let cfg = null, reachable = false;
  try { cfg = await fetch("/api/intelligence?type=auth_config").then((r) => r.json()); reachable = true; } catch { /* offline */ }

  // (#12) Fail-open SÓ quando o servidor disse explicitamente authEnabled=false.
  if (reachable && cfg && cfg.authEnabled === false) { _appStarted = true; showApp(null); init(); return; }
  // Falha transitória ao falar com o servidor: NÃO fail-open (ele pode exigir auth).
  if (!reachable || !cfg) { showLoginError("Não foi possível verificar o login (rede). Recarregue a página."); return; }
  if (!window.supabase || !window.supabase.createClient) {
    showLoginError("Não foi possível carregar o login (CDN). Recarregue a página."); return;
  }

  _sb = window.supabase.createClient(cfg.url, cfg.anonKey);
  // Mantém o token fresco; perda de sessão com app rodando volta ao login (#11).
  _sb.auth.onAuthStateChange((event, session) => {
    _accessToken = session?.access_token || null;
    if (_appStarted && !session && event === "SIGNED_OUT") handleAuthLost(401);
  });

  const { data } = await _sb.auth.getSession();
  const session = data?.session || null;
  if (session) onAuthSuccess(session, session.user);
  else { wireLoginForm(); const ov = $("#login-overlay"); if (ov) ov.hidden = false; }
}

bootstrap();
