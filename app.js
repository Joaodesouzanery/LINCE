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
  ["ingested", "Base LINCE"],
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
let _userEmail = null; // e-mail do usuário logado (p/ registrar quem promoveu no Score de Patrocinador)

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
  contract:     { color: "#b0b352", label: "Contrato" },
  donor:        { color: "#d2699e", label: "Doador" }
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
  // Cartao (estilo Sherlocker): fundo escuro + borda na cor do tipo (acento),
  // rotulo multilinha dentro (nome + doc + situacao). A cor do tipo vira a borda.
  { selector: "node", style: {
    "shape": "round-rectangle",
    "background-color": "#1b2129", "background-opacity": 0.97,
    "label": "data(label)", "color": "#e8eaed",
    "font-family": "IBM Plex Sans, Inter, sans-serif",
    "font-size": 10, "font-weight": 600, "line-height": 1.25,
    "text-wrap": "wrap", "text-max-width": 148,
    "text-valign": "center", "text-halign": "center",
    "width": "label", "height": "label", "padding": "9px",
    "border-width": 2, "border-color": "data(color)"
  } },
  { selector: "node.central", style: { "border-color": "#e8eaed", "border-width": 3, "font-size": 11, "font-weight": 800 } },
  { selector: "node.alerted", style: { "border-color": "#d5605c", "border-width": 3 } },
  // Situacao cadastral inativa (baixada/suspensa/inapta): borda vermelha tracejada.
  { selector: "node.inactive", style: { "border-color": "#d5605c", "border-style": "dashed", "color": "#c7ccd1" } },
  { selector: "node:selected", style: { "border-color": "#b0b352", "border-width": 4 } },
  { selector: "node.dim", style: { "opacity": 0.12 } },
  { selector: "node.hidden", style: { "display": "none" } },
  { selector: "node.highlight", style: { "border-color": "#b0b352", "border-width": 4 } },
  { selector: "edge", style: {
    "width": "data(w)", "line-color": "data(lineColor)", "line-style": "data(lineStyle)", "opacity": "data(op)",
    "curve-style": "bezier", "target-arrow-shape": "triangle", "target-arrow-color": "data(lineColor)", "arrow-scale": 0.7,
    // Rotulo na aresta (Sherlocker): Socio/Administrador/Direcao etc.
    "label": "data(rel)", "font-size": 8, "font-weight": 600, "color": "#aeb6bf",
    "text-background-color": "#0c1116", "text-background-opacity": 0.82, "text-background-padding": 2,
    "text-rotation": "autorotate", "text-wrap": "ellipsis", "text-max-width": 92
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

// Situacao cadastral que indica empresa "morta" (badge vermelho no cartao).
function isInactiveStatus(s) { return /baix|inap|inativ|suspens|nula|cancel/i.test(String(s || "")); }

// Rotulo multilinha do cartao (estilo Sherlocker): nome + doc + situacao.
// Empresa: nome / CNPJ formatado / situacao (com ⛔ se inativa). Pessoa: nome / papel.
function nodeCardLabel(n) {
  const meta = n.meta || {};
  const lines = [n.title || n.id];
  if (n.type === "company") {
    const cnpj = meta.cnpj || (onlyDigits(n.subtitle || "").length >= 8 ? n.subtitle : "");
    if (cnpj) lines.push(formatCnpj(cnpj));
    const situ = String(meta.situacao || "").trim();
    if (situ) lines.push(isInactiveStatus(situ) ? `⛔ ${situ}` : situ);
  } else if (n.subtitle) {
    lines.push(n.subtitle);
  }
  return lines.join("\n");
}

function cyElements(nodes, edges) {
  const ids = new Set(nodes.map((n) => n.id));
  const els = [];
  for (const n of nodes) {
    const inactive = n.type === "company" && isInactiveStatus((n.meta || {}).situacao);
    const cls = [n.central ? "central" : "", n.alert ? "alerted" : "", inactive ? "inactive" : ""].filter(Boolean).join(" ");
    els.push({ data: { id: n.id, label: nodeCardLabel(n), sub: n.subtitle || "", type: n.type, color: nodeColor(n.type), size: n.central ? 30 : 20 }, classes: cls });
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

// Situação cadastral: ATIVA/ATIVA NÃO REGULAR = ativa; INATIVA/BAIXADA/INAPTA/etc = não.
// (F-INT1: o antigo /ativ/i casava "INATIVA" como ativa.)
function isSituacaoAtiva(status) {
  const u = String(status || "").toUpperCase();
  return u.includes("ATIV") && !u.includes("INATIV");
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

// Data BR (DD/MM/AAAA) a partir de ISO/AAAA-MM-DD. Vazio -> "". Nao inventa
// fuso: usa so a parte de data. Padroniza a exibicao em toda a plataforma (E4).
function fmtDate(value) {
  if (!value) return "";
  const s = String(value).slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
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
    votacao: ["Voto do colegiado (M19)", "Votação"],
    graph: ["Rede de influencia (M7)", "Grafo Nacional"],
    intelligence: ["Inteligencia regulatoria", "Inteligencia Nacional"],
    consultas: ["Participacao social (M5)", "Consultas Publicas"],
    agenda: ["Calendario regulatorio (M8)", "Agenda e Pautas"],
    "agenda-reg": ["Pipeline regulatorio (M8+)", "Agenda Regulatoria"],
    monitors: ["Vigilancia continua (M10)", "Central de Monitoramento"],
    legislativo: ["Radar legislativo (M12)", "Legislativo"],
    paineis: ["Monitoramento por painel (M21)", "Painéis"],
    evento: ["Gestão de eventos (M25)", "Eventos"],
    financeiro: ["Financeiro (M30)", "Balancete"],
    radar: ["Risco & Oportunidade (M13)", "Radar"],
    gerador: ["Composição comercial (M14)", "Gerador de Dossiê"],
    person: ["Screening de pessoa", "Consulta Pessoa"]
  };
  const [kicker, title] = titles[view] || ["LINCE", view];
  if (view === "dou") loadDouFeed();
  if (view === "directors") loadDirectors();
  if (view === "graph") loadNationalGraph();
  if (view === "votacao") loadVotacao();
  if (view === "intelligence") loadIntelligence();
  if (view === "consultas") loadConsultas();
  if (view === "agenda") loadAgenda();
  if (view === "agenda-reg") loadAgendaRegulatoria();
  if (view === "monitors") loadMonitors();
  if (view === "legislativo") loadLegislativo();
  if (view === "paineis") loadPaineis();
  if (view === "evento") loadEventos();
  if (view === "financeiro") loadFinanceiro();
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
  // Trava de reentrância: uma busca em andamento (botão desabilitado via setLoading)
  // bloqueia disparos concorrentes (linha de "CNPJs de teste", atalhos). Sem isto,
  // a resposta LENTA de um alvo A pode sobrescrever o dossiê/grafo de um alvo B
  // aberto depois — má-atribuição entre empresas (achado da revisão E3).
  if ($("#search-form button")?.disabled) return;

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
  // E3 — mescla a inteligência INGERIDA (contratos/deliberações/sócios/sanções da
  // base LINCE) ao dossiê ao vivo -> aba "Base LINCE". Best-effort; se a empresa
  // não está na base ou não há dado, a aba mostra a dica de CNPJs de teste.
  // Guarda contra corrida: só aplica se o alvo NÃO mudou durante o await (outra
  // busca concorrente não deve ter seu ingerido sobrescrito por este, mais lento).
  state.dossier.ingested = [];
  const ingCompanyId = state.graphRootCompanyId;
  if (ingCompanyId) {
    try {
      const ing = await requestJson(`/api/dossier-person?company=${encodeURIComponent(ingCompanyId)}`);
      if (state.graphRootCompanyId === ingCompanyId && ing?.ok && ing.mode === "company") {
        state.dossier.ingested = ingestedCompanyEntries(ing);
      }
    } catch { /* sem dado ingerido: aba usa o fallback */ }
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
        title: dn.title, subtitle: dn.subtitle || "", meta: dn.meta || {}, fields: [["Fonte", "Rede societária (Receita/QSA)"]] });
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
          title: dn.title, subtitle: dn.subtitle || "", meta: dn.meta || {}, fields: [["Fonte", "Rede societária (Receita/QSA)"]] });
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
  const relPills = [...new Set(
    natGraph.allEdges.filter((e) => e.from === nodeId || e.to === nodeId).map((e) => e.relationship)
  )].map((r) => `<span class="entity-pill">${escapeHtml(r)}</span>`).join(" ");

  if (kind === "agency") {
    const acronym = node.subtitle || node.title;
    const stats = await requestJson(`/api/intelligence?type=agency_stats&agency=${encodeURIComponent(acronym)}`).catch(() => null);
    const series = stats?.weekly_series || [];
    // F-INT1: compara a ultima semana COMPLETA (a atual e parcial e compararia dias com semanas).
    const complete = series.filter((w) => !w.current);
    const lastWeek = complete[complete.length - 1]?.total ?? 0;
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
      ${(() => {
        const scr = dossier?.screening?.flags;
        const badges = [];
        if (scr?.is_pep) badges.push('<span class="status-pill status-error">PEP</span>');
        if (scr?.has_sanctions) badges.push('<span class="status-pill status-error">Sanção</span>');
        if (scr?.is_servidor) badges.push('<span class="status-pill">Servidor federal</span>');
        const note = dossier?.screening?.available === false
          ? '<span style="font-size:.68rem;opacity:.4">screening indisponível (sem chave do Portal)</span>'
          : (badges.length ? badges.join(" ") : '<span style="font-size:.72rem;opacity:.5">Sem PEP/sanções encontrados</span>');
        return `<div class="object-section"><p class="object-section-title">Screening (Transparência)</p><div class="entity-row">${note}</div></div>`;
      })()}
      ${(dossier?.party_links || []).length ? `
      <div class="object-section"><p class="object-section-title">Partido / doações</p>
        ${dossier.party_links.map((p) => `<p style="font-size:.76rem;margin:2px 0"><strong>${escapeHtml(p.party || "")}</strong>${p.link_type ? ` <span style="opacity:.5">(${escapeHtml(p.link_type)}${p.reference_year ? " " + p.reference_year : ""})</span>` : ""}${p.amount ? ` · ${escapeHtml(money(p.amount))}` : ""}</p>`).join("")}
      </div>` : ""}
      ${(intel.votes_total || intel.deliberations_relatadas) ? `
      <div class="object-section"><p class="object-section-title">Colegiado</p>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px">
          <div class="detail-stat"><span>${intel.votes_total || 0}</span><small>votos</small></div>
          <div class="detail-stat"><span>${intel.dissent_votes || 0}</span><small>divergentes</small></div>
          <div class="detail-stat"><span>${intel.deliberations_relatadas || 0}</span><small>relatadas</small></div>
        </div>
      </div>` : ""}
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
  } else if (kind === "company") {
    // Dossiê da empresa: contratos ingeridos + QSA + deliberações que a afetam + sanções.
    const dossier = await requestJson(`/api/dossier-person?company=${encodeURIComponent(id)}`).catch(() => null);
    const c = dossier?.company || {};
    const cs = dossier?.contracts_summary || {};
    const scr = dossier?.screening?.flags;
    const badges = [];
    if (scr?.has_sanctions) badges.push('<span class="status-pill status-error">Sanção</span>');
    if (dossier?.intelligence?.is_inactive) badges.push('<span class="status-pill status-error">Inativa</span>');
    body.innerHTML = `
      <div class="object-section">
        <p class="object-section-title">Empresa ${badges.join(" ")}</p>
        <p style="font-size:.8rem;margin:0 0 4px"><strong>${escapeHtml(c.legal_name || node.title)}</strong></p>
        ${c.cnpj ? `<p style="font-size:.74rem;opacity:.6;margin:0">CNPJ: ${escapeHtml(c.cnpj)}${c.registration_status ? " · " + escapeHtml(c.registration_status) : ""}</p>` : ""}
      </div>
      <div class="object-section"><p class="object-section-title">Contratos públicos</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
          <div class="detail-stat"><span>${cs.count ?? 0}</span><small>contratos</small></div>
          <div class="detail-stat"><span>${escapeHtml(money(cs.total_value || 0))}</span><small>valor total</small></div>
        </div>
        ${(cs.agencies || []).length ? `<p style="font-size:.72rem;opacity:.55;margin:6px 0 0">Agências: ${escapeHtml((cs.agencies || []).join(", "))}</p>` : ""}
      </div>
      ${(dossier?.socios || []).length ? `<div class="object-section"><p class="object-section-title">Quadro societário (${dossier.socios.length})</p>${dossier.socios.slice(0, 8).map((s) => `<p style="font-size:.74rem;margin:2px 0">${escapeHtml(s.nome)}${s.role ? ` <span style="opacity:.5">(${escapeHtml(s.role)})</span>` : ""}</p>`).join("")}</div>` : ""}
      ${(dossier?.deliberations_afeta || []).length ? `<div class="object-section"><p class="object-section-title">Deliberações que a afetam (${dossier.deliberations_afeta.length})</p>${dossier.deliberations_afeta.slice(0, 6).map((d) => `<p style="font-size:.74rem;margin:2px 0"><strong>${escapeHtml(d.deliberation_number || "")}</strong> · ${escapeHtml(d.result || "—")} <span style="opacity:.5">${escapeHtml((d.title || "").slice(0, 42))}</span></p>`).join("")}</div>` : ""}
      ${dossier?.screening?.available === false ? `<div class="object-section"><p style="font-size:.68rem;opacity:.4;margin:0">Sanções: screening indisponível (sem chave do Portal)</p></div>` : ""}
      ${relPills ? `<div class="object-section"><p class="object-section-title">Relações</p><div class="entity-row">${relPills}</div></div>` : ""}
      <div class="object-section"><div class="entity-row">${expandBtn}${c.cnpj ? `<button type="button" class="alert-btn primary" id="nat-investigate-cnpj">Investigar CNPJ</button>` : ""}</div></div>`;
    $("#nat-investigate-cnpj")?.addEventListener("click", () => {
      const el = $("#global-search");
      if (el) { el.value = c.cnpj; el.form?.requestSubmit(); }
    });
  } else if (kind === "deliberation") {
    body.innerHTML = `
      <div class="object-section"><p class="object-section-title">Deliberação</p>
        <p style="font-size:.8rem;margin:0 0 4px"><strong>${escapeHtml(node.title || "Deliberação")}</strong></p>
        ${node.subtitle ? `<p style="font-size:.74rem;opacity:.6;margin:0">Tema: ${escapeHtml(node.subtitle)}</p>` : ""}
        <p style="font-size:.74rem;opacity:.6;margin:2px 0">${nNeighbors} vínculo(s) (agência / relator / empresa afetada / votos)</p>
      </div>
      ${relPills ? `<div class="object-section"><p class="object-section-title">Relações</p><div class="entity-row">${relPills}</div></div>` : ""}
      <div class="object-section"><div class="entity-row">${expandBtn}</div></div>`;
  } else if (kind === "party") {
    body.innerHTML = `
      <div class="object-section"><p class="object-section-title">Partido</p>
        <p style="font-size:.8rem;margin:0 0 4px"><strong>${escapeHtml(node.title || id)}</strong></p>
        <p style="font-size:.74rem;opacity:.6;margin:0">${nNeighbors} filiado(s)/doador(es) no grafo</p>
      </div>
      ${relPills ? `<div class="object-section"><p class="object-section-title">Relações</p><div class="entity-row">${relPills}</div></div>` : ""}
      <div class="object-section"><div class="entity-row">${expandBtn}</div></div>`;
  } else {
    body.innerHTML = `
      <div class="object-section"><p class="object-section-title">Detalhes</p>
        <p style="font-size:.78rem;margin:2px 0">${nNeighbors} conexão(ões) · ${nEdges} relação(ões)</p>
      </div>
      ${relPills ? `<div class="object-section"><p class="object-section-title">Relações</p><div class="entity-row">${relPills}</div></div>` : ""}
      <div class="object-section"><div class="entity-row">${expandBtn}</div></div>`;
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

// E3 — Converte o dossiê de empresa INGERIDO (api/dossier-person?company) em
// entradas do dossiê (aba "Base LINCE"): contratos, sócios, deliberações, sanções.
// Isto é o que faltava no "Investigar CNPJ" (item 5): o ao vivo (cnpj.ws) só traz
// cadastro/QSA/contato; a base LINCE traz contrato público, deliberação e sanção.
function ingestedCompanyEntries(ing) {
  const out = [];
  const cs = ing.contracts_summary || {};
  if ((cs.count || 0) > 0) {
    out.push({ source: "Base LINCE / PNCP", label: `Contratos públicos: ${cs.count}`,
      value: `Total ${money(cs.total_value || 0)} · agências: ${(cs.agencies || []).join(", ") || "-"}` });
    (ing.contracts || []).slice(0, 6).forEach((c) => {
      out.push({ source: `PNCP · ${c.agencies?.acronym || "?"}`,
        label: `${String(c.object || "Contrato").slice(0, 80)}`,
        value: `${money(Number(c.value) || 0)}${c.signed_at ? " · assinado " + fmtDate(c.signed_at) : ""}${c.ends_at ? " · vence " + fmtDate(c.ends_at) : ""}` });
    });
  }
  (ing.socios || []).slice(0, 12).forEach((s) => {
    out.push({ source: "QSA / Receita", label: `Sócio: ${s.nome}`,
      value: `${s.role || (s.kind === "company" ? "Sócia PJ" : "Sócio")}${s.cnpj ? " · " + formatCnpj(s.cnpj) : ""}` });
  });
  (ing.deliberations_afeta || []).slice(0, 8).forEach((d) => {
    out.push({ source: "Deliberação regulatória", label: `${String(d.title || d.deliberation_number || "Deliberação").slice(0, 90)}`,
      value: `${d.result || "—"}${d.data_reuniao ? " · " + fmtDate(d.data_reuniao) : ""}${d.theme ? " · " + d.theme : ""}` });
  });
  const sc = ing.screening || {};
  if (sc.flags) {
    const flags = [];
    if (sc.flags.has_sanctions) flags.push("SANÇÕES");
    if (sc.flags.is_pep) flags.push("PEP");
    out.push({ source: "Screening PEP/sanções", label: flags.length ? `⚠ ${flags.join(" · ")}` : "Sem apontamentos de screening",
      value: (sc.sources || []).join(", ") || "Portal da Transparência / CEIS / CNEP" });
  }
  if (!out.length) {
    out.push({ source: "Base LINCE", label: "Sem inteligência ingerida para esta empresa",
      value: "Ainda não há contratos/deliberações/sócios na base para este CNPJ. Empresas binacionais (ex.: Itaipu) ou fora do escopo ingerido trazem pouco. Use o botão “CNPJs de teste” para fornecedores reais com dado rico." });
  }
  return out;
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
  const companyInapta = !!(company.status && !isSituacaoAtiva(company.status));
  nodes.push({
    id: "company",
    type: "company",
    title: company.legalName || formatCnpj(company.cnpj),
    subtitle: formatCnpj(company.cnpj),
    central: true,
    alert: companyInapta,
    status: company.status || "Conectado",
    meta: { situacao: company.status || null, cnpj: company.cnpj || null },
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
  state.graphRootCompanyId = null; // não vazar o alvo anterior p/ a próxima busca (E3)
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
              ${safeUrl(entry.link) ? `<a class="entity-pill" href="${escapeHtml(safeUrl(entry.link))}" target="_blank" rel="noreferrer">Abrir DOU</a>` : ""}
            </div>
          </div>
          ${cardFoot(queueColor(entry.type), DOU_TYPE_LABEL[entry.type] || entry.type || "Ato", `DOU//${entry.agency || "BR"}`)}
        </article>
      `)
      .join("");
    if (payload.truncated) list.innerHTML += `<p class="card-sub" style="opacity:.7">⚠ Mostrando os 100 mais recentes — refine por data ou agência p/ ver o restante.</p>`;
  } catch (error) {
    list.innerHTML = emptyCard("Monitor DOU", `Falha ao carregar: ${error.message}`);
  }
}

// Lista de diretores (busca incremental por ?q= ou lista completa por ?list=1).
// Quando navegamos p/ a aba Diretores JA abrindo um dossiê específico, o autoload
// da lista (setView -> loadDirectors) correria com o fetch do dossiê e poderia
// sobrescrevê-lo. Este flag pula 1 autoload nesse caso (M20).
let suppressDirectorsAutoload = false;

async function loadDirectors() {
  if (suppressDirectorsAutoload) { suppressDirectorsAutoload = false; return; }
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
    const parties = (d.party_links || []).map((p) => `<span class="entity-pill">${escapeHtml(p.party)}${p.link_type === "doacao" && p.amount ? ` · ${escapeHtml(money(p.amount))}` : (p.link_type ? ` · ${escapeHtml(p.link_type)}` : "")}</span>`).join("");
    const rels = (d.relationships || []).length;
    const socios = (d.relationships || []).filter((r) => r.relationship === "socio").length;
    const ties = intel.corporate_ties ?? socios;
    const tiesPill = ties ? `<span class="entity-pill${intel.corporate_inactive ? " score-high" : ""}">${ties} vínculo(s) societário(s)${intel.corporate_inactive ? ` · ${intel.corporate_inactive} inapta(s)` : ""}</span>` : "";
    const scr = d.screening?.flags;
    const scrPills = [
      scr?.is_pep ? '<span class="entity-pill score-high">PEP</span>' : "",
      scr?.has_sanctions ? '<span class="entity-pill score-high">Sanção</span>' : "",
      scr?.is_servidor ? '<span class="entity-pill">Servidor federal</span>' : ""
    ].filter(Boolean).join("");
    list.innerHTML = `
      <article class="news-card">
        <button type="button" class="entity-pill" id="director-back">&larr; Voltar a lista</button>
        <span class="source-meta">${escapeHtml(d.person.full_name)} | ${escapeHtml(d.person.role || "dirigente")}</span>
        <strong>Score de captura: ${intel.capture_score ?? "-"}/100 | Votos vencidos: ${intel.dissent_votes ?? 0}</strong>
        <p>Mandato ativo: ${intel.active_mandate ? "sim" : "nao"} | Conexoes: ${rels} | SIAPE: ${(d.siape || []).length} registro(s) | Votos: ${intel.votes_total ?? 0} | Relatadas: ${intel.deliberations_relatadas ?? 0}</p>
        <div class="entity-row">${mandates}${parties}${tiesPill}${scrPills}</div>
        ${d.screening?.available === false ? `<p style="font-size:.7rem;opacity:.4;margin:4px 0 0">Screening PEP/sanções indisponível (sem chave do Portal da Transparência).</p>` : ""}
        <div class="entity-row">
          <button type="button" class="alert-btn primary" id="director-export">Exportar PDF</button>
        </div>
      </article>
      ${renderPoliticalRisk(pr)}
      ${renderColegiadoVotes(d)}
      ${renderPropositions(d)}
      ${renderLegislativeVotes(d)}
      ${renderComissoes(d)}
      ${renderDiscursos(d)}
      ${renderFinanciadores(d)}
      ${renderCorporateNetwork(d)}
      ${renderPersonPatrimony(d, socios)}`;
    $("#director-back")?.addEventListener("click", () => loadDirectors());
    $("#director-export")?.addEventListener("click", () => exportPersonPdf(d));
  } catch (error) {
    list.innerHTML = emptyCard("Diretores", `Falha: ${error.message}`);
  }
}

// Votos e deliberações relatadas no dossiê de pessoa (colegiado / M19).
function renderColegiadoVotes(d) {
  const votes = d.votes || [];
  const relatadas = d.deliberations_relatadas || [];
  if (!votes.length && !relatadas.length) return "";
  const voteRows = votes.slice(0, 25).map((v) => {
    const del = v.deliberations || {};
    return `<tr>
      <td>${escapeHtml(del.deliberation_number || "—")}</td>
      <td>${escapeHtml(v.vote_direction || "—")}${v.is_dissent ? ' <span class="entity-pill score-high">divergente</span>' : ""}</td>
      <td>${escapeHtml(del.result || "—")}</td>
      <td>${escapeHtml((del.title || "").slice(0, 48))}</td>
    </tr>`;
  }).join("");
  const relRows = relatadas.slice(0, 15).map((r) =>
    `<span class="entity-pill">${escapeHtml(r.deliberation_number || "")} · ${escapeHtml(r.result || "—")}</span>`
  ).join(" ");
  return `
    <article class="news-card">
      <span class="source-meta">Colegiado — votos e deliberações</span>
      <strong>${votes.length} voto(s)${votes.length ? ` · ${votes.filter((v) => v.is_dissent).length} divergente(s)` : ""} | ${relatadas.length} relatada(s)</strong>
      ${relRows ? `<div class="entity-row" style="margin:6px 0">Relatou: ${relRows}</div>` : ""}
      ${votes.length ? `<div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Delib.</th><th>Voto</th><th>Resultado</th><th>Assunto</th></tr></thead><tbody>${voteRows}</tbody></table></div>` : ""}
    </article>`;
}

// M20: proposições de autoria no dossiê de parlamentar (o "quem propôs").
function renderPropositions(d) {
  const props = d.propositions || [];
  if (!props.length) return "";
  const rows = props.slice(0, 25).map((p) => {
    const url = safeUrl(p.url);
    const titulo = p.titulo || `${p.tipo || ""} ${p.numero || ""}/${p.ano || ""}`;
    const themes = (Array.isArray(p.themes) ? p.themes : []).slice(0, 2).map((t) => `<span class="entity-pill">${escapeHtml(t)}</span>`).join("");
    return `<tr>
      <td>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(titulo)}</a>` : escapeHtml(titulo)}</td>
      <td>${escapeHtml(p.casa || "—")}</td>
      <td>${escapeHtml(p.situacao || "—")}</td>
      <td>${escapeHtml((p.ementa || "").slice(0, 70))} ${themes}</td>
    </tr>`;
  }).join("");
  return `
    <article class="news-card">
      <span class="source-meta">Legislativo — proposições de autoria</span>
      <strong>${props.length} proposição(ões) de autoria</strong>
      <div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Proposição</th><th>Casa</th><th>Situação</th><th>Ementa</th></tr></thead><tbody>${rows}</tbody></table></div>
    </article>`;
}

// M20.2: votação nominal legislativa no dossiê ("como vota" + fidelidade).
function renderLegislativeVotes(d) {
  const votes = d.legislative_votes || [];
  if (!votes.length) return "";
  const intel = d.intelligence || {};
  const orientadas = intel.legislative_orientadas ?? votes.filter((v) => v.orientavel).length;
  const dissent = intel.legislative_dissent ?? votes.filter((v) => v.divergente).length;
  const fidelidade = intel.legislative_fidelidade ?? (orientadas > 0 ? Math.round(((orientadas - dissent) / orientadas) * 100) : null);
  const cobertura = intel.legislative_cobertura ?? (votes.length ? Math.round((orientadas / votes.length) * 100) : 0);
  // Resumo HONESTO: fidelidade computada só sobre votos com orientação conhecida,
  // com a cobertura exposta (não infla fidelidade tratando o desconhecido como fiel).
  const resumo = orientadas > 0
    ? `Fiel em <strong>${fidelidade}%</strong> das ${orientadas} votação(ões) com orientação de bancada conhecida${dissent ? ` · ${dissent} infiel(is)` : ""} <span style="opacity:.6">· cobertura ${cobertura}% de ${votes.length} voto(s)</span>`
    : `${votes.length} voto(s) · <span style="opacity:.6">sem orientação de bancada resolvível — fidelidade indisponível</span>`;
  const rows = votes.slice(0, 30).map((v) => `<tr>
    <td>${escapeHtml(String(v.data_votacao || "").slice(0, 10))}</td>
    <td>${escapeHtml(v.voto || "—")}${v.divergente ? ' <span class="entity-pill score-high">infiel</span>' : ""}</td>
    <td>${escapeHtml(v.orientacao || "—")}${!v.orientavel ? ' <span style="opacity:.4">(s/ orient.)</span>' : ""}</td>
    <td>${escapeHtml(String(v.proposicao_titulo || v.descricao || "").slice(0, 52))}</td>
  </tr>`).join("");
  return `
    <article class="news-card">
      <span class="source-meta">Congresso — votação nominal (como vota)</span>
      <strong>${resumo}</strong>
      <div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Data</th><th>Voto</th><th>Orientação</th><th>Proposição</th></tr></thead><tbody>${rows}</tbody></table></div>
    </article>`;
}

// M21: comissões/órgãos do parlamentar (aba "Comissões" do stakeholder — NOMOS).
function renderComissoes(d) {
  const cs = d.comissoes || [];
  if (!cs.length) return "";
  const rows = cs.map((c) => `<tr>
    <td>${escapeHtml(c.sigla || "—")}</td>
    <td>${escapeHtml(String(c.nome || "").slice(0, 60))}</td>
    <td>${escapeHtml(c.cargo || "—")}</td>
  </tr>`).join("");
  return `
    <article class="news-card">
      <span class="source-meta">Comissões e órgãos</span>
      <strong>${cs.length} vínculo(s) — Câmara</strong>
      <div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Sigla</th><th>Órgão</th><th>Cargo</th></tr></thead><tbody>${rows}</tbody></table></div>
    </article>`;
}

// M21: últimos discursos (on-the-fly, best-effort — some se a API não retornar).
function renderDiscursos(d) {
  const ds = d.discursos || [];
  if (!ds.length) return "";
  const rows = ds.slice(0, 8).map((s) => {
    const url = safeUrl(s.url);
    const resumo = escapeHtml(String(s.sumario || "").slice(0, 180)) || "—";
    return `<li>
      <span style="opacity:.6">${escapeHtml(String(s.data || "").slice(0, 10))}${s.tipo ? " · " + escapeHtml(s.tipo) : ""}</span><br>
      ${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${resumo}</a>` : resumo}
    </li>`;
  }).join("");
  return `
    <article class="news-card">
      <span class="source-meta">Discursos recentes — Câmara</span>
      <ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px">${rows}</ul>
    </article>`;
}

// M20.3: financiadores de campanha no dossiê ("quem financia").
function renderFinanciadores(d) {
  const f = d.financiadores || {};
  if (!f.count) return "";
  const rows = (f.top || []).map((x) => `<tr>
    <td>${escapeHtml(x.donor_name || "—")}</td>
    <td>${escapeHtml(x.donor_type || "—")}</td>
    <td>${escapeHtml(x.donor_document || "—")}</td>
    <td>${escapeHtml(money(x.total))}${x.count > 1 ? ` <span class="entity-pill">${x.count}×</span>` : ""}</td>
  </tr>`).join("");
  return `
    <article class="news-card">
      <span class="source-meta">Financiadores de campanha (TSE)</span>
      <strong>${escapeHtml(money(f.total))} em ${f.count} doação(ões)</strong>
      <div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Doador</th><th>Tipo</th><th>Documento</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table></div>
    </article>`;
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
    const inactive = !isSituacaoAtiva(s);
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
    self_dealing: "Self-dealing",
    porta_giratoria: "Porta giratória",
    rede_societaria: "Rede societária",
    empresas_inaptas: "Empresas inaptas"
  };
  const comps = Object.entries(pr.components || {})
    .map(([k, v]) => `<span class="entity-pill ${v > 0 ? "score-mid" : "score-low"}">${escapeHtml(COMP_LABEL[k] || k)}: ${Number(v) || 0}</span>`)
    .join("");
  const selfDealing = pr.signals?.self_dealing_companies || [];
  return `
    <article class="news-card">
      <span class="source-meta">Risco político (sinais de captura)</span>
      <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:6px">
        <span style="font-size:1.6rem;font-weight:800;color:${color}">${score}</span>
        <span style="font-size:.8rem;opacity:.6">/ 100 · risco ${escapeHtml(bandLabel)}</span>
      </div>
      <div class="score-bar-wrap"><div class="score-bar-fill" style="width:${score}%"></div></div>
      ${selfDealing.length ? `<div class="activity-alert" style="margin-top:8px"><span class="alert-icon">⚠</span><span style="font-size:.78rem"><strong>Self-dealing:</strong> sócio de fornecedor da PRÓPRIA agência — ${selfDealing.map((n) => escapeHtml(n)).join(", ")}</span></div>` : ""}
      ${pr.signals?.patrimonio_declarado ? `<p style="font-size:.72rem;opacity:.55;margin:6px 0 0">Patrimônio declarado (TSE): ${escapeHtml(money(pr.signals.patrimonio_declarado))}</p>` : ""}
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
      // Autor CLICAVEL quando resolvido a uma pessoa (data-person-id -> dossiê).
      // Fallback: texto puro (autores[] ausente, ou autor institucional/sem match).
      const autores = Array.isArray(p.autores) && p.autores.length
        ? p.autores
        : (p.autor ? [{ autor_nome: p.autor, person_id: null }] : []);
      const autoresHtml = autores.slice(0, 3).map((a) =>
        a.person_id
          ? `<button type="button" class="link-author" data-person-id="${escapeHtml(a.person_id)}">${escapeHtml(a.autor_nome)}</button>`
          : escapeHtml(a.autor_nome)
      ).join(", ");
      return `
      <article class="news-card target-card">
        <div class="card-body">
          <div class="card-head">
            ${TARGET_ICO}
            <div>
              <strong>${escapeHtml(p.titulo || `${p.tipo || ""} ${p.numero || ""}`)}</strong>
              <span class="card-sub">${escapeHtml(p.casa || "")}${autoresHtml ? " · " + autoresHtml : ""}</span>
            </div>
          </div>
          <p>${escapeHtml((p.ementa || "Sem ementa.").slice(0, 300))}</p>
          <div class="entity-row">
            <span class="entity-pill">${escapeHtml(p.casa || "")}</span>
            ${p.tipo ? `<span class="entity-pill">${escapeHtml(p.tipo)}</span>` : ""}
            ${p.situacao ? `<span class="entity-pill">${escapeHtml(p.situacao)}</span>` : ""}
            ${(Array.isArray(p.themes) ? p.themes : []).slice(0, 2).map((t) => `<span class="entity-pill">${escapeHtml(t)}</span>`).join("")}
            ${url ? `<a class="entity-pill" href="${escapeHtml(url)}" target="_blank" rel="noopener">Abrir ↗</a>` : ""}
          </div>
        </div>
        ${cardFoot("var(--purple)", (p.casa || "Legislativo"), "LINCE//LEG")}
      </article>`;
    })
    .join("");
}

// ══════════════════ Eventos (M25 — gestão de seminários IRIS) ══════════════════
// Checklist interativo multi-evento: colunas DINÂMICAS (planilha) + visão por
// categoria, sobre o mesmo dado. Molde do módulo Painéis. Multiplexa em ?type=evt_*.
// (Nada a ver com legislative_eventos/agenda da Câmara.)
let eventoWired = false;
const EVT_TYPES = ["text", "date", "select", "check", "url", "num"];

// F-EVT7: constantes da Base (funil de associados) — IDÊNTICAS ao backend (EVT_REL).
const EVT_REL = ["Contato", "Prospect patrocinio", "Prospect associado", "Patrocinador", "Associado", "Institucional"];
const EVT_COTA_ASSOC = ["", "Apoiador", "Bronze", "Prata", "Ouro", "Platinum"];
function renderEventosToggle(cur) {
  const pill = (v, l) => `<button type="button" class="entity-pill ${cur === v ? "score-high" : ""}" data-eventos-view="${v}">${l}</button>`;
  return `<article class="news-card"><div class="entity-row" style="gap:6px">${pill("lista", "Eventos")}${pill("base", "Base de contatos")}</div></article>`;
}
async function loadEventos() {
  const grid = $("#eventos-grid"), detail = $("#evento-detail");
  if (!grid) return;
  wireEvento();
  state.currentEventoId = null;
  if (detail) { detail.hidden = true; detail.innerHTML = ""; }
  grid.hidden = false;
  if (state.eventosView === "base") return loadBase();  // F-EVT7: aba Base de contatos
  grid.innerHTML = emptyCard("Eventos", "Carregando…");
  try {
    const [r, rp] = await Promise.all([
      requestJson("/api/intelligence?type=evt_list"),
      requestJson("/api/intelligence?type=evt_pauta").catch(() => ({ items: [] }))
    ]);
    const items = r?.items || [], totais = r?.totais || {};
    if (!items.length) { grid.innerHTML = renderEventosToggle("lista") + emptyCard("Eventos", "Nenhum evento ainda. Clique em “+ Novo evento”."); return; }
    // Pauta da semana (cross-evento): tarefas + próximas-ações mais próximas/vencidas.
    const pauta = (rp?.items || []);
    const now = Date.now();
    const pautaBlock = pauta.length ? `<article class="news-card"><span class="source-meta">Pauta da semana</span>
      <ul style="list-style:none;margin:6px 0 0;padding:0">${pauta.slice(0, 14).map((it) => { const dt = new Date(it.date + "T12:00:00"); const late = !Number.isNaN(dt.getTime()) && dt.getTime() < now; return `<li class="entity-row" style="gap:10px;align-items:baseline;padding:6px 0;border-bottom:1px solid var(--border)"><span style="font-family:monospace;min-width:60px;color:${late ? "var(--red)" : "var(--muted,#8a9)"}">${escapeHtml(String(it.date).slice(5))}</span><span class="entity-pill" style="font-size:.68rem">${escapeHtml(it.kind)}</span><span style="flex:1">${escapeHtml(it.txt)}</span><span class="card-sub">${escapeHtml(it.evento || "")}${it.who ? " · " + escapeHtml(it.who) : ""}</span></li>`; }).join("")}</ul></article>` : "";
    // Histórico: barra de totais (comparativo geral).
    const statusStr = Object.entries(totais.por_status || {}).map(([k, v]) => `${v} ${escapeHtml(k)}`).join(" · ");
    const totalsBar = `<article class="news-card"><span class="source-meta">Histórico — visão geral</span>
      <div class="entity-row" style="flex-wrap:wrap;gap:10px;margin-top:6px">
        <span class="entity-pill">${totais.n_eventos || 0} eventos${statusStr ? " (" + statusStr + ")" : ""}</span>
        <span class="entity-pill">Arrecadado ${money(totais.arrecadado_rs || 0)}</span>
        <span class="entity-pill">${totais.publico || 0} confirmados</span>
        <span class="entity-pill">${totais.painelistas || 0} painelistas</span>
      </div></article>`;
    const cards = items.map((e) => {
      const m = e.metricas || {};
      return `<article class="news-card target-card selectable" data-open-evento="${escapeHtml(e.id)}">
      <div class="card-body">
        <div class="card-head"><div>
          <strong>${escapeHtml(e.nome)}</strong>
          <span class="card-sub">${e.data_evento ? escapeHtml(String(e.data_evento).slice(0, 10)) + " · " : ""}${escapeHtml(e.local || "")}</span>
        </div></div>
        <div class="entity-row" style="flex-wrap:wrap">
          <span class="entity-pill">${escapeHtml(e.status || "")}</span>
          <span class="entity-pill">${m.convidados?.confirmados || 0} confirmados</span>
          <span class="entity-pill">${money(m.patrocinio?.fechado_rs || 0)}</span>
          <span class="entity-pill">${m.painelistas?.confirmados || 0}/${m.painelistas?.total || 0} painelistas</span>
          <span class="entity-pill">checklist ${m.checklist?.pct || 0}%</span>
          <button type="button" class="entity-pill" data-evento-del="${escapeHtml(e.id)}">Excluir</button>
        </div>
      </div>
      ${cardFoot("var(--blue)", e.status || "Evento", "LINCE//EVENTO")}
    </article>`; }).join("");
    // Gráfico de evolução (público e patrocínio por evento, ordem cronológica).
    const chron = items.slice().reverse();
    const pubSeries = chron.map((e) => ({ total: e.metricas?.convidados?.confirmados || 0 }));
    const patrSeries = chron.map((e) => ({ total: e.metricas?.patrocinio?.fechado_rs || 0 }));
    const hasPub = pubSeries.some((s) => s.total > 0), hasPatr = patrSeries.some((s) => s.total > 0);
    const charts = (hasPub || hasPatr) ? `<article class="news-card"><span class="source-meta">Evolução (por evento)</span>
      <div class="entity-row" style="gap:24px;flex-wrap:wrap;margin-top:6px">
        ${hasPub ? `<div><div style="font-size:.72rem;opacity:.6;margin-bottom:2px">Público confirmado</div>${buildMiniChart(pubSeries, 0)}</div>` : ""}
        ${hasPatr ? `<div><div style="font-size:.72rem;opacity:.6;margin-bottom:2px">Patrocínio fechado (R$)</div>${buildMiniChart(patrSeries, 0)}</div>` : ""}
      </div></article>` : "";
    const comparativo = `<article class="news-card"><span class="source-meta">Comparativo entre eventos</span>
      <div style="overflow-x:auto;margin-top:6px"><table class="data-table"><thead><tr><th>Evento</th><th>Data</th><th>Público</th><th>Patrocínio</th><th>Painelistas</th><th>Checklist</th></tr></thead><tbody>${items.map((e) => { const m = e.metricas || {}; return `<tr><td>${escapeHtml(e.nome)}</td><td>${e.data_evento ? escapeHtml(String(e.data_evento).slice(0, 10)) : "—"}</td><td>${m.convidados?.confirmados || 0}</td><td>${money(m.patrocinio?.fechado_rs || 0)}</td><td>${m.painelistas?.confirmados || 0}/${m.painelistas?.total || 0}</td><td>${m.checklist?.pct || 0}%</td></tr>`; }).join("")}</tbody></table></div></article>`;
    grid.innerHTML = renderEventosToggle("lista") + pautaBlock + totalsBar + charts + cards + comparativo;
  } catch (e) { grid.innerHTML = renderEventosToggle("lista") + emptyCard("Eventos", `Falha: ${e.message}`); }
}

// ══════════════ F-EVT7: Base de contatos (funil de associados) ══════════════
async function loadBase() {
  const grid = $("#eventos-grid");
  if (!grid) return;
  grid.innerHTML = renderEventosToggle("base") + `<article class="news-card"><span class="card-sub">Carregando base…</span></article>`;
  try {
    const [rc, re] = await Promise.all([
      requestJson(`/api/intelligence?type=evt_contato_list${state.baseRel ? "&rel=" + encodeURIComponent(state.baseRel) : ""}`),
      requestJson("/api/intelligence?type=evt_list").catch(() => ({ items: [] }))
    ]);
    state.base = { contatos: rc.items || [], total: rc.total || 0, eventos: re.items || [] };
    renderBaseInto(grid);
  } catch (e) { grid.innerHTML = renderEventosToggle("base") + emptyCard("Base", `Falha: ${e.message}`); }
}
function renderBaseRows() {
  const b = state.base || { contatos: [], eventos: [] };
  const q = (state.baseQ || "").toLowerCase();
  let cts = b.contatos || [];
  if (q) cts = cts.filter((c) => (c.nome || "").toLowerCase().includes(q) || (c.empresa || "").toLowerCase().includes(q));
  const bcSel = (c, field, opts, val) => `<select data-bc-id="${escapeHtml(c.id)}" data-bc-field="${field}" class="dou-date">${opts.map((o) => `<option value="${escapeHtml(o)}" ${String(val || "") === o ? "selected" : ""}>${escapeHtml(o || "—")}</option>`).join("")}</select>`;
  const bcInp = (c, field, val) => `<input data-bc-id="${escapeHtml(c.id)}" data-bc-field="${field}" class="dou-date" style="min-width:100px" value="${escapeHtml(val == null ? "" : String(val))}">`;
  const origemNome = (id) => { const e = (b.eventos || []).find((x) => x.id === id); return e ? e.nome : ""; };
  return cts.map((c) => `<tr>
    <td>${bcInp(c, "nome", c.nome)}</td>
    <td>${bcInp(c, "empresa", c.empresa)}</td>
    <td>${bcInp(c, "cargo", c.cargo)}</td>
    <td>${bcInp(c, "setor", c.setor)}</td>
    <td>${bcInp(c, "email", c.email)}</td>
    <td>${bcInp(c, "telefone", c.telefone)}</td>
    <td>${bcSel(c, "rel", EVT_REL, c.rel)}</td>
    <td>${bcSel(c, "cota_assoc", EVT_COTA_ASSOC, c.cota_assoc)}</td>
    <td class="card-sub" style="font-size:.72rem">${escapeHtml(origemNome(c.origem_evento_id))}</td>
    <td style="white-space:nowrap"><button type="button" class="entity-pill" data-bc-pipe="${escapeHtml(c.id)}" title="Criar alvo no pipeline do evento selecionado">→ pipeline</button> <button type="button" class="entity-pill" data-bc-del="${escapeHtml(c.id)}">×</button></td>
  </tr>`).join("") || `<tr><td colspan="10"><span class="card-sub">Base vazia. Importe uma lista ou traga os confirmados de um evento.</span></td></tr>`;
}
function renderBaseInto(grid) {
  const b = state.base || { contatos: [], eventos: [] };
  const eventoOpts = (b.eventos || []).map((e) => `<option value="${escapeHtml(e.id)}">${escapeHtml(e.nome)}</option>`).join("") || "<option value=''>—</option>";
  const relFilter = `<select id="base-rel" class="dou-date"><option value="">Todas as relações</option>${EVT_REL.map((r) => `<option ${state.baseRel === r ? "selected" : ""}>${r}</option>`).join("")}</select>`;
  grid.innerHTML = renderEventosToggle("base") + `<article class="news-card">
    <span class="source-meta">Base de contatos — funil de associados${b.total ? ` (${b.total})` : ""}</span>
    <div class="entity-row" style="gap:6px;flex-wrap:wrap;margin:6px 0">
      <input id="base-search" type="search" class="dou-date" style="min-width:160px" placeholder="Buscar nome/empresa…" value="${escapeHtml(state.baseQ || "")}">
      ${relFilter}
      <button type="button" class="entity-pill" id="base-add">+ contato</button>
      <button type="button" class="entity-pill" id="base-import-btn">importar lista</button>
      <span style="border-left:1px solid var(--border);padding-left:8px;font-size:.8rem">Evento: <select id="base-evento" class="dou-date">${eventoOpts}</select></span>
      <button type="button" class="entity-pill" id="base-from-conv" title="Traz os convidados CONFIRMADOS do evento selecionado para a Base (origem)">confirmados → Base</button>
    </div>
    <div id="base-import-box" hidden style="margin:6px 0"><textarea id="base-import-text" class="dou-date" style="width:100%;min-height:80px" placeholder="Cole a lista (uma linha por contato): Nome – Empresa"></textarea><div class="entity-row" style="gap:6px"><button type="button" class="entity-pill" id="base-import-do">Importar (origem = evento selecionado)</button><span id="base-import-status" class="card-sub"></span></div></div>
    <div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Nome</th><th>Empresa</th><th>Cargo</th><th>Setor</th><th>E-mail</th><th>Telefone</th><th>Relação</th><th>Cota assoc.</th><th>Origem</th><th></th></tr></thead><tbody id="base-tbody">${renderBaseRows()}</tbody></table></div>
    <p class="card-sub" style="margin:4px 0 0">Quem não fecha cota de patrocínio vira prospect de associado. A régua de associação começa em Apoiador.</p>
  </article>`;
}
async function bcSave(id, patch) {
  const c = (state.base?.contatos || []).find((x) => String(x.id) === String(id));
  if (c) Object.assign(c, patch);
  try {
    const r = await postJson("/api/intelligence?type=evt_contato_save", { id, ...patch });
    if (!r?.ok) throw new Error(r?.error || "erro");
  } catch (e) { alert(`Falha ao salvar: ${e.message}`); loadBase(); }
}
function baseEventoSel() { return $("#base-evento")?.value || ""; }
async function baseAdd() {
  const nome = prompt("Nome do contato:");
  if (!nome || !nome.trim()) return;
  try { const r = await postJson("/api/intelligence?type=evt_contato_save", { nome: nome.trim() }); if (!r?.ok) throw new Error(r?.error || "erro"); loadBase(); }
  catch (e) { alert(`Falha: ${e.message}`); }
}
async function baseImportDo() {
  const texto = $("#base-import-text")?.value || "", st = $("#base-import-status");
  if (!texto.trim()) return;
  if (st) st.textContent = "Importando…";
  try {
    const r = await postJson("/api/intelligence?type=evt_contato_import", { texto, origem_evento_id: baseEventoSel() || null });
    if (!r?.ok) throw new Error(r?.error || "erro");
    if (st) st.textContent = `${r.inserted} adicionado(s), ${r.pulados} pulado(s).`;
    loadBase();
  } catch (e) { if (st) st.textContent = `Falha: ${e.message}`; }
}
async function baseFromConvidados() {
  const evento_id = baseEventoSel();
  if (!evento_id) { alert("Selecione um evento."); return; }
  try {
    const r = await postJson("/api/intelligence?type=evt_contato_from_convidados", { evento_id });
    if (!r?.ok) throw new Error(r?.error || "erro");
    toast(`${r.inserted} confirmado(s) → Base (${r.pulados} já existiam).`);
    loadBase();
  } catch (e) { alert(`Falha: ${e.message}`); }
}
async function baseToPipeline(id) {
  const evento_id = baseEventoSel();
  if (!evento_id) { alert("Selecione o evento de destino."); return; }
  try {
    const r = await postJson("/api/intelligence?type=evt_contato_to_pipeline", { id, evento_id });
    if (!r?.ok) throw new Error(r?.error || "erro");
    toast("Contato → pipeline (Alvo).");
    loadBase();
  } catch (e) { alert(`Falha: ${e.message}`); }
}
// Referida no pipeline (B): leva um patrocinador Perdido/Associado p/ a Base (funil de associado).
async function contatoFromPatrocinador(patrId) {
  const p = (state.eventoData?.patrocinadores || []).find((x) => String(x.id) === String(patrId));
  if (!p) return;
  const rel = p.estagio === "Associado" ? "Associado" : "Prospect associado";
  try {
    const r = await postJson("/api/intelligence?type=evt_contato_save", {
      nome: p.contato || p.nome, empresa: p.nome, company_id: p.company_id || null,
      origem_evento_id: state.currentEventoId, rel
    });
    if (!r?.ok) throw new Error(r?.error || "erro");
    toast(`${p.nome} → Base (${rel}).`);
  } catch (e) { alert(`Falha: ${e.message}`); }
}
function toast(msg) { // F-EVT7: toast leve auto-contido (sem tocar no index.html)
  let el = document.getElementById("lince-toast");
  if (!el) {
    el = document.createElement("div"); el.id = "lince-toast";
    el.style.cssText = "position:fixed;bottom:22px;left:50%;transform:translateX(-50%);background:var(--blue-bright,#2b6cb0);color:#fff;padding:10px 18px;border-radius:8px;font-size:13px;z-index:9999;box-shadow:0 8px 24px rgba(0,0,0,.4);transition:opacity .3s;max-width:80vw";
    document.body.appendChild(el);
  }
  el.textContent = msg; el.style.opacity = "1"; clearTimeout(el._t); el._t = setTimeout(() => { el.style.opacity = "0"; }, 2200);
}

async function openEvento(id) {
  const grid = $("#eventos-grid"), detail = $("#evento-detail");
  if (!detail) return;
  state.currentEventoId = id;
  state.eventoCatCollapsed = new Set(); // F-EVT5: colapso é por-evento (não vaza entre eventos)
  state.eventoTab = state.eventoTab || "checklist";
  state.eventoView = state.eventoView || "planilha";
  if (grid) grid.hidden = true;
  detail.hidden = false;
  detail.innerHTML = emptyCard("Evento", "Abrindo…");
  try {
    const d = await requestJson(`/api/intelligence?type=evt_get&id=${encodeURIComponent(id)}`);
    if (!d?.ok) throw new Error(d?.error || "erro");
    state.eventoData = d;
    renderEventoDetail(d);
  } catch (e) { detail.innerHTML = emptyCard("Evento", `Falha: ${e.message}`); }
}

function renderEventoDetail(d) {
  const detail = $("#evento-detail");
  if (!detail || !d) return;
  const ev = d.evento || {};
  const tab = state.eventoTab || "checklist";
  const tabs = [
    ["pauta", "Pauta"],
    ["checklist", `Checklist (${(d.itens || []).length})`],
    ["programacao", `Programação (${(d.programacao || []).length})`],
    ["painelistas", `Painelistas (${(d.painelistas || []).length})`],
    ["patrocinio", `Patrocínio (${(d.patrocinadores || []).length})`],
    ["convidados", `Convidados (${(d.convidados || []).length})`],
    ["dados", "Dados"]
  ];
  detail.innerHTML = `
    <article class="news-card">
      <div class="entity-row" style="justify-content:space-between">
        <button type="button" class="entity-pill" data-evento-back>&larr; Eventos</button>
        <button type="button" class="entity-pill" data-evento-export title="Baixa um Markdown do evento p/ o Claude Design">Exportar (.md)</button>
      </div>
      <div class="entity-row" style="gap:8px;flex-wrap:wrap;align-items:baseline"><strong>${escapeHtml(ev.nome || "Evento")}</strong>${evtCountdown(ev.data_evento)}</div>
      <span class="card-sub">${ev.data_evento ? escapeHtml(String(ev.data_evento).slice(0, 10)) : "sem data"}${ev.local ? " · " + escapeHtml(ev.local) : ""} · ${escapeHtml(ev.status || "")}</span>
      <div class="dossier-tabs">${tabs.map(([id2, lbl]) => `<button type="button" class="dossier-tab ${tab === id2 ? "active" : ""}" data-evento-tab="${id2}">${lbl}</button>`).join("")}</div>
    </article>
    <div id="evento-tab-content">${renderEventoTab(d, tab)}</div>`;
}

// F-EVT7 (C): countdown + auto-dating por offset + agenda (a view da reunião).
function evtIsoDate(s) { if (!s) return null; const dt = new Date(String(s).slice(0, 10) + "T12:00:00"); return Number.isNaN(dt.getTime()) ? null : dt; }
function evtCountdown(dataEvento) {
  const ev = evtIsoDate(dataEvento);
  if (!ev) return "";
  const dias = Math.round((ev.getTime() - Date.now()) / 86400000);
  if (dias > 0) return `<span class="entity-pill" style="background:var(--blue-bright,#2b6cb0);color:#fff">faltam ${dias} dia${dias === 1 ? "" : "s"}</span>`;
  if (dias === 0) return `<span class="entity-pill" style="background:var(--amber,#e0a500);color:#0A1424">é hoje</span>`;
  return `<span class="entity-pill" style="opacity:.7">há ${Math.abs(dias)} dia(s)</span>`;
}
// Prazo EFETIVO de um item: prazo fixado à mão, senão data_evento + offset (D-x). (auto-dating)
function evtItemPrazo(it, dataEvento) {
  const v = it.valores || {};
  if (v.prazo) return String(v.prazo).slice(0, 10);
  if (v.offset != null && v.offset !== "" && dataEvento) { const dt = evtIsoDate(dataEvento); if (dt) { dt.setDate(dt.getDate() + Number(v.offset)); return dt.toISOString().slice(0, 10); } }
  return null;
}
function evtAgendaItems(d) {
  const dataEvento = d.evento && d.evento.data_evento, out = [];
  (d.itens || []).forEach((it) => { const v = it.valores || {}; if (v.status === "feito") return; const dt = evtIsoDate(evtItemPrazo(it, dataEvento)); if (dt) out.push({ dt, kind: "tarefa", txt: v.item || "(item)", who: v.responsavel || v.categoria || "" }); });
  (d.patrocinadores || []).forEach((p) => { if (!EVT_ESTAGIOS_ATIVOS.has(p.estagio || "Alvo") || !p.proxima_acao || !p.data_acao) return; const dt = evtIsoDate(p.data_acao); if (dt) out.push({ dt, kind: "pipeline", txt: p.proxima_acao + " — " + (p.nome || "empresa"), who: p.porta || "" }); });
  out.sort((a, z) => a.dt - z.dt);
  return out;
}
function renderEventoPauta(d) {
  const ev = d.evento || {}, m = d.metricas || {};
  const agenda = evtAgendaItems(d), now = Date.now();
  const fmtd = (dt) => dt.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" }).replace(".", "");
  const agendaHtml = agenda.length ? agenda.slice(0, 20).map((it) => {
    const late = it.dt.getTime() < now;
    return `<li class="entity-row" style="gap:10px;align-items:baseline;padding:6px 0;border-bottom:1px solid var(--border)"><span style="font-family:monospace;min-width:60px;color:${late ? "var(--red)" : "var(--muted,#8a9)"}">${fmtd(it.dt)}</span><span class="entity-pill" style="font-size:.68rem">${it.kind}</span><span style="flex:1">${escapeHtml(it.txt)}</span>${it.who ? `<span class="card-sub">${escapeHtml(it.who)}</span>` : ""}</li>`;
  }).join("") : `<li class="card-sub" style="list-style:none">Sem tarefas com prazo nem próximas-ações. Defina a data do evento, prazos no checklist e ações no pipeline.</li>`;
  const metas = (ev.metadata && ev.metadata.metas) || {};
  const fechado = m.patrocinio?.fechado_rs || 0, conf = m.convidados?.confirmados || 0;
  // metas são strings livres (dado do usuário) — parsear p/ NÚMERO antes de qualquer math/format (evita XSS via money(raw) + NaN%).
  const metaP = Number(String(metas.patrocinio || "").replace(/[^\d]/g, "")) || 0;
  const metaPub = Number(String(metas.publico || "").replace(/[^\d]/g, "")) || 0;
  const metaBlock = (metaP || metaPub) ? `<div class="entity-row" style="gap:20px;flex-wrap:wrap;margin-top:8px">
    ${metaP ? `<div><div class="card-sub">Patrocínio (meta)</div><strong>${money(fechado)}</strong> / ${money(metaP)} <span class="card-sub">${Math.round(fechado / metaP * 100)}%</span></div>` : ""}
    ${metaPub ? `<div><div class="card-sub">Público (meta)</div><strong>${conf}</strong> / ${metaPub} <span class="card-sub">${Math.round(conf / metaPub * 100)}%</span></div>` : ""}
  </div>` : "";
  return `<article class="news-card">
    <span class="source-meta">Pauta do evento</span>
    ${metaBlock}
    <h4 style="margin:12px 0 4px;font-size:.9rem">Funil do pipeline</h4>
    ${patrFunil(d.patrocinadores || [])}
    <h4 style="margin:12px 0 4px;font-size:.9rem">Agenda — tarefas do checklist + próximas ações do pipeline</h4>
    <ul style="list-style:none;margin:0;padding:0">${agendaHtml}</ul>
  </article>`;
}
function renderEventoTab(d, tab) {
  if (tab === "pauta") return renderEventoPauta(d);
  if (tab === "dados") return renderEventoDados(d);
  if (tab === "programacao") return renderEventoProgramacao(d);
  if (tab === "painelistas") return renderEventoPainelistas(d);
  if (tab === "patrocinio") return renderEventoPatrocinadores(d);
  if (tab === "convidados") return renderEventoConvidados(d);
  return renderEventoChecklist(d);
}

// Célula editável genérica de sub-entidade (data-esub-* → um só handler de change).
const EVT_LISTKEY = { painelista: "painelistas", patrocinador: "patrocinadores", convidado: "convidados", programacao: "programacao" };
function esubCell(kind, id, field, kindType, val, opts) {
  const a = `data-esub-kind="${kind}" data-esub-id="${escapeHtml(id)}" data-esub-field="${field}"`;
  if (kindType === "select") return `<select ${a} class="dou-date">${(opts || []).map((o) => `<option value="${escapeHtml(o)}" ${String(val || "") === o ? "selected" : ""}>${escapeHtml(o || "—")}</option>`).join("")}</select>`;
  if (kindType === "num") return `<input type="number" ${a} class="dou-date" style="width:100px" value="${val == null ? "" : escapeHtml(String(val))}">`;
  if (kindType === "date") return `<input type="date" ${a} class="dou-date" style="width:132px" value="${escapeHtml(String(val || "").slice(0, 10))}">`;
  return `<input ${a} class="dou-date" style="min-width:110px" value="${escapeHtml(val == null ? "" : String(val))}">`;
}

function renderEventoDados(d) {
  const ev = d.evento || {};
  const STATUS = ["planejamento", "confirmado", "realizado", "cancelado"];
  return `<article class="news-card">
    <span class="source-meta">Dados do evento</span>
    <div class="entity-row" style="flex-wrap:wrap;gap:6px;margin-top:8px">
      <input id="ev-nome" class="dou-date" style="min-width:220px;flex:1" placeholder="Nome" value="${escapeHtml(ev.nome || "")}">
      <input id="ev-data" type="date" class="dou-date" value="${escapeHtml(String(ev.data_evento || "").slice(0, 10))}">
      <input id="ev-horario" class="dou-date" style="width:130px" placeholder="Horário" value="${escapeHtml(ev.horario || "")}">
    </div>
    <div class="entity-row" style="flex-wrap:wrap;gap:6px;margin-top:6px">
      <input id="ev-local" class="dou-date" style="min-width:220px;flex:1" placeholder="Local" value="${escapeHtml(ev.local || "")}">
      <select id="ev-status" class="dou-date">${STATUS.map((s) => `<option value="${s}" ${ev.status === s ? "selected" : ""}>${s}</option>`).join("")}</select>
    </div>
    <textarea id="ev-desc" class="dou-date" style="width:100%;min-height:60px;margin-top:6px" placeholder="Descrição">${escapeHtml(ev.descricao || "")}</textarea>
    <textarea id="ev-objetivos" class="dou-date" style="width:100%;min-height:60px;margin-top:6px" placeholder="Objetivos do evento (um por linha)">${escapeHtml((ev.objetivos || []).join("\n"))}</textarea>
    <div class="entity-row" style="margin-top:6px"><button type="button" class="alert-btn primary" id="ev-save">Salvar</button><span id="ev-save-status" style="font-size:.75rem;opacity:.6"></span></div>
    ${(() => { const md = ev.metadata || {}, ow = md.owners || {}, mt = md.metas || {}; return `<div style="border-top:1px solid var(--border);margin-top:12px;padding-top:8px">
      <strong style="font-size:.9rem">Donos, metas e links</strong>
      <div class="entity-row" style="flex-wrap:wrap;gap:6px;margin-top:6px">
        <input id="ev-own-log" class="dou-date" style="width:150px" placeholder="Dono · Logística" value="${escapeHtml(ow.logistica || "")}">
        <input id="ev-own-mkt" class="dou-date" style="width:150px" placeholder="Dono · Marketing" value="${escapeHtml(ow.marketing || "")}">
        <input id="ev-own-cont" class="dou-date" style="width:150px" placeholder="Dono · Conteúdo" value="${escapeHtml(ow.conteudo || "")}">
        <input id="ev-own-imp" class="dou-date" style="width:150px" placeholder="Dono · Imprensa" value="${escapeHtml(ow.imprensa || "")}">
      </div>
      <div class="entity-row" style="flex-wrap:wrap;gap:6px;margin-top:6px">
        <input id="ev-meta-patr" class="dou-date" style="width:180px" placeholder="Meta de patrocínio (R$)" value="${escapeHtml(mt.patrocinio || "")}">
        <input id="ev-meta-pub" class="dou-date" style="width:150px" placeholder="Meta de público" value="${escapeHtml(mt.publico || "")}">
        <input id="ev-rsvp" class="dou-date" style="min-width:180px;flex:1" placeholder="Link do RSVP" value="${escapeHtml(md.rsvp || "")}">
        <input id="ev-drive" class="dou-date" style="min-width:180px;flex:1" placeholder="Pasta no Drive" value="${escapeHtml(md.drive || "")}">
      </div>
      <div class="entity-row" style="margin-top:6px"><button type="button" class="entity-pill" id="ev-meta-save">Salvar info</button><span id="ev-meta-status" class="card-sub"></span></div>
    </div>`; })()}
  </article>`;
}
async function eventoMetaSave() {
  const st = $("#ev-meta-status"); if (st) st.textContent = "Salvando…";
  const meta = {
    owners: { logistica: $("#ev-own-log")?.value || "", marketing: $("#ev-own-mkt")?.value || "", conteudo: $("#ev-own-cont")?.value || "", imprensa: $("#ev-own-imp")?.value || "" },
    metas: { patrocinio: $("#ev-meta-patr")?.value || "", publico: $("#ev-meta-pub")?.value || "" },
    rsvp: $("#ev-rsvp")?.value || "", drive: $("#ev-drive")?.value || ""
  };
  try {
    const r = await postJson("/api/intelligence?type=evt_meta_save", { id: state.currentEventoId, meta });
    if (!r?.ok) throw new Error(r?.error || "erro");
    if (state.eventoData?.evento) state.eventoData.evento.metadata = r.metadata;
    if (st) st.textContent = "Salvo.";
  } catch (e) { if (st) st.textContent = `Falha: ${e.message}`; }
}

// Destaque de cronograma: prazo vencido/próximo (7d) em item não-concluído.
function evtRowStyle(it) {
  const v = it.valores || {};
  if (v.status === "feito") return "";
  const pr = evtItemPrazo(it, state.eventoData?.evento?.data_evento); // F-EVT7: prazo efetivo (manual OU offset)
  if (!pr) return "";
  const due = new Date(pr.slice(0, 10)).getTime();
  if (Number.isNaN(due)) return "";
  if (due <= Date.now()) return "background:rgba(220,80,80,.14)";
  if (due <= Date.now() + 7 * 864e5) return "background:rgba(220,180,0,.12)";
  return "";
}

function evtCell(it, c) {
  const v = (it.valores || {})[c.key];
  const a = `data-evt-id="${escapeHtml(it.id)}" data-evt-key="${escapeHtml(c.key)}"`;
  if (c.type === "check") return `<input type="checkbox" ${a} ${v ? "checked" : ""}>`;
  if (c.key === "prazo") { // F-EVT7: coluna prazo mostra a data derivada do offset (D-x) quando não há data manual
    const off = (it.valores || {}).offset, de = state.eventoData?.evento?.data_evento;
    const der = (!v && off != null && off !== "" && de) ? evtItemPrazo(it, de) : null;
    const hint = der ? ` <span class="d" title="D${off} a partir da data do evento (automático)">D${Number(off) >= 0 ? "+" + off : off}·${escapeHtml(String(der).slice(5))}</span>` : "";
    return `<input type="date" class="dou-date" style="min-width:130px" ${a} value="${escapeHtml(String(v || "").slice(0, 10))}">${hint}`;
  }
  if (c.type === "date") return `<input type="date" class="dou-date" style="min-width:130px" ${a} value="${escapeHtml(String(v || "").slice(0, 10))}">`;
  if (c.type === "num") return `<input type="number" class="dou-date" style="width:90px" ${a} value="${escapeHtml(v == null ? "" : String(v))}">`;
  if (c.type === "select") {
    const opts = ["", ...(Array.isArray(c.options) ? c.options : [])];
    return `<select class="dou-date" ${a}>${opts.map((o) => `<option value="${escapeHtml(o)}" ${String(v || "") === o ? "selected" : ""}>${escapeHtml(o || "—")}</option>`).join("")}</select>`;
  }
  if (c.type === "url") {
    const u = safeUrl(v);
    return `<input class="dou-date" style="min-width:150px" ${a} value="${escapeHtml(v == null ? "" : String(v))}" placeholder="https://...">${u ? ` <a href="${escapeHtml(u)}" target="_blank" rel="noopener">↗</a>` : ""}`;
  }
  return `<input class="dou-date" style="min-width:140px" ${a} value="${escapeHtml(v == null ? "" : String(v))}">`;
}

// F-EVT5: ordem canônica das áreas = options da coluna 'categoria'; extras depois; "Sem área" por último.
function evtAreaOrder(cols, itens) {
  const catCol = (cols || []).find((c) => c.key === "categoria");
  const canonical = (catCol && Array.isArray(catCol.options)) ? catCol.options : [];
  const present = new Set((itens || []).map((it) => (it.valores || {}).categoria || ""));
  const order = [];
  for (const c of canonical) if (present.has(c)) order.push(c);            // canônicas presentes, na ordem
  for (const c of present) if (c && !canonical.includes(c)) order.push(c); // extras (não canônicas)
  if (present.has("")) order.push("");                                     // "Sem área" por último
  return order;
}

// F-EVT5: planilha AGRUPADA por área. Cabeçalho por seção (progresso, +item, recolher),
// coluna 'categoria' escondida (redundante) e um select "área" p/ mover o item de seção.
function renderChecklistPlanilha(cols, itens) {
  const cbtn = "background:none;border:none;cursor:pointer;opacity:.55;padding:0 1px;font-size:.85em";
  const bodyCols = cols.filter((c) => c.key !== "categoria");
  const catCol = cols.find((c) => c.key === "categoria");
  const areaOpts = (catCol && Array.isArray(catCol.options)) ? catCol.options.filter(Boolean) : [];
  const th = bodyCols.map((c) => `<th style="white-space:nowrap">${escapeHtml(c.label)} <button type="button" data-evento-col-ren="${escapeHtml(c.key)}" title="Renomear" style="${cbtn}">✎</button><button type="button" data-evento-col-del="${escapeHtml(c.key)}" title="Remover coluna" style="${cbtn}">×</button></th>`).join("");
  const colspan = bodyCols.length + 1;
  const collapsed = state.eventoCatCollapsed = state.eventoCatCollapsed || new Set();
  const byArea = new Map();
  for (const it of itens) { const c = (it.valores || {}).categoria || ""; if (!byArea.has(c)) byArea.set(c, []); byArea.get(c).push(it); }
  const moveCell = (it) => {
    const cur = (it.valores || {}).categoria || "";
    const opts = ["", ...areaOpts, ...(cur && !areaOpts.includes(cur) ? [cur] : [])];
    return `<select class="dou-date" data-evt-move="${escapeHtml(it.id)}" title="Mover de área" style="font-size:.72rem;opacity:.6;max-width:120px">${opts.map((o) => `<option value="${escapeHtml(o)}" ${cur === o ? "selected" : ""}>${escapeHtml(o || "— área")}</option>`).join("")}</select>`;
  };
  const sections = evtAreaOrder(cols, itens).map((area) => {
    const list = byArea.get(area) || [];
    const done = list.filter((it) => (it.valores || {}).status === "feito").length;
    const isCol = collapsed.has(area);
    const head = `<tr><td colspan="${colspan}" style="background:var(--surface-2,rgba(127,127,127,.09));padding:6px 8px">
        <button type="button" data-evt-cat-toggle="${escapeHtml(area)}" style="background:none;border:none;cursor:pointer;font-weight:600;color:inherit;font-size:.9em">${isCol ? "▸" : "▾"} ${escapeHtml(area || "Sem área")}</button>
        <span class="card-sub"> · ${done}/${list.length} feito</span>
        <button type="button" class="entity-pill" data-evt-add-cat="${escapeHtml(area)}" style="margin-left:8px;font-size:.72rem">+ item</button>
      </td></tr>`;
    if (isCol) return head;
    const rows = list.map((it) => `<tr data-evt-row="${escapeHtml(it.id)}" style="${evtRowStyle(it)}">${bodyCols.map((c) => `<td>${evtCell(it, c)}</td>`).join("")}<td style="white-space:nowrap">${moveCell(it)} <button type="button" class="entity-pill" data-evento-item-del="${escapeHtml(it.id)}">×</button></td></tr>`).join("");
    return head + rows;
  }).join("");
  return `<div style="overflow-x:auto;margin-top:8px"><table class="data-table"><thead><tr>${th}<th><button type="button" class="entity-pill" id="evento-col-add">+ coluna</button></th></tr></thead><tbody>${sections || `<tr><td colspan="${colspan}">Sem itens.</td></tr>`}</tbody></table></div>
    <div class="entity-row" style="gap:6px;margin-top:8px;flex-wrap:wrap"><button type="button" class="alert-btn primary" id="evento-item-add">+ linha</button><button type="button" class="entity-pill" id="evt-area-collapse-all">recolher tudo</button><button type="button" class="entity-pill" id="evt-area-expand-all">expandir tudo</button></div>`;
}

function renderChecklistCategoria(cols, itens) {
  const groups = new Map();
  for (const it of itens) {
    const cat = (it.valores || {}).categoria || "Sem categoria";
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(it);
  }
  if (!groups.size) return `<p style="margin-top:8px">Sem itens. Use a visão Planilha para adicionar.</p>`;
  return [...groups.entries()].map(([cat, list]) => {
    const rows = list.map((it) => {
      const v = it.valores || {}, done = v.status === "feito";
      return `<div class="director-row" style="${evtRowStyle(it)}">
        <input type="checkbox" data-evt-check-status="${escapeHtml(it.id)}" ${done ? "checked" : ""}>
        <div style="flex:1"><strong style="${done ? "text-decoration:line-through;opacity:.6" : ""}">${escapeHtml(v.item || "(sem título)")}</strong>
          <span class="card-sub">${v.responsavel ? escapeHtml(v.responsavel) + " · " : ""}${v.prazo ? "prazo " + escapeHtml(String(v.prazo).slice(0, 10)) : ""}</span></div>
        ${safeUrl(v.link) ? `<a href="${escapeHtml(safeUrl(v.link))}" target="_blank" rel="noopener" class="entity-pill">arte ↗</a>` : ""}
      </div>`;
    }).join("");
    return `<div style="margin-top:12px"><strong>${escapeHtml(cat)} (${list.length})</strong>${rows}</div>`;
  }).join("");
}

function renderEventoChecklist(d) {
  const cols = d.colunas || [], itens = d.itens || [];
  const vm = state.eventoView || "planilha";
  const pill = (m, lbl) => `<button type="button" class="entity-pill ${vm === m ? "score-high" : ""}" data-evento-view="${m}">${lbl}</button>`;
  const toolbar = `<div class="entity-row" style="justify-content:space-between;flex-wrap:wrap;gap:6px">
    <span class="source-meta">Checklist — ${itens.length} item(ns)</span>
    <div class="entity-row" style="gap:6px;flex-wrap:wrap"><button type="button" class="entity-pill" id="evt-seed-envios" title="Adiciona os itens de envio padrão que faltam (dedup)">+ itens de envio padrão</button>${pill("planilha", "Planilha")}${pill("categoria", "Por categoria")}</div>
  </div>`;
  return `<article class="news-card">${toolbar}${vm === "categoria" ? renderChecklistCategoria(cols, itens) : renderChecklistPlanilha(cols, itens)}</article>`;
}

// Mantém o state local em sincronia (p/ re-render sem refetch em edições de célula).
function evtLocalSet(id, patch) {
  const it = (state.eventoData?.itens || []).find((x) => String(x.id) === String(id));
  if (it) it.valores = { ...(it.valores || {}), ...patch };
}

async function evtCellUpdate(el) {
  const id = el.dataset.evtId, key = el.dataset.evtKey;
  if (!id || !key) return;
  const val = el.type === "checkbox" ? el.checked : el.value;
  evtLocalSet(id, { [key]: val });
  try {
    const r = await postJson("/api/intelligence?type=evt_item_update", { id, valores: { [key]: val } });
    if (!r?.ok) throw new Error(r?.error || "erro");
  } catch (e) { alert(`Falha ao salvar: ${e.message}`); openEvento(state.currentEventoId); }
}

async function eventoCreate() {
  const nome = window.prompt("Nome do evento:");
  if (!nome || !nome.trim()) return;
  try {
    const r = await postJson("/api/intelligence?type=evt_save", { nome: nome.trim() });
    if (r?.ok && r.evento) { await loadEventos(); openEvento(r.evento.id); } else alert(r?.error || "erro");
  } catch (e) { alert(`Falha: ${e.message}`); }
}

async function eventoSaveDados() {
  const status = $("#ev-save-status");
  if (status) status.textContent = "Salvando…";
  try {
    const r = await postJson("/api/intelligence?type=evt_save", {
      id: state.currentEventoId, nome: $("#ev-nome")?.value || "", data_evento: $("#ev-data")?.value || null,
      horario: $("#ev-horario")?.value || "", local: $("#ev-local")?.value || "", descricao: $("#ev-desc")?.value || "", status: $("#ev-status")?.value,
      objetivos: ($("#ev-objetivos")?.value || "").split(/\n/).map((s) => s.trim()).filter(Boolean)
    });
    if (!r?.ok) throw new Error(r?.error || "erro");
    if (state.eventoData) state.eventoData.evento = r.evento;
    if (status) status.textContent = "Salvo.";
  } catch (e) { if (status) status.textContent = `Falha: ${e.message}`; }
}

async function eventoAddRow(categoria) {
  try {
    const valores = categoria ? { categoria } : {};
    const r = await postJson("/api/intelligence?type=evt_item_add", { evento_id: state.currentEventoId, valores });
    if (r?.ok) openEvento(state.currentEventoId);
  } catch (e) { alert(`Falha: ${e.message}`); }
}

// F-EVT5: move um item de área (select "área ▾") → salva categoria + re-render (a linha pula de seção).
async function evtMoveArea(id, categoria) {
  evtLocalSet(id, { categoria });
  try {
    const r = await postJson("/api/intelligence?type=evt_item_update", { id, valores: { categoria } });
    if (!r?.ok) throw new Error(r?.error || "erro");
    renderEventoDetail(state.eventoData);
  } catch (e) { alert(`Falha: ${e.message}`); openEvento(state.currentEventoId); }
}

// F-EVT5: itens de envio padrão (materiais de envio do mês). Espelha o EVT_SEED do backend
// (api/intelligence.js). Backfill: insere os que faltam no evento atual (dedup por nome, sem acento).
const EVT_ENVIOS_PADRAO = [
  ["Carta-convite (painelistas)", "Comunicacao", "D-30"],
  ["Convite a orgaos/empresas p/ indicarem convidados (ate N)", "Comunicacao", "D-21 · variar por organizacao"],
  ["Convite + RSVP aos convidados (link do formulario)", "Comunicacao", "D-21"],
  ["Pedido de minibio + foto", "Comunicacao", "apos aceite"],
  ["Autorizacao de uso de imagem", "Comunicacao", "apos aceite"],
  ["Abrir RSVP (formulario)", "Comunicacao", "D-21"],
  ["Solicitar autorizacao de logo no LED/backdrop (patrocinadores)", "Comunicacao", "D-14"],
  ["Encaminhar programacao aos convidados", "Comunicacao", "D-3"],
  ["Lembrete de RSVP", "Comunicacao", "D-7 e D-2"],
  ["Confirmacao final + instrucoes de credenciamento", "Comunicacao", "D-2"],
  ["Revisar minibios antes de postar", "Marketing", "antes de cada post (QA)"]
];
async function evtSeedEnvios() {
  const d = state.eventoData; if (!d) return;
  const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  const have = new Set((d.itens || []).map((it) => norm((it.valores || {}).item)));
  const missing = EVT_ENVIOS_PADRAO.filter(([item]) => !have.has(norm(item)));
  if (!missing.length) { alert("Todos os itens de envio padrão já estão no checklist."); return; }
  if (!confirm(`Adicionar ${missing.length} item(ns) de envio ao checklist?`)) return;
  try {
    for (const [item, categoria, obs] of missing) {
      await postJson("/api/intelligence?type=evt_item_add", { evento_id: state.currentEventoId, valores: { item, categoria, status: "pendente", obs } });
    }
    openEvento(state.currentEventoId);
  } catch (e) { alert(`Falha: ${e.message}`); openEvento(state.currentEventoId); }
}

function eventoUniqueColKey(label, cols) {
  const base = String(label).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30) || "col";
  const keys = new Set((cols || []).map((c) => c.key));
  let key = base, i = 2;
  while (keys.has(key)) key = `${base}_${i++}`;
  return key;
}

async function eventoSaveCols(colunas) {
  try {
    const r = await postJson("/api/intelligence?type=evt_cols_save", { id: state.currentEventoId, colunas });
    if (!r?.ok) throw new Error(r?.error || "erro");
    openEvento(state.currentEventoId);
  } catch (e) { alert(`Falha: ${e.message}`); }
}

async function eventoAddColumn() {
  const d = state.eventoData; if (!d) return;
  const label = window.prompt("Nome da nova coluna:");
  if (!label || !label.trim()) return;
  const type = (window.prompt("Tipo (text, date, select, check, url, num):", "text") || "text").trim().toLowerCase();
  const col = { key: eventoUniqueColKey(label, d.colunas), label: label.trim(), type: EVT_TYPES.includes(type) ? type : "text" };
  if (col.type === "select") { const o = window.prompt("Opções separadas por vírgula:", "") || ""; col.options = o.split(",").map((s) => s.trim()).filter(Boolean); }
  await eventoSaveCols([...(d.colunas || []), col]);
}

async function eventoRenameColumn(key) {
  const d = state.eventoData; if (!d) return;
  const col = (d.colunas || []).find((c) => c.key === key); if (!col) return;
  const label = window.prompt("Novo nome da coluna:", col.label);
  if (!label || !label.trim()) return;
  await eventoSaveCols((d.colunas || []).map((c) => c.key === key ? { ...c, label: label.trim() } : c));
}

async function eventoDeleteColumn(key) {
  const d = state.eventoData; if (!d) return;
  if (!confirm("Remover esta coluna? Os valores dela ficam ocultos (não apagados).")) return;
  await eventoSaveCols((d.colunas || []).filter((c) => c.key !== key));
}

// F-EVT2: helpers de sub-entidade (programacao/painelista/patrocinador/convidado).
async function evtSubSave(kind, fields) {
  try {
    const r = await postJson("/api/intelligence?type=evt_sub_save", { kind, ...fields });
    if (!r?.ok) throw new Error(r?.error || "erro");
    openEvento(state.currentEventoId);
    return r.row;
  } catch (e) { alert(`Falha: ${e.message}`); return null; }
}
async function evtSubRemove(kind, id) {
  await postJson("/api/intelligence?type=evt_sub_remove", { kind, id }).catch(() => {});
  openEvento(state.currentEventoId);
}
// Edição inline: sincroniza o state local e persiste; reverte via refetch em falha.
async function evtSubField(kind, id, patch) {
  const it = (state.eventoData?.[EVT_LISTKEY[kind]] || []).find((x) => String(x.id) === String(id));
  if (it) Object.assign(it, patch);
  try {
    const r = await postJson("/api/intelligence?type=evt_sub_save", { kind, id, ...patch });
    if (!r?.ok) throw new Error(r?.error || "erro");
  } catch (e) { alert(`Falha ao salvar: ${e.message}`); openEvento(state.currentEventoId); }
}

// --- Programação ---
function renderEventoProgramacao(d) {
  const prog = (d.programacao || []).slice();
  const byPainel = new Map();
  for (const pl of d.painelistas || []) { const k = String(pl.painel || "").trim(); if (!byPainel.has(k)) byPainel.set(k, []); byPainel.get(k).push(pl); }
  const blocks = prog.map((b) => {
    const pains = (b.tipo === "painel" && b.painel_ref) ? (byPainel.get(String(b.painel_ref).trim()) || []) : [];
    const plist = pains.length ? `<div style="margin-left:14px;font-size:.85rem;opacity:.85">${pains.map((p) => `${escapeHtml(p.nome)}${p.papel === "moderador" ? " (mod.)" : ""}${p.empresa ? " — " + escapeHtml(p.empresa) : ""}`).join(" · ")}</div>` : "";
    return `<div class="director-row" style="align-items:flex-start">
      <div style="flex:1"><strong>${escapeHtml(b.horario || "")} ${escapeHtml(b.titulo)}</strong> <span class="entity-pill">${escapeHtml(b.tipo || "")}</span>${b.descricao ? `<div class="card-sub">${escapeHtml(b.descricao)}</div>` : ""}${plist}</div>
      <button type="button" class="entity-pill" data-prog-del="${escapeHtml(b.id)}">×</button>
    </div>`;
  }).join("");
  return `<article class="news-card">
    <span class="source-meta">Programação do dia</span>
    ${blocks || `<p>Sem blocos. Monte a linha do tempo abaixo.</p>`}
    <div class="entity-row" style="flex-wrap:wrap;gap:6px;margin-top:8px">
      <input id="prog-horario" class="dou-date" style="width:90px" placeholder="14h00">
      <input id="prog-titulo" class="dou-date" style="min-width:180px;flex:1" placeholder="Título do bloco">
      <select id="prog-tipo" class="dou-date">${["abertura", "painel", "coffee", "intervalo", "encerramento", "outro"].map((t) => `<option value="${t}">${t}</option>`).join("")}</select>
      <input id="prog-painelref" class="dou-date" style="width:120px" placeholder="Painel (ref)">
      <button type="button" class="entity-pill" id="prog-add">+ bloco</button>
    </div>
  </article>`;
}

// --- Painelistas ---
function renderEventoPainelistas(d) {
  const pl = d.painelistas || [];
  const groups = new Map();
  for (const p of pl) { const k = String(p.painel || "").trim() || "Sem painel"; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); }
  const body = groups.size ? [...groups.entries()].map(([painel, list]) => `<div style="margin-top:10px"><strong>${escapeHtml(painel)}</strong>${list.map((p) => `
    <div class="director-row" style="flex-wrap:wrap;gap:6px">
      <div style="flex:1;min-width:170px"><strong>${escapeHtml(p.nome)}</strong> <span class="card-sub">${escapeHtml(p.cargo || "")}${p.empresa ? " · " + escapeHtml(p.empresa) : ""}</span></div>
      ${esubCell("painelista", p.id, "papel", "select", p.papel, ["painelista", "moderador"])}
      ${esubCell("painelista", p.id, "status", "select", p.status, ["confirmado", "pendente", "recusado"])}
      ${p.person_id ? `<button type="button" class="entity-pill" data-pain-dossie="${escapeHtml(p.person_id)}">ver dossiê</button>` : `<button type="button" class="entity-pill" data-pain-link="${escapeHtml(p.id)}">vincular</button>`}
      <button type="button" class="entity-pill" data-pain-del="${escapeHtml(p.id)}">×</button>
    </div>`).join("")}</div>`).join("") : `<p>Nenhum painelista. Adicione abaixo.</p>`;
  return `<article class="news-card">
    <span class="source-meta">Painelistas & moderadores</span>
    ${body}
    <div id="pain-link-box"></div>
    <div class="entity-row" style="flex-wrap:wrap;gap:6px;margin-top:8px">
      <input id="pain-nome" class="dou-date" style="min-width:150px;flex:1" placeholder="Nome">
      <input id="pain-painel" class="dou-date" style="width:110px" placeholder="Painel">
      <input id="pain-cargo" class="dou-date" style="width:120px" placeholder="Cargo">
      <input id="pain-empresa" class="dou-date" style="width:120px" placeholder="Empresa">
      <select id="pain-papel-new" class="dou-date">${["painelista", "moderador"].map((o) => `<option value="${o}">${o}</option>`).join("")}</select>
      <button type="button" class="entity-pill" id="pain-add">+ painelista</button>
    </div>
  </article>`;
}
function evtPainLinkOpen(id) {
  state.painLinkId = id;
  const box = $("#pain-link-box");
  if (box) box.innerHTML = `<div class="entity-row" style="gap:6px;margin-top:6px"><input id="pain-link-q" class="dou-date" style="flex:1" placeholder="Buscar pessoa no LINCE (nome)"><button type="button" class="entity-pill" id="pain-link-search">Buscar</button></div><div id="pain-link-results"></div>`;
}
async function evtPainLinkSearch() {
  const q = ($("#pain-link-q")?.value || "").trim(); const box = $("#pain-link-results");
  if (!q || !box) return;
  box.innerHTML = `<p style="font-size:.8rem;opacity:.6">Buscando…</p>`;
  try {
    const r = await requestJson(`/api/dossier-person?q=${encodeURIComponent(q)}`);
    const people = r?.people || [];
    box.innerHTML = people.length ? people.map((p) => `<div class="director-row"><div style="flex:1"><strong>${escapeHtml(p.full_name)}</strong> <span class="card-sub">${escapeHtml(p.role || "")}${p.agency ? " · " + escapeHtml(p.agency) : ""}</span></div><button type="button" class="entity-pill" data-pain-pick="${escapeHtml(p.id)}">vincular</button></div>`).join("") : `<p style="font-size:.8rem;opacity:.6">Nada encontrado.</p>`;
  } catch (e) { box.innerHTML = `<p style="font-size:.8rem;opacity:.6">Falha: ${escapeHtml(e.message)}</p>`; }
}

// --- Patrocínio ---
// F-EVT7: disciplina do pipeline. EVT_ESTAGIOS idêntico ao backend (api/intelligence.js).
const EVT_ESTAGIOS = ["Alvo", "Contatado", "Reuniao", "Proposta", "Fechado", "Associado", "Perdido"];
const EVT_ESTAGIOS_ATIVOS = new Set(["Alvo", "Contatado", "Reuniao", "Proposta"]);
const EVT_ESTAGIO_COR = { Alvo: "#5C7089", Contatado: "#8DA0B8", Reuniao: "#e0a500", Proposta: "#E3C766" };
// status legado derivado do estágio (IDÊNTICO ao backend) — para o re-render local refletir as somas na hora.
const ESTAGIO_TO_STATUS = { Alvo: "prospect", Contatado: "negociacao", Reuniao: "negociacao", Proposta: "negociacao", Fechado: "fechado", Associado: "recusado", Perdido: "recusado" };
// Regra da linha morta: estágio ativo SEM próxima-ação+data = âmbar; data_acao vencida = vermelho.
function patrRowStyle(p) {
  const est = p.estagio || "Alvo";
  if (!EVT_ESTAGIOS_ATIVOS.has(est)) return "";
  if (p.data_acao) { const dt = new Date(String(p.data_acao).slice(0, 10) + "T12:00:00"); if (!Number.isNaN(dt.getTime()) && dt.getTime() < Date.now()) return "box-shadow:inset 3px 0 0 var(--red)"; }
  if (!p.proxima_acao || !p.data_acao) return "box-shadow:inset 3px 0 0 var(--amber,#e0a500)";
  return "";
}
function patrFunil(pt) {
  const c = {}; EVT_ESTAGIOS.forEach((e) => (c[e] = 0));
  pt.forEach((p) => { const e = p.estagio || "Alvo"; if (c[e] != null) c[e]++; });
  const ativos = ["Alvo", "Contatado", "Reuniao", "Proposta"];
  const totalA = ativos.reduce((a, e) => a + c[e], 0);
  const bar = totalA
    ? `<div style="display:flex;height:22px;border-radius:6px;overflow:hidden;border:1px solid var(--border)">${ativos.map((e) => c[e] ? `<div title="${e}" style="flex:${c[e]};min-width:22px;background:${EVT_ESTAGIO_COR[e]};display:flex;align-items:center;justify-content:center;font-size:11px;color:#0A1424">${c[e]}</div>` : "").join("")}</div>`
    : `<span class="card-sub">Pipeline sem estágios ativos.</span>`;
  return `<div style="margin:6px 0">${bar}<div class="card-sub" style="margin-top:4px">${ativos.map((e) => `${e} ${c[e]}`).join(" · ")} · Fechado ${c.Fechado} · Associado ${c.Associado} · Perdido ${c.Perdido}</div></div>`;
}
function renderEventoPatrocinadores(d) {
  const pt = d.patrocinadores || [];
  const cotas = (d.evento && d.evento.metadata && d.evento.metadata.cotas) || [];
  const cotaCell = (p) => `<input class="dou-date" list="evt-cota-list" data-esub-kind="patrocinador" data-esub-id="${escapeHtml(p.id)}" data-esub-field="cota" value="${escapeHtml(p.cota || "")}" style="width:100px">`;
  const rows = pt.map((p) => `<tr style="${patrRowStyle(p)}">
    <td>${esubCell("patrocinador", p.id, "nome", "text", p.nome)}</td>
    <td>${cotaCell(p)}</td>
    <td>${esubCell("patrocinador", p.id, "valor", "num", p.valor)}</td>
    <td>${esubCell("patrocinador", p.id, "estagio", "select", p.estagio || "Alvo", EVT_ESTAGIOS)}</td>
    <td>${esubCell("patrocinador", p.id, "porta", "text", p.porta)}</td>
    <td>${esubCell("patrocinador", p.id, "proxima_acao", "text", p.proxima_acao)}</td>
    <td>${esubCell("patrocinador", p.id, "data_acao", "date", p.data_acao)}</td>
    <td>${esubCell("patrocinador", p.id, "beneficios", "text", p.beneficios)}</td>
    <td style="white-space:nowrap">${(p.estagio === "Perdido" || p.estagio === "Associado") ? `<button type="button" class="entity-pill" data-patr-base="${escapeHtml(p.id)}" title="Levar para a Base (funil de associados)">→ Base</button> ` : ""}${p.sponsor_score_id ? `<button type="button" class="entity-pill" data-patr-outcome="${escapeHtml(p.id)}" title="registrar desfecho (loop de resultado + supressão)">⟳${p.respondeu ? "✓" : ""}</button> ` : ""}<button type="button" class="entity-pill" data-patr-del="${escapeHtml(p.id)}">×</button></td>
  </tr>`).join("");
  const fechado = pt.filter((x) => x.status === "fechado").reduce((s, x) => s + (Number(x.valor) || 0), 0);
  const pipeline = pt.reduce((s, x) => s + (Number(x.valor) || 0), 0);
  const cotasBlock = `<div style="margin-top:12px;border-top:1px solid var(--border);padding-top:8px">
    <strong style="display:block;margin-bottom:4px">Cotas do evento (catálogo)</strong>
    ${cotas.length ? cotas.map((c, i) => `<div class="entity-row" style="gap:6px;flex-wrap:wrap"><span class="entity-pill">${escapeHtml(c.nome)}${c.valor != null ? " · " + money(c.valor) : ""}</span>${c.beneficios ? `<span class="card-sub" style="flex:1">${escapeHtml(c.beneficios)}</span>` : ""}<button type="button" class="entity-pill" data-cota-del="${i}">×</button></div>`).join("") : `<span class="card-sub">Sem cotas cadastradas.</span>`}
    <div class="entity-row" style="flex-wrap:wrap;gap:6px;margin-top:6px"><input id="cota-nome" class="dou-date" style="width:130px" placeholder="Cota (Diamante)"><input id="cota-valor" type="number" class="dou-date" style="width:100px" placeholder="Valor"><input id="cota-benef" class="dou-date" style="min-width:150px;flex:1" placeholder="Benefícios"><button type="button" class="entity-pill" id="cota-add">+ cota</button></div>
  </div>`;
  setTimeout(ensureProspeccao, 0); // F-EVT4: carrega o bloco de Prospecção após montar
  return `<article class="news-card">
    <datalist id="evt-cota-list">${cotas.map((c) => `<option value="${escapeHtml(c.nome)}"></option>`).join("")}</datalist>
    <span class="source-meta">Patrocínio · pipeline</span>
    ${patrFunil(pt)}
    <div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Nome</th><th>Cota</th><th>Valor</th><th>Estágio</th><th>Porta</th><th>Próxima ação</th><th>Quando</th><th>Benefícios</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="9">Nenhum patrocinador.</td></tr>`}</tbody></table></div>
    <p class="card-sub" style="margin:4px 0 0">Linha ativa sem próxima-ação + data fica <span style="color:var(--amber,#e0a500)">âmbar</span>; ação vencida fica <span style="color:var(--red)">vermelha</span>.</p>
    <div class="entity-row" style="justify-content:space-between;flex-wrap:wrap;gap:6px;margin-top:6px">
      <div class="entity-row" style="gap:6px;flex-wrap:wrap"><input id="patr-nome" class="dou-date" style="min-width:140px" placeholder="Nome"><input id="patr-cota" class="dou-date" list="evt-cota-list" style="width:100px" placeholder="Cota"><input id="patr-valor" type="number" class="dou-date" style="width:100px" placeholder="Valor"><button type="button" class="entity-pill" id="patr-add">+ patrocinador</button></div>
      <strong>Fechado ${money(fechado)} · Pipeline ${money(pipeline)}</strong>
    </div>
    ${cotasBlock}
  </article>
  <article class="news-card" id="prosp-article"><div id="prosp-box"><span class="card-sub">Carregando prospecção…</span></div></article>`;
}

// ══════════════ F-EVT4: Prospecção (Score de Patrocinador) ══════════════════
// Ranqueia empresas por FIT (contrato-com-órgão-alvo=eixo, +sinal/porte +propensão)
// com EVIDÊNCIA sempre visível; relacionamento entra como PROMOÇÃO manual de tier
// (decisão humana, fora dos pontos). Ver docs/patrocinio-score.md.
async function ensureProspeccao() {
  const box = $("#prosp-box");
  if (!box) return;
  if (state.prosp && state.prosp.eventoId === state.currentEventoId && !state.prosp.loading) { box.innerHTML = renderProspBox(); return; }
  if (state.prosp && state.prosp.eventoId === state.currentEventoId && state.prosp.loading) return;
  await loadProspeccao();
}
async function loadProspeccao() {
  const eid = state.currentEventoId; // fixa o alvo: se o usuário trocar de evento durante o fetch, não rotula/renderiza dado do evento errado
  state.prosp = { eventoId: eid, loading: true, agencies: (state.prosp && state.prosp.agencies) || [] };
  try {
    const r = await requestJson(`/api/intelligence?type=evt_sponsor_list&evento_id=${encodeURIComponent(eid)}`);
    if (eid !== state.currentEventoId) return; // trocou de evento no meio do caminho — descarta
    state.prosp = { eventoId: eid, run: r.run || null, items: r.items || [], bloqueados: r.bloqueados || [], agencies: r.agencies || [], contatos: r.contatos || {} };
  } catch (e) {
    if (eid !== state.currentEventoId) return;
    state.prosp = { eventoId: eid, error: e.message, items: [], bloqueados: [], agencies: [] };
  }
  const box = $("#prosp-box");
  if (box && eid === state.currentEventoId) box.innerHTML = renderProspBox();
}
const PROSP_TIER_LABEL = { 1: "Tier 1", 2: "Tier 2", 3: "Tier 3" };
const PROSP_CAP_LABEL = { propensao: "sem sinal de propensão", fit_cnae: "CNAE não usada", total: "confiança limitada (1 dimensão)" };
// F-EVT6: taxonomia de segmento de convidado (IDÊNTICA ao backend EVT_SEGMENTOS). "Compradores"
// = quem fecha a cota (a densidade que importa pro patrocinador fornecedor).
const EVT_SEGMENTOS = ["Autoridade", "Operador publico", "Operador privado/Concessionaria", "Regulador/Governo", "Fornecedor", "Investidor/Financiador", "Consultoria/Juridico", "Associacao/Entidade", "Imprensa/Academia", "Outro"];
const EVT_SEG_COMPRADOR = new Set(["Autoridade", "Operador publico", "Operador privado/Concessionaria", "Regulador/Governo"]);
// Densidade de ICP: conta ORGANIZAÇÕES distintas (por empresa/instituição), só CONFIRMADOS.
function evtDensidade(convidados) {
  const conf = (convidados || []).filter((c) => c.status === "confirmado");
  const orgKey = (c) => String(c.empresa || c.instituicao || "").trim().toLowerCase();
  const segOrgs = new Map(), compradorOrgs = new Set(), allOrgs = new Set();
  let comSeg = 0;
  for (const c of conf) {
    const seg = c.segmento || "", org = orgKey(c);
    if (org) allOrgs.add(org);
    if (!seg) continue;
    comSeg++;
    if (!segOrgs.has(seg)) segOrgs.set(seg, new Set());
    segOrgs.get(seg).add(org || ("p:" + String(c.nome || "").toLowerCase()));
    if (EVT_SEG_COMPRADOR.has(seg) && org) compradorOrgs.add(org);
  }
  const perSeg = [...segOrgs.entries()].map(([seg, set]) => ({ seg, n: set.size })).sort((a, z) => z.n - a.n);
  return { compradores: compradorOrgs.size, perSeg, totalOrgs: allOrgs.size, totalPessoas: conf.length, comSeg };
}
function evtDensidadeLinha(convidados) {
  const d = evtDensidade(convidados);
  if (!d.comSeg) return `<span class="card-sub">Classifique os convidados por segmento p/ calcular a densidade de ICP (o argumento de venda).</span>`;
  const buyers = d.perSeg.filter((x) => EVT_SEG_COMPRADOR.has(x.seg)).map((x) => `${escapeHtml(x.seg)} ${x.n}`).join(" · ");
  return `<strong>Compradores confirmados: ${d.compradores} organizações</strong>${buyers ? ` <span class="card-sub">(${buyers})</span>` : ""} <span class="card-sub">· ${d.totalPessoas} confirmados no total</span>`;
}
function prospEvidenceHtml(s) {
  const e = s.evidence || {};
  const ct = (e.contratos || []).slice(0, 3).map((c) => `${money(c.value || 0)}${c.signed_at ? " · " + String(c.signed_at).slice(0, 10) : ""}`).join(" · ");
  const parts = [];
  parts.push(`<strong>Contratos c/ órgãos-alvo:</strong> ${e.n_contratos || 0} · Σ ${money(e.soma_contratos || 0)}${e.max_signed_at ? " · último " + String(e.max_signed_at).slice(0, 10) : ""}`);
  if (ct) parts.push(`<span class="card-sub">${escapeHtml(ct)}</span>`);
  if (e.n_doacoes) parts.push(`Doações PJ (TSE): ${e.n_doacoes} · Σ ${money(e.soma_doacoes || 0)}`);
  if (e.arestas) parts.push(`Vínculos no grafo: ${e.arestas}`);
  if (e.porte) parts.push(`Porte: ${escapeHtml(e.porte)}`);
  return parts.map((p) => `<div style="font-size:.78rem">${p}</div>`).join("");
}
function prospCard(s) {
  const t = s.timing || {};
  const janela = t.janela === "abrir" ? `<span class="entity-pill" style="background:var(--green-soft,#1c3)">abordar agora</span>` : t.janela === "esperar" ? `<span class="entity-pill">esperar (t-${t.semanas_para_evento ?? "?"}sem)</span>` : t.janela === "passou" ? `<span class="entity-pill" style="opacity:.6">evento passou</span>` : "";
  const ciclo = t.ciclo_orcamentario ? `<span class="entity-pill" title="Ciclo orçamentário BR (out–dez): verba do ano seguinte">janela orçamentária</span>` : "";
  const capped = (s.capped || []).map((c) => `<span class="entity-pill" style="opacity:.6" title="confiança">${escapeHtml(PROSP_CAP_LABEL[c] || c)}</span>`).join("");
  const tierShown = s.promovido ? `${PROSP_TIER_LABEL[s.promovido_tier] || "T?"} <span class="card-sub">(promovido de ${PROSP_TIER_LABEL[s.tier] || "—"})</span>` : (PROSP_TIER_LABEL[s.tier] || "—");
  const st = s.status;
  const acted = st === "aprovado" ? `<span class="entity-pill" style="background:var(--green-soft,#1c3)">aprovado</span>` : st === "descartado" ? `<span class="entity-pill" style="opacity:.5">descartado</span>` : "";
  const actions = (st === "sugerido") ? `<div class="entity-row" style="gap:6px;flex-wrap:wrap;margin-top:6px">
      <button type="button" class="entity-pill" data-prosp-promote="${escapeHtml(s.id)}">Promover tier</button>
      <button type="button" class="entity-pill" data-prosp-angle="${escapeHtml(s.id)}">Gerar ângulo</button>
      <button type="button" class="entity-pill" data-prosp-approve="${escapeHtml(s.id)}">Aprovar → patrocinador</button>
      <button type="button" class="entity-pill" data-prosp-discard="${escapeHtml(s.id)}">Descartar</button>
    </div>` : "";
  const angulo = s.angulo ? `<div style="margin-top:6px;border-left:2px solid var(--blue);padding-left:8px;font-size:.82rem">${escapeHtml(s.angulo)}</div>` : "";
  // F-EVT6: densidade de COMPRADORES na sala (argumento de venda, igual p/ todo prospect fornecedor).
  const dens = evtDensidade(state.eventoData?.convidados);
  const densPill = dens.comSeg ? `<span class="entity-pill" title="organizações compradoras confirmadas na sala (o que fecha a cota)">${dens.compradores} compradores na sala</span>` : "";
  // F-EVT6: contato(s) do decisor conhecidos DA EMPRESA (reutilizável entre eventos). Só profissional.
  const cts = (state.prosp?.contatos || {})[s.company_id] || [];
  const ctList = cts.map((c) => `<div class="entity-row" style="gap:4px;font-size:.78rem"><span>👤 ${escapeHtml(c.nome)}${c.cargo ? " — " + escapeHtml(c.cargo) : ""}${safeUrl(c.link) ? ` <a href="${escapeHtml(safeUrl(c.link))}" target="_blank" rel="noopener">↗</a>` : ""}</span><button type="button" class="entity-pill" data-prosp-ct-del="${escapeHtml(c.id)}" style="font-size:.7rem">×</button></div>`).join("");
  const contatoBloco = s.company_id ? `<div style="margin-top:4px">${ctList || `<span class="card-sub" style="font-size:.75rem">Sem contato do decisor.</span>`} <button type="button" class="entity-pill" data-prosp-ct-add="${escapeHtml(s.id)}" style="font-size:.7rem">+ contato</button></div>` : "";
  return `<div class="entity-row" style="flex-direction:column;align-items:stretch;gap:2px;border:1px solid var(--border);border-radius:6px;padding:8px;margin-bottom:6px">
    <div class="entity-row" style="justify-content:space-between;flex-wrap:wrap;gap:6px">
      <strong>${escapeHtml(s.nome)}</strong>
      <span><strong>${Number(s.total).toFixed(0)}</strong> · ${tierShown} ${acted}</span>
    </div>
    <div class="entity-row" style="gap:6px;flex-wrap:wrap">${s.cota_sugerida ? `<span class="entity-pill" title="cota sugerida (determinística)">${escapeHtml(s.cota_sugerida)}</span>` : ""}${janela}${ciclo}${densPill}${capped}</div>
    ${prospEvidenceHtml(s)}
    ${contatoBloco}
    ${angulo}
    ${actions}
  </div>`;
}
function renderProspBox() {
  const p = state.prosp || {};
  const ags = p.agencies || [];
  const run = p.run;
  const selected = new Set((run && run.orgaos) || []);
  const orgaosSel = ags.length
    ? `<div style="max-height:120px;overflow:auto;border:1px solid var(--border);border-radius:6px;padding:6px">${ags.map((a) => `<label style="display:inline-flex;align-items:center;gap:4px;margin:2px 8px 2px 0;font-size:.8rem"><input type="checkbox" name="prosp-orgao" value="${escapeHtml(a.id)}" ${selected.has(a.id) ? "checked" : ""}>${escapeHtml(a.acronym || a.name || "?")}</label>`).join("")}</div>`
    : `<span class="card-sub">Sem órgãos cadastrados.</span>`;
  const controls = `<div class="entity-row" style="flex-direction:column;align-items:stretch;gap:6px">
      <span class="source-meta">Prospecção — Score de Patrocinador</span>
      <label style="font-size:.78rem;opacity:.7">Órgãos-alvo (contratam no tema do evento):</label>
      ${orgaosSel}
      <div class="entity-row" style="gap:6px;flex-wrap:wrap"><input id="prosp-setor" class="dou-date" style="min-width:160px" placeholder="Setor (opcional, ex.: metroferroviário)" value="${escapeHtml((run && run.setor) || "")}"><button type="button" class="entity-pill" id="prosp-run">${run ? "Re-pontuar" : "Pontuar patrocinadores"}</button><button type="button" class="entity-pill" id="prosp-validate">Validação</button><button type="button" class="entity-pill" id="prosp-insumos-toggle">Insumos (entrevista)</button></div>
    </div>`;
  // F-EVT6: painel de SEQUÊNCIA (data → convidados → densidade → cotas → pontuar) + densidade de ICP.
  const ev = state.eventoData?.evento || {};
  const conv = state.eventoData?.convidados || [];
  const confirmados = conv.filter((c) => c.status === "confirmado").length;
  const cotas = (ev.metadata && ev.metadata.cotas) || [];
  const chk = (ok) => ok ? `<span style="color:var(--green-bright,#3c3)">✓</span>` : `<span style="color:var(--amber,#e0a500)">✗</span>`;
  const sequencia = `<div style="border:1px solid var(--border);border-radius:6px;padding:8px;margin:6px 0;font-size:.8rem">
      <strong style="font-size:.82rem">Sequência do evento</strong>
      <div>${chk(!!ev.data_evento)} Data definida${ev.data_evento ? " (" + escapeHtml(String(ev.data_evento).slice(0, 10)) + ")" : ""}</div>
      <div>${chk(confirmados > 0)} Convidados confirmados: ${confirmados}</div>
      <div>${chk(cotas.length > 0)} Cotas cadastradas: ${cotas.length}</div>
      <div style="margin-top:4px">${evtDensidadeLinha(conv)}</div>
    </div>`;
  if (p.error) return controls + sequencia + `<div class="card-sub" style="color:var(--red)">Falha: ${escapeHtml(p.error)}</div>`;
  let body = "";
  if (run && run.status === "running") body = `<div class="card-sub">Pontuando… <button type="button" class="entity-pill" id="prosp-refresh">atualizar</button></div>`;
  else if (run && run.status === "failed") body = `<div class="card-sub" style="color:var(--red);margin-top:8px">Falha na última pontuação${run.note ? ": " + escapeHtml(run.note) : ""}. Ajuste os órgãos e clique em Re-pontuar.</div>`;
  else if (!run) body = `<div class="card-sub" style="margin-top:8px">Nenhuma pontuação ainda. Selecione os órgãos-alvo e clique em <strong>Pontuar</strong>.</div>`;
  else {
    const items = p.items || [];
    const byTier = {};
    for (const s of items) { const t = (s.promovido && s.promovido_tier) ? s.promovido_tier : s.tier; (byTier[t] = byTier[t] || []).push(s); }
    const groups = [1, 2, 3].map((t) => (byTier[t] && byTier[t].length) ? `<div style="margin-top:8px"><strong style="font-size:.85rem">${PROSP_TIER_LABEL[t]} (${byTier[t].length})</strong>${byTier[t].map(prospCard).join("")}</div>` : "").join("");
    const meta = `<div class="card-sub" style="margin-top:6px">${items.length} no shortlist${run.n_candidates ? " · " + run.n_candidates + " candidatas" : ""}${p.bloqueados && p.bloqueados.length ? " · " + p.bloqueados.length + " bloqueada(s) por screening" : ""}${run.truncado ? " · ⚠ scan truncado" : ""}${run.note ? " · " + escapeHtml(run.note) : ""}</div>`;
    const bloq = (p.bloqueados && p.bloqueados.length) ? `<details style="margin-top:8px"><summary style="cursor:pointer;font-size:.8rem;opacity:.7">Bloqueadas por screening (${p.bloqueados.length})</summary>${p.bloqueados.map((s) => `<div style="font-size:.78rem;opacity:.7;padding:2px 0">${escapeHtml(s.nome)} — ${escapeHtml((s.screening && s.screening.reason) || "sanção/inaptidão")}</div>`).join("")}</details>` : "";
    body = meta + (groups || `<div class="card-sub">Nenhuma empresa atingiu o corte mínimo de tier.</div>`) + bloq;
  }
  return controls + sequencia + `<div id="prosp-validate-box"></div>` + `<div id="prosp-insumos-box" hidden></div>` + body;
}
async function prospRun() {
  const orgaos = [...document.querySelectorAll("input[name='prosp-orgao']:checked")].map((el) => el.value);
  if (!orgaos.length) { alert("Selecione ao menos um órgão-alvo."); return; }
  // F-EVT6: soft-gate — a ordem é data → convidados confirmados → densidade → pontuar.
  const ev = state.eventoData?.evento || {};
  const conv = state.eventoData?.convidados || [];
  const confirmados = conv.filter((c) => c.status === "confirmado").length;
  const cotas = (ev.metadata && ev.metadata.cotas) || [];
  const faltas = [];
  if (!ev.data_evento) faltas.push("data do evento");
  if (!confirmados) faltas.push("convidados confirmados");
  if (!cotas.length) faltas.push("cotas cadastradas");
  if (faltas.length && !confirm(`Falta: ${faltas.join(", ")}.\n\nConfirme os convidados e cadastre as cotas primeiro — a densidade de ICP é o que fecha a cota (sem cota cadastrada não há teto de shortlist nem faixa sugerida). Ou pontue agora se estiver calibrando contra um evento passado.\n\nPontuar mesmo assim?`)) return;
  const setor = $("#prosp-setor")?.value || "";
  const btn = $("#prosp-run");
  if (btn) { btn.disabled = true; btn.textContent = "Pontuando…"; }
  try {
    const r = await postJson("/api/intelligence?type=evt_sponsor_run", { evento_id: state.currentEventoId, orgaos, setor });
    if (!r?.ok) throw new Error(r?.error || "erro");
    await loadProspeccao();
  } catch (e) { alert(`Falha ao pontuar: ${e.message}`); if (btn) { btn.disabled = false; btn.textContent = "Pontuar patrocinadores"; } }
}
async function prospPromote(id) {
  const tier = prompt("Promover para qual tier? (1, 2 ou 3)");
  if (!tier || !["1", "2", "3"].includes(String(tier).trim())) return;
  const justificativa = prompt("Justificativa (relacionamento/decisão humana):") || "";
  const promovido_por = _userEmail || "";
  try {
    const r = await postJson("/api/intelligence?type=evt_sponsor_promote", { id, tier: Number(tier), justificativa, promovido_por });
    if (!r?.ok) throw new Error(r?.error || "erro");
    await loadProspeccao();
  } catch (e) { alert(`Falha: ${e.message}`); }
}
async function prospAngle(id) {
  const btn = document.querySelector(`[data-prosp-angle="${id}"]`);
  if (btn) { btn.disabled = true; btn.textContent = "Gerando…"; }
  try {
    const r = await postJson("/api/intelligence?type=evt_sponsor_angle", { id });
    if (r?.skipped === "no_api_key") alert("Ângulo indisponível: falta ANTHROPIC_API_KEY.");
    else if (!r?.ok) throw new Error(r?.error || "erro");
    else if (r.error) alert(`Ângulo falhou: ${r.error}`);
    await loadProspeccao();
  } catch (e) { alert(`Falha: ${e.message}`); if (btn) { btn.disabled = false; btn.textContent = "Gerar ângulo"; } }
}
async function prospApprove(id) {
  if (!confirm("Aprovar esta empresa como patrocinador (reverifica screening agora)?")) return;
  try {
    const r = await postJson("/api/intelligence?type=evt_sponsor_decide", { id, decisao: "aprovar" });
    if (r?.blocked) { alert(`Bloqueada: ${r.error}`); await loadProspeccao(); return; }
    if (!r?.ok) throw new Error(r?.error || "erro");
    if (r.warn) alert(r.warn);
    await loadProspeccao();
    openEvento(state.currentEventoId); // atualiza a tabela de patrocinadores
  } catch (e) { alert(`Falha: ${e.message}`); }
}
async function prospDiscard(id) {
  try {
    const r = await postJson("/api/intelligence?type=evt_sponsor_decide", { id, decisao: "descartar" });
    if (!r?.ok) throw new Error(r?.error || "erro");
    await loadProspeccao();
  } catch (e) { alert(`Falha: ${e.message}`); }
}
async function prospValidate() {
  const box = $("#prosp-validate-box");
  if (!box) return;
  if (box.dataset.open === "1") { box.dataset.open = "0"; box.innerHTML = ""; return; }
  box.dataset.open = "1";
  box.innerHTML = `<span class="card-sub">Carregando validação…</span>`;
  try {
    const r = await requestJson(`/api/intelligence?type=evt_sponsor_validate&evento_id=${encodeURIComponent(state.currentEventoId)}`);
    const tiers = r.tiers || [];
    const rows = tiers.map((t) => `<tr><td>${PROSP_TIER_LABEL[t.tier] || t.tier}</td><td>${t.abordados}</td><td>${t.abordados >= 5 ? Math.round((t.taxa_resposta || 0) * 100) + "%" : `<span class="card-sub" title="n<5: amostra pequena">${t.respondeu}/${t.abordados}</span>`}</td><td>${t.fechados}</td><td>${money(t.valor_fechado || 0)}</td></tr>`).join("");
    const chart = buildMiniChart(tiers.map((t) => ({ total: t.valor_fechado || 0 })), 0);
    const g = r.golden || {};
    const topLine = (g.top_hits != null)
      ? `<strong>Golden no top-${g.top_n || 20}:</strong> ${g.top_hits} de ${g.golden_total || 0} — rode contra um evento passado e veja se as empresas esperadas sobem ao topo (o teste real da rubrica).`
      : `Golden no top-N: rode a pontuação deste evento e cadastre o golden set (aba Insumos) p/ calibrar.`;
    const hist = (r.historico || []).map((h) => `<tr><td>v${h.rubric_version ?? "?"}</td><td>${h.top_hits != null ? `${h.top_hits}/${h.golden_n ?? "?"}` : "—"}</td><td>${h.concordancia != null ? Math.round(h.concordancia * 100) + "%" : "—"}</td><td>${escapeHtml(String(h.created_at || "").slice(0, 10))}</td></tr>`).join("");
    box.innerHTML = `<div style="border-top:1px solid var(--border);margin-top:8px;padding-top:8px">
      <strong style="font-size:.85rem">Validação (indicador antecedente)</strong>
      <div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Tier</th><th>Abordados</th><th>Taxa resposta</th><th>Fechados</th><th>Valor fechado</th></tr></thead><tbody>${rows || `<tr><td colspan="5">Sem histórico ainda.</td></tr>`}</tbody></table></div>
      ${chart ? `<div class="card-sub">Valor fechado por tier</div>${chart}` : ""}
      <div class="card-sub" style="margin-top:6px">Concordância determinística vs golden: ${g.n ? `${Math.round((g.concordancia || 0) * 100)}% em ${g.n} empresas` : "sem empresas comparáveis ainda"}</div>
      <div class="card-sub" style="margin-top:4px">${topLine}</div>
      <div class="entity-row" style="gap:6px;margin-top:6px"><button type="button" class="entity-pill" id="prosp-calib-save">Salvar calibração</button><span id="prosp-calib-status" class="card-sub"></span></div>
      ${hist ? `<details style="margin-top:6px"><summary style="cursor:pointer;font-size:.8rem;opacity:.7">Histórico de calibração</summary><div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Rubrica</th><th>Golden top-N</th><th>Concord.</th><th>Data</th></tr></thead><tbody>${hist}</tbody></table></div></details>` : ""}
    </div>`;
  } catch (e) { box.innerHTML = `<span class="card-sub" style="color:var(--red)">Falha: ${escapeHtml(e.message)}</span>`; }
}
async function prospCalibSave() {
  const st = $("#prosp-calib-status");
  if (st) st.textContent = "Salvando…";
  try {
    const r = await postJson("/api/intelligence?type=evt_sponsor_validate", { evento_id: state.currentEventoId, save: true });
    if (!r?.ok) throw new Error(r?.error || "erro");
    if (st) st.textContent = "Calibração salva.";
    const box = $("#prosp-validate-box"); if (box) box.dataset.open = "0"; // força reabrir com histórico atualizado
    prospValidate();
  } catch (e) { if (st) st.textContent = `Falha: ${e.message}`; }
}
// F-EVT6: contato do decisor (por empresa). LGPD: só nome/cargo/link profissional — sem e-mail/telefone.
async function prospContatoAdd(scoreId) {
  const s = (state.prosp?.items || []).find((x) => x.id === scoreId);
  if (!s || !s.company_id) { alert("Empresa sem vínculo no grafo — o contato não pode ser guardado por empresa."); return; }
  const nome = prompt("Nome do contato (decisor). LGPD: não inclua e-mail/telefone.");
  if (!nome || !nome.trim()) return;
  const cargo = prompt("Cargo (opcional):") || "";
  const link = prompt("LinkedIn/perfil público (opcional):") || "";
  try {
    const r = await postJson("/api/intelligence?type=evt_sponsor_contato_save", { company_id: s.company_id, cnpj: s.cnpj, nome: nome.trim(), cargo, link });
    if (!r?.ok) throw new Error(r?.error || "erro");
    await loadProspeccao();
  } catch (e) { alert(`Falha: ${e.message}`); }
}
async function prospInsumosToggle() {
  const box = $("#prosp-insumos-box");
  if (!box) return;
  if (!box.hidden) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<span class="card-sub">Carregando insumos…</span>`;
  try {
    const [nn, gg] = await Promise.all([
      requestJson("/api/intelligence?type=evt_ref_note_list").catch(() => ({ items: [] })),
      requestJson("/api/intelligence?type=evt_golden_list").catch(() => ({ items: [] }))
    ]);
    box.innerHTML = renderProspInsumos(nn.items || [], gg.items || []);
  } catch (e) { box.innerHTML = `<span class="card-sub" style="color:var(--red)">Falha: ${escapeHtml(e.message)}</span>`; }
}
const REFNOTE_KINDS = [["won_language", "linguagem que fechou"], ["loss_reason", "motivo de perda"], ["objecao", "objeção"], ["banido", "banido/opt-out"]];
function renderProspInsumos(notes, golden) {
  const nrows = notes.map((n) => `<div class="entity-row" style="gap:6px;flex-wrap:wrap;font-size:.78rem"><span class="entity-pill">${escapeHtml((REFNOTE_KINDS.find((k) => k[0] === n.kind) || [null, n.kind])[1])}</span><span style="flex:1">${escapeHtml(n.content)}${n.segment ? " · " + escapeHtml(n.segment) : ""}</span><button type="button" class="entity-pill" data-refnote-del="${escapeHtml(n.id)}">×</button></div>`).join("");
  const grows = golden.map((g) => `<div class="entity-row" style="gap:6px;flex-wrap:wrap;font-size:.78rem"><span class="entity-pill">T${g.tier_humano}</span><span style="flex:1">${escapeHtml(g.nome)}${g.cnpj ? " · " + escapeHtml(formatCnpj(g.cnpj)) : ""}</span><button type="button" class="entity-pill" data-golden-del="${escapeHtml(g.id)}">×</button></div>`).join("");
  return `<div style="border-top:1px solid var(--border);margin-top:8px;padding-top:8px">
    <strong style="font-size:.85rem">Arquivos de referência (da entrevista com os diretores)</strong>
    <div class="card-sub">Alimentam o ângulo (won-language/objeção) e a calibração (golden). Não pontuam automaticamente.</div>
    <div style="margin-top:6px">${nrows || `<span class="card-sub">Sem notas.</span>`}</div>
    <div class="entity-row" style="gap:6px;flex-wrap:wrap;margin-top:6px"><select id="refnote-kind" class="dou-date">${REFNOTE_KINDS.map((k) => `<option value="${k[0]}">${k[1]}</option>`).join("")}</select><input id="refnote-content" class="dou-date" style="min-width:180px;flex:1" placeholder="Conteúdo"><input id="refnote-segment" class="dou-date" style="width:120px" placeholder="Segmento (opc.)"><button type="button" class="entity-pill" id="refnote-add">+ nota</button></div>
    <div style="margin-top:10px"><strong style="font-size:.85rem">Golden set (tier que os diretores dariam)</strong></div>
    <div style="margin-top:6px">${grows || `<span class="card-sub">Sem empresas.</span>`}</div>
    <div class="entity-row" style="gap:6px;flex-wrap:wrap;margin-top:6px"><input id="golden-nome" class="dou-date" style="min-width:150px;flex:1" placeholder="Empresa"><input id="golden-cnpj" class="dou-date" style="width:150px" placeholder="CNPJ (opc.)"><select id="golden-tier" class="dou-date"><option value="1">Tier 1</option><option value="2">Tier 2</option><option value="3">Tier 3</option></select><button type="button" class="entity-pill" id="golden-add">+ golden</button></div>
  </div>`;
}
async function prospRefNoteAdd() {
  const kind = $("#refnote-kind")?.value, content = ($("#refnote-content")?.value || "").trim();
  if (!content) return;
  try { const r = await postJson("/api/intelligence?type=evt_ref_note_save", { kind, content, segment: $("#refnote-segment")?.value || "" }); if (!r?.ok) throw new Error(r?.error || "erro"); prospInsumosReload(); }
  catch (e) { alert(`Falha: ${e.message}`); }
}
async function prospGoldenAdd() {
  const nome = ($("#golden-nome")?.value || "").trim();
  if (!nome) return;
  try { const r = await postJson("/api/intelligence?type=evt_golden_save", { nome, cnpj: $("#golden-cnpj")?.value || "", tier_humano: Number($("#golden-tier")?.value || 2) }); if (!r?.ok) throw new Error(r?.error || "erro"); prospInsumosReload(); }
  catch (e) { alert(`Falha: ${e.message}`); }
}
async function prospInsumosReload() {
  const box = $("#prosp-insumos-box");
  if (!box) return;
  const [nn, gg] = await Promise.all([
    requestJson("/api/intelligence?type=evt_ref_note_list").catch(() => ({ items: [] })),
    requestJson("/api/intelligence?type=evt_golden_list").catch(() => ({ items: [] }))
  ]);
  box.innerHTML = renderProspInsumos(nn.items || [], gg.items || []);
}
// Loop de resultado: registra desfecho de um patrocinador ligado a um score
// (seta respondeu + move status + atualiza a supressão entre eventos).
async function prospOutcome(patrId) {
  const desfecho = (prompt("Desfecho? respondeu / fechou / recusou / optout") || "").trim();
  if (!["respondeu", "fechou", "recusou", "optout"].includes(desfecho)) return;
  const body = { patrocinador_id: patrId, desfecho, respondeu: true };
  if (desfecho === "fechou") { const v = prompt("Valor fechado (R$):"); if (v != null && v !== "") body.valor = Number(v) || 0; }
  if (desfecho === "recusou" || desfecho === "optout") body.motivo = prompt("Motivo:") || "";
  try {
    const r = await postJson("/api/intelligence?type=evt_outcome_save", body);
    if (!r?.ok) throw new Error(r?.error || "erro");
    openEvento(state.currentEventoId);
  } catch (e) { alert(`Falha: ${e.message}`); }
}

// --- Convidados / RSVP ---
function renderEventoConvidados(d) {
  const cv = d.convidados || [];
  const byS = { confirmado: 0, pendente: 0, recusado: 0 };
  for (const c of cv) if (byS[c.status] != null) byS[c.status]++;
  const rows = cv.map((c) => `<tr>
    <td>${esubCell("convidado", c.id, "nome", "text", c.nome)}</td>
    <td>${esubCell("convidado", c.id, "empresa", "text", c.empresa)}</td>
    <td>${esubCell("convidado", c.id, "instituicao", "text", c.instituicao)}</td>
    <td>${esubCell("convidado", c.id, "segmento", "select", c.segmento, ["", ...EVT_SEGMENTOS])}</td>
    <td>${esubCell("convidado", c.id, "status", "select", c.status, ["confirmado", "pendente", "recusado"])}</td>
    <td><button type="button" class="entity-pill" data-conv-del="${escapeHtml(c.id)}">×</button></td>
  </tr>`).join("");
  return `<article class="news-card">
    <div class="entity-row" style="justify-content:space-between;flex-wrap:wrap;gap:6px">
      <span class="source-meta">Convidados / RSVP</span>
      <span style="font-size:.85rem">${cv.length} · ✅ ${byS.confirmado} · ⏱ ${byS.pendente} · ✖ ${byS.recusado}</span>
    </div>
    <div style="margin:6px 0;font-size:.82rem">${evtDensidadeLinha(cv)}</div>
    <div class="entity-row" style="flex-wrap:wrap;gap:6px;margin:6px 0">
      <input id="conv-nome" class="dou-date" style="min-width:150px;flex:1" placeholder="Nome"><input id="conv-empresa" class="dou-date" style="width:140px" placeholder="Empresa"><button type="button" class="entity-pill" id="conv-add">+ convidado</button>
      <button type="button" class="entity-pill" id="conv-import-btn">Importar lista</button>
    </div>
    <div id="conv-import-box" hidden style="margin:6px 0"><textarea id="conv-import-text" class="dou-date" style="width:100%;min-height:80px" placeholder="Cole a lista (uma linha por convidado): Nome – Empresa ✅"></textarea><div class="entity-row" style="gap:6px"><button type="button" class="entity-pill" id="conv-import-do">Importar</button><span id="conv-import-status" style="font-size:.75rem;opacity:.6"></span></div></div>
    <div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Nome</th><th>Empresa</th><th>Instituição</th><th>Segmento</th><th>Status</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="6">Nenhum convidado.</td></tr>`}</tbody></table></div>
  </article>`;
}
async function evtConvidadoImport() {
  const texto = $("#conv-import-text")?.value || "";
  const status = $("#conv-import-status");
  if (!texto.trim()) return;
  if (status) status.textContent = "Importando…";
  try {
    const r = await postJson("/api/intelligence?type=evt_convidado_import", { evento_id: state.currentEventoId, texto });
    if (!r?.ok) throw new Error(r?.error || "erro");
    if (status) status.textContent = `${r.inserted} adicionado(s), ${r.pulados} pulado(s).`;
    openEvento(state.currentEventoId);
  } catch (e) { if (status) status.textContent = `Falha: ${e.message}`; }
}

// F-EVT3: exporta o evento como Markdown (one-pager/programação) p/ o Claude Design.
function exportEventoMd() {
  const d = state.eventoData;
  if (!d) return;
  const ev = d.evento || {}, m = d.metricas || {};
  const cell = (s) => String(s == null ? "" : s).replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
  const d10 = (s) => String(s || "").slice(0, 10);
  const L = [];
  L.push(`# ${ev.nome || "Evento"}`);
  L.push("");
  L.push(`_${[d10(ev.data_evento) || "sem data", ev.horario, ev.local, ev.status].filter(Boolean).join(" · ")}_`);
  if (ev.descricao) { L.push(""); L.push(cell(ev.descricao)); }
  if ((ev.objetivos || []).length) { L.push(""); L.push("## Objetivos"); L.push(""); for (const o of ev.objetivos) L.push(`- ${cell(o)}`); }

  const prog = d.programacao || [], byPainel = new Map();
  for (const pl of d.painelistas || []) { const k = String(pl.painel || "").trim(); if (!byPainel.has(k)) byPainel.set(k, []); byPainel.get(k).push(pl); }
  if (prog.length) {
    L.push(""); L.push("## Programação"); L.push(""); L.push("| Horário | Bloco | Tipo | Painelistas |"); L.push("| --- | --- | --- | --- |");
    for (const b of prog) {
      const pains = (b.tipo === "painel" && b.painel_ref) ? (byPainel.get(String(b.painel_ref).trim()) || []) : [];
      L.push(`| ${cell(b.horario)} | ${cell(b.titulo)} | ${cell(b.tipo)} | ${cell(pains.map((p) => p.nome + (p.papel === "moderador" ? " (mod.)" : "")).join(", "))} |`);
    }
  }

  if ((d.painelistas || []).length) {
    L.push(""); L.push("## Painelistas & moderadores");
    const g = new Map(); for (const p of d.painelistas) { const k = String(p.painel || "").trim() || "Sem painel"; if (!g.has(k)) g.set(k, []); g.get(k).push(p); }
    for (const [painel, list] of g) { L.push(""); L.push(`### ${cell(painel)}`); for (const p of list) L.push(`- **${cell(p.nome)}**${p.cargo ? " — " + cell(p.cargo) : ""}${p.empresa ? " (" + cell(p.empresa) + ")" : ""} — ${cell(p.status)}`); }
  }

  const pt = d.patrocinadores || [], cotas = (ev.metadata && ev.metadata.cotas) || [];
  if (pt.length || cotas.length) {
    L.push(""); L.push("## Patrocínio");
    if (cotas.length) { L.push(""); L.push("**Cotas:** " + cotas.map((c) => `${cell(c.nome)}${c.valor != null ? " (" + money(c.valor) + ")" : ""}`).join(" · ")); }
    if (pt.length) {
      L.push(""); L.push("| Patrocinador | Cota | Valor | Status |"); L.push("| --- | --- | --- | --- |");
      for (const p of pt) L.push(`| ${cell(p.nome)} | ${cell(p.cota)} | ${p.valor != null ? money(p.valor) : "—"} | ${cell(p.status)} |`);
      const fechado = pt.filter((x) => x.status === "fechado").reduce((s, x) => s + (Number(x.valor) || 0), 0);
      const pipeline = pt.reduce((s, x) => s + (Number(x.valor) || 0), 0);
      L.push(""); L.push(`_Fechado: ${money(fechado)} · Pipeline: ${money(pipeline)}_`);
    }
  }

  const cv = d.convidados || [];
  if (cv.length) {
    const conf = cv.filter((c) => c.status === "confirmado").length;
    L.push(""); L.push(`## Convidados (${conf} confirmados de ${cv.length})`); L.push("");
    for (const c of cv) L.push(`- ${cell(c.nome)}${c.empresa ? " — " + cell(c.empresa) : ""}${c.status !== "confirmado" ? " [" + cell(c.status) + "]" : ""}`);
  }

  L.push(""); L.push("---");
  L.push(`_Checklist ${m.checklist?.pct || 0}% · ${m.painelistas?.confirmados || 0}/${m.painelistas?.total || 0} painelistas confirmados · ${m.convidados?.confirmados || 0} convidados confirmados · patrocínio fechado ${money(m.patrocinio?.fechado_rs || 0)}. Conteúdo gerado pela LINCE para arte no Claude Design._`);

  const slug = String(ev.nome || "evento").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "evento";
  downloadText(`${slug}.md`, L.join("\n"));
}

// F-EVT3: cotas-catálogo (em evento.metadata.cotas).
function eventoCotas() { return (state.eventoData?.evento?.metadata?.cotas) || []; }
async function eventoCotasSave(cotas) {
  try {
    const r = await postJson("/api/intelligence?type=evt_cotas_save", { id: state.currentEventoId, cotas });
    if (!r?.ok) throw new Error(r?.error || "erro");
    if (state.eventoData?.evento) state.eventoData.evento.metadata = { ...(state.eventoData.evento.metadata || {}), cotas: r.cotas };
    renderEventoDetail(state.eventoData);
  } catch (e) { alert(`Falha: ${e.message}`); }
}

function wireEvento() {
  if (eventoWired) return; eventoWired = true;
  const view = $("#view-evento");
  if (!view) return;
  $("#evento-create")?.addEventListener("click", eventoCreate);
  view.addEventListener("click", async (e) => {
    // F-EVT7: toggle Eventos ↔ Base + ações da Base
    const evv = e.target.closest("[data-eventos-view]");
    if (evv) { state.eventosView = evv.dataset.eventosView; loadEventos(); return; }
    if (e.target.closest("#base-add")) { baseAdd(); return; }
    if (e.target.closest("#base-import-btn")) { const bx = $("#base-import-box"); if (bx) bx.hidden = !bx.hidden; return; }
    if (e.target.closest("#base-import-do")) { baseImportDo(); return; }
    if (e.target.closest("#base-from-conv")) { baseFromConvidados(); return; }
    const bcPipe = e.target.closest("[data-bc-pipe]"); if (bcPipe) { baseToPipeline(bcPipe.dataset.bcPipe); return; }
    const bcDel = e.target.closest("[data-bc-del]"); if (bcDel) { if (confirm("Remover contato da Base?")) postJson("/api/intelligence?type=evt_contato_remove", { id: bcDel.dataset.bcDel }).then(loadBase).catch(() => {}); return; }
    const del = e.target.closest("[data-evento-del]");
    if (del) { e.stopPropagation(); if (confirm("Excluir este evento e todo o checklist?")) { await postJson("/api/intelligence?type=evt_delete", { id: del.dataset.eventoDel }).catch(() => {}); loadEventos(); } return; }
    const open = e.target.closest("[data-open-evento]");
    if (open) { openEvento(open.dataset.openEvento); return; }
    if (e.target.closest("[data-evento-back]")) { loadEventos(); return; }
    if (e.target.closest("[data-evento-export]")) { exportEventoMd(); return; }
    const tab = e.target.closest("[data-evento-tab]");
    if (tab) { state.eventoTab = tab.dataset.eventoTab; renderEventoDetail(state.eventoData); return; }
    const vw = e.target.closest("[data-evento-view]");
    if (vw) { state.eventoView = vw.dataset.eventoView; renderEventoDetail(state.eventoData); return; }
    if (e.target.closest("#evento-item-add")) { eventoAddRow(); return; }
    const itDel = e.target.closest("[data-evento-item-del]");
    if (itDel) { await postJson("/api/intelligence?type=evt_item_remove", { id: itDel.dataset.eventoItemDel }).catch(() => {}); openEvento(state.currentEventoId); return; }
    // F-EVT5: checklist agrupado por área
    if (e.target.closest("#evt-seed-envios")) { evtSeedEnvios(); return; }
    const addCat = e.target.closest("[data-evt-add-cat]");
    if (addCat) { eventoAddRow(addCat.dataset.evtAddCat || undefined); return; }
    const catTog = e.target.closest("[data-evt-cat-toggle]");
    if (catTog) { const s = state.eventoCatCollapsed = state.eventoCatCollapsed || new Set(); const a = catTog.dataset.evtCatToggle; s.has(a) ? s.delete(a) : s.add(a); renderEventoDetail(state.eventoData); return; }
    if (e.target.closest("#evt-area-collapse-all")) { state.eventoCatCollapsed = new Set(evtAreaOrder(state.eventoData?.colunas, state.eventoData?.itens)); renderEventoDetail(state.eventoData); return; }
    if (e.target.closest("#evt-area-expand-all")) { state.eventoCatCollapsed = new Set(); renderEventoDetail(state.eventoData); return; }
    if (e.target.closest("#evento-col-add")) { eventoAddColumn(); return; }
    const cr = e.target.closest("[data-evento-col-ren]");
    if (cr) { eventoRenameColumn(cr.dataset.eventoColRen); return; }
    const cd = e.target.closest("[data-evento-col-del]");
    if (cd) { eventoDeleteColumn(cd.dataset.eventoColDel); return; }
    if (e.target.closest("#ev-save")) { eventoSaveDados(); return; }
    if (e.target.closest("#ev-meta-save")) { eventoMetaSave(); return; }
    // F-EVT2: Programação
    if (e.target.closest("#prog-add")) { evtSubSave("programacao", { evento_id: state.currentEventoId, horario: $("#prog-horario")?.value || "", titulo: $("#prog-titulo")?.value || "", tipo: $("#prog-tipo")?.value, painel_ref: $("#prog-painelref")?.value || "", ordem: (state.eventoData?.programacao || []).length }); return; }
    const progDel = e.target.closest("[data-prog-del]");
    if (progDel) { evtSubRemove("programacao", progDel.dataset.progDel); return; }
    // Painelistas
    if (e.target.closest("#pain-add")) { evtSubSave("painelista", { evento_id: state.currentEventoId, nome: $("#pain-nome")?.value || "", painel: $("#pain-painel")?.value || "", cargo: $("#pain-cargo")?.value || "", empresa: $("#pain-empresa")?.value || "", papel: $("#pain-papel-new")?.value }); return; }
    const painDel = e.target.closest("[data-pain-del]");
    if (painDel) { evtSubRemove("painelista", painDel.dataset.painDel); return; }
    const painDossie = e.target.closest("[data-pain-dossie]");
    if (painDossie) { suppressDirectorsAutoload = true; document.querySelector("[data-view='directors']")?.click(); openDirectorDossier(painDossie.dataset.painDossie); return; }
    const painLink = e.target.closest("[data-pain-link]");
    if (painLink) { evtPainLinkOpen(painLink.dataset.painLink); return; }
    if (e.target.closest("#pain-link-search")) { evtPainLinkSearch(); return; }
    const painPick = e.target.closest("[data-pain-pick]");
    if (painPick) { evtSubSave("painelista", { id: state.painLinkId, person_id: painPick.dataset.painPick }); return; }
    // Patrocínio
    if (e.target.closest("#patr-add")) { evtSubSave("patrocinador", { evento_id: state.currentEventoId, nome: $("#patr-nome")?.value || "", cota: $("#patr-cota")?.value || "", valor: $("#patr-valor")?.value || null, estagio: "Alvo" }); return; }
    const patrDel = e.target.closest("[data-patr-del]");
    if (patrDel) { evtSubRemove("patrocinador", patrDel.dataset.patrDel); return; }
    const patrOut = e.target.closest("[data-patr-outcome]");
    if (patrOut) { prospOutcome(patrOut.dataset.patrOutcome); return; }
    const patrBase = e.target.closest("[data-patr-base]");  // F-EVT7: leva um patrocinador Perdido/Associado p/ a Base
    if (patrBase) { contatoFromPatrocinador(patrBase.dataset.patrBase); return; }
    // Cotas-catálogo
    if (e.target.closest("#cota-add")) {
      const nome = ($("#cota-nome")?.value || "").trim();
      if (!nome) return;
      const valorRaw = $("#cota-valor")?.value;
      eventoCotasSave([...eventoCotas(), { nome, valor: (valorRaw === "" || valorRaw == null) ? null : Number(valorRaw), beneficios: ($("#cota-benef")?.value || "").trim() }]);
      return;
    }
    const cotaDel = e.target.closest("[data-cota-del]");
    if (cotaDel) { const i = Number(cotaDel.dataset.cotaDel); eventoCotasSave(eventoCotas().filter((_, ix) => ix !== i)); return; }
    // Convidados
    if (e.target.closest("#conv-add")) { evtSubSave("convidado", { evento_id: state.currentEventoId, nome: $("#conv-nome")?.value || "", empresa: $("#conv-empresa")?.value || "" }); return; }
    const convDel = e.target.closest("[data-conv-del]");
    if (convDel) { evtSubRemove("convidado", convDel.dataset.convDel); return; }
    if (e.target.closest("#conv-import-btn")) { const b = $("#conv-import-box"); if (b) b.hidden = !b.hidden; return; }
    if (e.target.closest("#conv-import-do")) { evtConvidadoImport(); return; }
    // F-EVT4: Prospecção (Score de Patrocinador)
    if (e.target.closest("#prosp-run")) { prospRun(); return; }
    if (e.target.closest("#prosp-refresh")) { loadProspeccao(); return; }
    if (e.target.closest("#prosp-validate")) { prospValidate(); return; }
    if (e.target.closest("#prosp-calib-save")) { prospCalibSave(); return; }
    if (e.target.closest("#prosp-insumos-toggle")) { prospInsumosToggle(); return; }
    const ctAdd = e.target.closest("[data-prosp-ct-add]"); if (ctAdd) { prospContatoAdd(ctAdd.dataset.prospCtAdd); return; }
    const ctDel = e.target.closest("[data-prosp-ct-del]"); if (ctDel) { postJson("/api/intelligence?type=evt_sponsor_contato_remove", { id: ctDel.dataset.prospCtDel }).then(loadProspeccao).catch(() => {}); return; }
    const pPromote = e.target.closest("[data-prosp-promote]"); if (pPromote) { prospPromote(pPromote.dataset.prospPromote); return; }
    const pAngle = e.target.closest("[data-prosp-angle]"); if (pAngle) { prospAngle(pAngle.dataset.prospAngle); return; }
    const pApprove = e.target.closest("[data-prosp-approve]"); if (pApprove) { prospApprove(pApprove.dataset.prospApprove); return; }
    const pDiscard = e.target.closest("[data-prosp-discard]"); if (pDiscard) { prospDiscard(pDiscard.dataset.prospDiscard); return; }
    if (e.target.closest("#refnote-add")) { prospRefNoteAdd(); return; }
    const rnDel = e.target.closest("[data-refnote-del]"); if (rnDel) { postJson("/api/intelligence?type=evt_ref_note_remove", { id: rnDel.dataset.refnoteDel }).then(prospInsumosReload).catch(() => {}); return; }
    if (e.target.closest("#golden-add")) { prospGoldenAdd(); return; }
    const gDel = e.target.closest("[data-golden-del]"); if (gDel) { postJson("/api/intelligence?type=evt_golden_remove", { id: gDel.dataset.goldenDel }).then(prospInsumosReload).catch(() => {}); return; }
  });
  view.addEventListener("change", (e) => {
    // F-EVT7: edição inline da Base + filtro de relação
    const bc = e.target.closest("[data-bc-id]");
    if (bc) { bcSave(bc.dataset.bcId, { [bc.dataset.bcField]: bc.value }); return; }
    if (e.target.id === "base-rel") { state.baseRel = e.target.value || null; loadBase(); return; }
    const esub = e.target.closest("[data-esub-id]");
    if (esub) {
      const val = esub.type === "checkbox" ? esub.checked : esub.value;
      const patch = { [esub.dataset.esubField]: val };
      // F-EVT7: estágio deriva o status legado (somas/funil) — espelha no state local p/ o re-render bater com o backend.
      if (esub.dataset.esubKind === "patrocinador" && esub.dataset.esubField === "estagio") patch.status = ESTAGIO_TO_STATUS[val] || undefined;
      evtSubField(esub.dataset.esubKind, esub.dataset.esubId, patch);
      if (esub.tagName === "SELECT") renderEventoDetail(state.eventoData); // F-EVT6: select muda densidade/contadores/somas — atualiza na hora
      return;
    }
    const chk = e.target.closest("[data-evt-check-status]");
    if (chk) {
      const id = chk.dataset.evtCheckStatus, val = chk.checked ? "feito" : "pendente";
      evtLocalSet(id, { status: val });
      postJson("/api/intelligence?type=evt_item_update", { id, valores: { status: val } })
        .then((r) => { if (r?.ok) renderEventoDetail(state.eventoData); else openEvento(state.currentEventoId); })
        .catch(() => openEvento(state.currentEventoId));
      return;
    }
    const mv = e.target.closest("[data-evt-move]"); // F-EVT5: mover item de área
    if (mv) { evtMoveArea(mv.dataset.evtMove, mv.value); return; }
    const cell = e.target.closest("[data-evt-id][data-evt-key]");
    if (cell) { evtCellUpdate(cell); }
  });
  view.addEventListener("input", (e) => { // F-EVT7: busca ao vivo na Base — só o tbody (mantém foco no input)
    if (e.target.id === "base-search") { state.baseQ = e.target.value; const tb = $("#base-tbody"); if (tb) tb.innerHTML = renderBaseRows(); }
  });
}

// ══════════════════ F-FIN1: Financeiro — Balancete ══════════════════════
// Importa o extrato bancário → formata no padrão do Balancete → numera despesas
// (crédito NÃO contabiliza) → carta justificativa + NF por despesa → gera o documento.
// LGPD: dado financeiro + nomes de PIX vivem só no app; o documento é BAIXADO (nunca no git).
let financeiroWired = false;
const FIN_CONTAS = ["Banco do Brasil", "BTG", "BTG poupança", "BTG cartão"];

async function loadFinanceiro() {
  wireFinanceiro();
  const grid = $("#financeiro-grid"), detail = $("#financeiro-detail");
  if (!grid) return;
  state.currentBalanceteId = null;
  if (detail) { detail.hidden = true; detail.innerHTML = ""; }
  grid.hidden = false;
  grid.innerHTML = emptyCard("Balancete", "Carregando…");
  try {
    const r = await requestJson("/api/intelligence?type=fin_list");
    const items = r?.items || [];
    if (!items.length) { grid.innerHTML = emptyCard("Balancete", "Nenhum balancete ainda. Clique em “+ Novo balancete”."); return; }
    grid.innerHTML = items.map((b) => `<article class="news-card target-card selectable" data-open-balancete="${escapeHtml(b.id)}">
      <div class="card-body">
        <div class="card-head"><div>
          <strong>${escapeHtml(b.titulo || ("Balancete " + (b.competencia || "")))}</strong>
          <span class="card-sub">${escapeHtml(b.competencia || "")}</span>
        </div></div>
        <div class="entity-row" style="flex-wrap:wrap">
          <span class="entity-pill">${escapeHtml(b.status || "aberto")}</span>
          <span class="entity-pill">${b.n_lancamentos || 0} lançamentos</span>
          <span class="entity-pill">despesas ${money(b.total_despesas || 0)}</span>
          <button type="button" class="entity-pill" data-balancete-del="${escapeHtml(b.id)}">Excluir</button>
        </div>
      </div>
      ${cardFoot("var(--blue)", b.status || "Balancete", "IRIS//FINANCEIRO")}
    </article>`).join("");
  } catch (e) { grid.innerHTML = emptyCard("Balancete", `Falha: ${e.message}`); }
}
async function finBalanceteCreate() {
  const competencia = prompt("Competência do balancete (AAAA-MM, ex.: 2026-03):");
  if (competencia == null) return;
  if (!/^\d{4}-\d{2}$/.test(competencia.trim())) { alert("Formato: AAAA-MM (ex.: 2026-03)"); return; }
  try {
    const r = await postJson("/api/intelligence?type=fin_save", { competencia: competencia.trim() });
    if (r?.ok && r.balancete) { await loadFinanceiro(); openBalancete(r.balancete.id); } else alert(r?.error || "erro");
  } catch (e) { alert(`Falha: ${e.message}`); }
}
async function openBalancete(id) {
  const grid = $("#financeiro-grid"), detail = $("#financeiro-detail");
  if (!detail) return;
  state.currentBalanceteId = id;
  if (grid) grid.hidden = true;
  detail.hidden = false;
  detail.innerHTML = emptyCard("Balancete", "Abrindo…");
  try {
    const d = await requestJson(`/api/intelligence?type=fin_get&id=${encodeURIComponent(id)}`);
    if (!d?.ok) throw new Error(d?.error || "erro");
    state.balanceteData = d;
    renderBalanceteDetail(d);
  } catch (e) { detail.innerHTML = emptyCard("Balancete", `Falha: ${e.message}`); }
}
// Nº DOC derivado: sequência sobre débitos CONTABILIZADOS, na ordem de exibição (ordem/data).
function finNumbering(lancs) {
  const map = {}; let n = 0;
  for (const l of lancs || []) if (l.tipo === "debito" && l.contabiliza) map[l.id] = ++n;
  return map;
}
function finCell(l, field, val, kind, opts) {
  const a = `data-fl-id="${escapeHtml(l.id)}" data-fl-field="${field}"`;
  if (kind === "select") return `<select ${a} class="dou-date">${(opts || []).map((o) => `<option value="${escapeHtml(o)}" ${String(val || "") === o ? "selected" : ""}>${escapeHtml(o || "—")}</option>`).join("")}</select>`;
  if (kind === "date") return `<input type="date" ${a} class="dou-date" style="width:132px" value="${escapeHtml(String(val || "").slice(0, 10))}">`;
  if (kind === "num") return `<input type="number" step="0.01" ${a} class="dou-date" style="width:110px" value="${val == null ? "" : escapeHtml(String(val))}">`;
  return `<input ${a} class="dou-date" style="min-width:110px" value="${escapeHtml(val == null ? "" : String(val))}">`;
}
function renderBalanceteDetail(d) {
  const detail = $("#financeiro-detail");
  if (!detail || !d) return;
  const bal = d.balancete || {}, lancs = d.lancamentos || [];
  const num = finNumbering(lancs);
  const contas = [...new Set(lancs.map((l) => l.conta || "Banco do Brasil"))];
  if (!contas.length) contas.push("Banco do Brasil");
  const totalDespesas = lancs.filter((l) => l.tipo === "debito" && l.contabiliza).reduce((s, l) => s + (Number(l.valor) || 0), 0);
  const secaoConta = (conta) => {
    const ls = lancs.filter((l) => (l.conta || "Banco do Brasil") === conta);
    const desp = ls.filter((l) => l.tipo === "debito" && l.contabiliza).reduce((s, l) => s + (Number(l.valor) || 0), 0);
    const rows = ls.map((l) => {
      const isCred = l.tipo === "credito";
      return `<tr style="${isCred ? "opacity:.55" : ""}">
        <td>${finCell(l, "data", l.data, "date")}</td>
        <td>${finCell(l, "lancamento", l.lancamento, "text")}</td>
        <td>${finCell(l, "detalhe", l.detalhe, "text")}</td>
        <td>${finCell(l, "descricao", l.descricao, "text")}</td>
        <td>${finCell(l, "valor", l.valor, "num")}</td>
        <td>${finCell(l, "tipo", l.tipo, "select", ["debito", "credito"])}</td>
        <td style="text-align:center">${num[l.id] || (isCred ? "—" : "·")}</td>
        <td style="white-space:nowrap">${l.nf_url ? `<a href="${escapeHtml(l.nf_url)}" target="_blank" rel="noopener" class="entity-pill">NF ↗</a>` : (l.nf_path ? `<span class="entity-pill" style="opacity:.6">NF</span>` : "")}<label class="entity-pill" style="cursor:pointer;font-size:.7rem" title="anexar NF">+NF<input type="file" accept="image/*,application/pdf" data-fl-nf="${escapeHtml(l.id)}" hidden></label>${l.nf_path ? ` <button type="button" class="entity-pill" data-fl-nfdel="${escapeHtml(l.id)}" style="font-size:.7rem">×NF</button>` : ""}</td>
        <td><button type="button" class="entity-pill" data-fl-del="${escapeHtml(l.id)}">×</button></td>
      </tr>`;
    }).join("");
    return `<div style="margin-top:10px">
      <strong style="font-size:.9rem">${escapeHtml(conta)}</strong> <span class="card-sub">· despesas ${money(desp)}</span>
      <div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Data</th><th>Lançamento</th><th>Detalhe</th><th>Descrição (finalidade)</th><th>Valor</th><th>Tipo</th><th>Nº DOC</th><th>NF</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="9" class="card-sub">Sem lançamentos. Importe o extrato ou adicione uma linha.</td></tr>`}</tbody></table></div>
      <div class="entity-row" style="gap:6px;margin-top:4px"><button type="button" class="entity-pill" data-fl-add="${escapeHtml(conta)}">+ lançamento</button></div>
    </div>`;
  };
  detail.innerHTML = `<article class="news-card">
    <div class="entity-row" style="justify-content:space-between;flex-wrap:wrap;gap:6px">
      <button type="button" class="entity-pill" data-balancete-back>&larr; Balancetes</button>
      <div class="entity-row" style="gap:6px;flex-wrap:wrap">
        <button type="button" class="entity-pill" id="fin-import-btn">Importar extrato</button>
        <button type="button" class="entity-pill" id="fin-config-btn">Config / assinaturas</button>
        <button type="button" class="entity-pill" id="fin-doc-btn">Gerar documento</button>
      </div>
    </div>
    <strong>${escapeHtml(bal.titulo || ("Balancete " + (bal.competencia || "")))}</strong>
    <span class="card-sub">${escapeHtml(bal.competencia || "")} · ${escapeHtml(bal.status || "aberto")}</span>
    <div id="fin-import-box" hidden style="margin:8px 0;border:1px solid var(--border);border-radius:6px;padding:8px">
      <div class="entity-row" style="gap:6px;flex-wrap:wrap"><span class="card-sub">Cole o texto do extrato (Banco do Brasil) e escolha a conta:</span>
        <select id="fin-import-conta" class="dou-date">${FIN_CONTAS.map((c) => `<option>${escapeHtml(c)}</option>`).join("")}</select></div>
      <textarea id="fin-import-text" class="dou-date" style="width:100%;min-height:120px;margin-top:6px" placeholder="Cole aqui os lançamentos do extrato…"></textarea>
      <div class="entity-row" style="gap:6px;margin-top:6px"><button type="button" class="entity-pill" id="fin-import-do">Importar</button><span id="fin-import-status" class="card-sub"></span></div>
      <p class="card-sub" style="margin:4px 0 0">Parser do formato Banco do Brasil (regex, sem IA) — confira e corrija na tabela o que sair errado.</p>
    </div>
    <div id="fin-config-box" hidden style="margin:8px 0"></div>
    ${contas.map(secaoConta).join("")}
    <div class="entity-row" style="justify-content:flex-end;margin-top:10px"><strong>TOTAL DESPESAS ${money(totalDespesas)}</strong></div>
  </article>`;
}
async function finLancSave(id, patch) {
  const l = (state.balanceteData?.lancamentos || []).find((x) => String(x.id) === String(id));
  if (l) Object.assign(l, patch);
  // tipo=credito -> contabiliza false (espelha o backend p/ o re-render bater)
  if (patch.tipo && l) { l.contabiliza = patch.tipo === "credito" ? false : true; }
  try {
    const r = await postJson("/api/intelligence?type=fin_lancamento_save", { id, ...patch });
    if (!r?.ok) throw new Error(r?.error || "erro");
    // re-render quando o campo afeta soma/estilo/ordem (senão os totais da grid ficam defasados do documento)
    if (patch.tipo || patch.valor !== undefined || patch.data !== undefined || "contabiliza" in patch) renderBalanceteDetail(state.balanceteData);
  } catch (e) { alert(`Falha ao salvar: ${e.message}`); openBalancete(state.currentBalanceteId); }
}
async function finLancAdd(conta) {
  try {
    const r = await postJson("/api/intelligence?type=fin_lancamento_add", { balancete_id: state.currentBalanceteId, conta });
    if (!r?.ok) throw new Error(r?.error || "erro");
    openBalancete(state.currentBalanceteId);
  } catch (e) { alert(`Falha: ${e.message}`); }
}
function wireFinanceiro() {
  if (financeiroWired) return; financeiroWired = true;
  const view = $("#view-financeiro");
  if (!view) return;
  $("#financeiro-create")?.addEventListener("click", finBalanceteCreate);
  view.addEventListener("click", async (e) => {
    const open = e.target.closest("[data-open-balancete]"); if (open) { openBalancete(open.dataset.openBalancete); return; }
    const bdel = e.target.closest("[data-balancete-del]");
    if (bdel) { e.stopPropagation(); if (confirm("Excluir este balancete e todos os lançamentos?")) { await postJson("/api/intelligence?type=fin_delete", { id: bdel.dataset.balanceteDel }).catch(() => {}); loadFinanceiro(); } return; }
    if (e.target.closest("[data-balancete-back]")) { loadFinanceiro(); return; }
    if (e.target.closest("#fin-import-btn")) { const b = $("#fin-import-box"); if (b) b.hidden = !b.hidden; return; }
    if (e.target.closest("#fin-import-do")) { finImportExtrato(); return; }
    if (e.target.closest("#fin-config-btn")) { finToggleConfig(); return; }
    if (e.target.closest("#fin-doc-btn")) { finGerarDoc(); return; }
    if (e.target.closest("#fin-config-save")) { finConfigSave(); return; }
    const add = e.target.closest("[data-fl-add]"); if (add) { finLancAdd(add.dataset.flAdd); return; }
    const fdel = e.target.closest("[data-fl-del]"); if (fdel) { if (confirm("Remover lançamento?")) postJson("/api/intelligence?type=fin_lancamento_remove", { id: fdel.dataset.flDel }).then(() => openBalancete(state.currentBalanceteId)).catch(() => {}); return; }
    const nfdel = e.target.closest("[data-fl-nfdel]"); if (nfdel) { if (confirm("Remover a NF?")) postJson("/api/intelligence?type=fin_nf_remove", { id: nfdel.dataset.flNfdel }).then(() => openBalancete(state.currentBalanceteId)).catch((err) => alert(err.message)); return; }
  });
  view.addEventListener("change", (e) => {
    const cell = e.target.closest("[data-fl-id]");
    if (cell) { finLancSave(cell.dataset.flId, { [cell.dataset.flField]: cell.type === "checkbox" ? cell.checked : cell.value }); return; }
    const nf = e.target.closest("[data-fl-nf]");
    if (nf && nf.files && nf.files[0]) { finNfUpload(nf.dataset.flNf, nf.files[0]); nf.value = ""; return; }
  });
}
// C: importar extrato (parser regex do BB, no backend).
async function finImportExtrato() {
  const texto = $("#fin-import-text")?.value || "", conta = $("#fin-import-conta")?.value || "Banco do Brasil", st = $("#fin-import-status");
  if (!texto.trim()) return;
  if (st) st.textContent = "Importando…";
  try {
    const r = await postJson("/api/intelligence?type=fin_extrato_import", { balancete_id: state.currentBalanceteId, conta, texto });
    if (!r?.ok) throw new Error(r?.error || "erro");
    if (st) st.textContent = `${r.inserted} lançamento(s), ${r.pulados} já existiam.`;
    openBalancete(state.currentBalanceteId);
  } catch (e) { if (st) st.textContent = `Falha: ${e.message}`; }
}
// D: upload da NF (Supabase Storage via backend service-role).
async function finNfUpload(lancId, file) {
  if (file.size > 4 * 1024 * 1024) { alert("Arquivo muito grande (máx 4MB). Comprima a NF."); return; }
  toast("Enviando NF…");
  try {
    const base64 = await fileToBase64(file);
    const r = await postJson("/api/intelligence?type=fin_nf_upload", { id: lancId, base64, filename: file.name, mime: file.type });
    if (!r?.ok) throw new Error(r?.error || "erro");
    toast("NF anexada.");
    openBalancete(state.currentBalanceteId);
  } catch (e) { alert(`Falha: ${e.message}`); }
}
// E: config (org + assinaturas) — editável na metadata; nomes de pessoas ficam AQUI, não no código.
const FIN_ORG_DEFAULT = { nome: "Instituto de Regulação, Inovação e Sustentabilidade – IRIS", cnpj: "", endereco: "" };
function finOrg(bal) { return { ...FIN_ORG_DEFAULT, ...((bal.metadata && bal.metadata.org) || {}) }; }
function finAssin(bal) { return (bal.metadata && bal.metadata.assinaturas) || {}; }
function finToggleConfig() {
  const box = $("#fin-config-box");
  if (!box) return;
  if (!box.hidden) { box.hidden = true; return; }
  box.hidden = false;
  const bal = state.balanceteData?.balancete || {}, org = finOrg(bal), a = finAssin(bal);
  const inp = (id, ph, val) => `<input id="${id}" class="dou-date" style="min-width:200px;flex:1" placeholder="${escapeHtml(ph)}" value="${escapeHtml(val || "")}">`;
  box.innerHTML = `<div style="border:1px solid var(--border);border-radius:6px;padding:8px">
    <strong style="font-size:.9rem">Config do balancete (organização e assinaturas)</strong>
    <div class="card-sub">Os nomes das pessoas ficam só aqui (não no código) e entram no documento gerado.</div>
    <div class="entity-row" style="gap:6px;flex-wrap:wrap;margin-top:6px">${inp("fin-org-nome", "Organização", org.nome)}${inp("fin-org-cnpj", "CNPJ", org.cnpj)}${inp("fin-org-end", "Endereço", org.endereco)}</div>
    <div class="entity-row" style="gap:6px;flex-wrap:wrap;margin-top:6px">${inp("fin-a-fin", "Diretor Financeiro (nome)", a.diretor_financeiro)}${inp("fin-a-cont", "Contador (nome)", a.contador)}${inp("fin-a-crc", "CRC do contador", a.contador_crc)}</div>
    <div class="entity-row" style="gap:6px;flex-wrap:wrap;margin-top:6px">${inp("fin-a-cpres", "Conselho Fiscal — presidente", a.conselho_presidente)}${inp("fin-a-c1", "Conselho Fiscal — membro", a.conselho1)}${inp("fin-a-c2", "Conselho Fiscal — membro", a.conselho2)}</div>
    <div class="entity-row" style="gap:6px;margin-top:6px">${inp("fin-titulo", "Título do balancete (opcional)", bal.titulo)}<button type="button" class="entity-pill" id="fin-config-save">Salvar config</button><span id="fin-config-status" class="card-sub"></span></div>
  </div>`;
}
async function finConfigSave() {
  const st = $("#fin-config-status"); if (st) st.textContent = "Salvando…";
  const meta = {
    org: { nome: $("#fin-org-nome")?.value || "", cnpj: $("#fin-org-cnpj")?.value || "", endereco: $("#fin-org-end")?.value || "" },
    assinaturas: { diretor_financeiro: $("#fin-a-fin")?.value || "", contador: $("#fin-a-cont")?.value || "", contador_crc: $("#fin-a-crc")?.value || "", conselho_presidente: $("#fin-a-cpres")?.value || "", conselho1: $("#fin-a-c1")?.value || "", conselho2: $("#fin-a-c2")?.value || "" }
  };
  try {
    const r = await postJson("/api/intelligence?type=fin_save", { id: state.currentBalanceteId, metadata: meta, titulo: $("#fin-titulo")?.value || "" });
    if (!r?.ok) throw new Error(r?.error || "erro");
    if (state.balanceteData) state.balanceteData.balancete = r.balancete;
    if (st) st.textContent = "Salvo.";
  } catch (e) { if (st) st.textContent = `Falha: ${e.message}`; }
}
// pt-BR: valor por extenso (reais/centavos) para a carta.
function valorPorExtenso(v) {
  const total = Math.round((Number(v) || 0) * 100), reais = Math.floor(total / 100), cent = total % 100;
  const U = ["zero", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez", "onze", "doze", "treze", "quatorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove"];
  const D = ["", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"];
  const C = ["", "cento", "duzentos", "trezentos", "quatrocentos", "quinhentos", "seiscentos", "setecentos", "oitocentos", "novecentos"];
  const ate999 = (n) => {
    if (n === 0) return "";
    if (n === 100) return "cem";
    const c = Math.floor(n / 100), r = n % 100, out = [];
    if (c) out.push(C[c]);
    if (r > 0 && r < 20) out.push(U[r]);
    else if (r >= 20) { const d = Math.floor(r / 10), un = r % 10; out.push(D[d] + (un ? " e " + U[un] : "")); }
    return out.join(" e ");
  };
  const extenso = (n) => {
    if (n === 0) return "zero";
    const mi = Math.floor(n / 1000000), mil = Math.floor((n % 1000000) / 1000), r = n % 1000, parts = [];
    if (mi) parts.push(ate999(mi) + (mi === 1 ? " milhão" : " milhões"));
    if (mil) parts.push(mil === 1 ? "mil" : ate999(mil) + " mil");
    if (r) parts.push(ate999(r));
    let s = parts.join(", ");
    if (parts.length > 1 && (r === 0 || r < 100 || r % 100 === 0)) s = s.replace(/, ([^,]*)$/, " e $1");
    return s;
  };
  const de = (reais >= 1000000 && reais % 1000000 === 0) ? "de " : ""; // "um milhão DE reais" (só p/ milhões/bilhões exatos)
  return extenso(reais) + " " + de + (reais === 1 ? "real" : "reais") + (cent ? " e " + extenso(cent) + " " + (cent === 1 ? "centavo" : "centavos") : "");
}
function finDataFmt(d) { return d ? new Date(String(d).slice(0, 10) + "T12:00:00").toLocaleDateString("pt-BR") : "___"; }
function cartaJustificativaTexto(desp, org) {
  const estab = desp.estabelecimento || desp.detalhe || "";
  const fin = desp.descricao || "[preencher a finalidade]";
  return [
    `${org.nome}${org.cnpj ? ` (CNPJ: ${org.cnpj})` : ""} vem, por meio desta, apresentar a justificativa referente à despesa: ${fin}, ocorrida em ${finDataFmt(desp.data)}${estab ? `, junto a ${estab}` : ""}, no valor de ${money(desp.valor || 0)} (${valorPorExtenso(desp.valor || 0)}).`,
    `A despesa mostrou-se necessária ao desenvolvimento das atividades institucionais do Instituto, observando os princípios de economicidade, pertinência, razoabilidade e transparência.`
  ];
}
// F: gerar o documento (markdown baixado + HTML no padrão p/ imprimir PDF). Nunca no git.
function finGerarDoc() {
  const d = state.balanceteData;
  if (!d) return;
  const bal = d.balancete || {}, lancs = d.lancamentos || [], org = finOrg(bal), a = finAssin(bal);
  const num = finNumbering(lancs);
  const contas = [...new Set(lancs.map((l) => l.conta || "Banco do Brasil"))];
  const saldos = (bal.metadata && bal.metadata.saldos) || {};
  const despesas = lancs.filter((l) => l.tipo === "debito" && l.contabiliza).map((l) => ({ ...l, num: num[l.id] }));
  const totalDespesas = despesas.reduce((s, l) => s + (Number(l.valor) || 0), 0);
  const comp = bal.competencia || "";
  // ---- markdown ----
  const cell = (s) => String(s == null ? "" : s).replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
  const L = [`# Balancete (${comp})`, "", `**${org.nome}**${org.cnpj ? ` · CNPJ ${org.cnpj}` : ""}`, ""];
  for (const conta of contas) {
    const ls = lancs.filter((l) => (l.conta || "Banco do Brasil") === conta);
    L.push(`## ${conta}`, "");
    const saMd = Number((saldos[conta] || {}).anterior);
    if (Number.isFinite(saMd)) L.push(`Saldo anterior: ${money(saMd)}`, "");
    L.push("| Data | Lançamento | Detalhe | Descrição | Valor | Tipo | Nº DOC |", "| --- | --- | --- | --- | --- | ---: | ---: |");
    for (const l of ls) L.push(`| ${cell(finDataFmt(l.data))} | ${cell(l.lancamento)} | ${cell(l.detalhe)} | ${cell(l.descricao)} | ${money(l.valor || 0)} | ${l.tipo} | ${num[l.id] || (l.tipo === "credito" ? "—" : "")} |`);
    const desp = ls.filter((l) => l.tipo === "debito" && l.contabiliza).reduce((s, l) => s + (Number(l.valor) || 0), 0);
    L.push("", `**TOTAL DESPESAS ${conta}: ${money(desp)}**`, "");
  }
  L.push("---", "", `**TOTAL DESPESAS: ${money(totalDespesas)}**`, "", "## Assinaturas", "",
    `${a.diretor_financeiro || "____________________"} — Diretor Financeiro`,
    `${a.contador || "____________________"} — ${a.contador_crc ? "CRC " + a.contador_crc : "Contabilidade"}`,
    `Visto — Conselho Fiscal: ${[a.conselho_presidente, a.conselho1, a.conselho2].filter(Boolean).join(", ") || "____________________"}`, "");
  for (const desp of despesas) {
    L.push("---", "", `### ANEXO Nº${String(desp.num).padStart(2, "0")} — Carta de justificativa`, "");
    for (const par of cartaJustificativaTexto(desp, org)) L.push(par, "");
    if (desp.nf_url) L.push(`Nota Fiscal: ${desp.nf_url}`, "");
  }
  const slug = `balancete-${comp || "sem-data"}`;
  downloadText(`${slug}.md`, L.join("\n"));
  // ---- HTML no padrão → imprimir ----
  const esc = escapeHtml;
  const th = "border:1px solid #345;padding:4px 6px;font-size:9pt;text-transform:uppercase;letter-spacing:.05em;background:#eef2f7;text-align:left";
  const td = "border:1px solid #ccd;padding:3px 6px;font-size:9.5pt";
  let html = `<div style="font-family:Georgia,serif;color:#111">
    <div style="text-align:center;padding:120px 0 60px"><div style="font-size:28pt;letter-spacing:.2em;color:#1a2b4a">IRIS</div><div style="font-size:20pt;margin-top:24px">Balancete (${esc(comp)})</div></div>`;
  for (const conta of contas) {
    const ls = lancs.filter((l) => (l.conta || "Banco do Brasil") === conta);
    const sa = Number((saldos[conta] || {}).anterior); // coage p/ número (metadata é livre) — evita money(string crua) no HTML
    html += `<div style="page-break-before:always;padding-top:8px"><div style="border-bottom:2px solid #3355aa;padding-bottom:6px;margin-bottom:8px"><span style="font-size:9pt;letter-spacing:.1em;color:#555">EXTRATO BANCÁRIO · CONTA</span><br><strong style="font-size:16pt">${esc(conta)}</strong></div>`;
    if (Number.isFinite(sa)) html += `<p style="font-size:10pt"><strong>Saldo anterior:</strong> ${money(sa)}</p>`;
    html += `<table style="border-collapse:collapse;width:100%"><thead><tr><th style="${th}">Data</th><th style="${th}">Lançamento</th><th style="${th}">Detalhe</th><th style="${th}">Descrição</th><th style="${th};text-align:right">Valor</th><th style="${th}">Tipo</th><th style="${th};text-align:right">Nº DOC</th></tr></thead><tbody>`;
    for (const l of ls) html += `<tr${l.tipo === "credito" ? ' style="color:#888"' : ""}><td style="${td}">${esc(finDataFmt(l.data))}</td><td style="${td}">${esc(l.lancamento)}</td><td style="${td}">${esc(l.detalhe)}</td><td style="${td}">${esc(l.descricao)}</td><td style="${td};text-align:right">${money(l.valor || 0)}</td><td style="${td}">${esc(l.tipo)}</td><td style="${td};text-align:right">${num[l.id] || (l.tipo === "credito" ? "—" : "")}</td></tr>`;
    const desp = ls.filter((l) => l.tipo === "debito" && l.contabiliza).reduce((s, l) => s + (Number(l.valor) || 0), 0);
    html += `</tbody></table><p style="text-align:right;font-size:11pt;margin-top:6px"><strong>TOTAL DESPESAS: ${money(desp)}</strong></p></div>`;
  }
  html += `<div style="page-break-before:always;padding-top:40px;text-align:center"><h2 style="letter-spacing:.1em">ASSINATURAS</h2>
    <div style="margin-top:60px">____________________<br><strong>${esc(a.diretor_financeiro || "")}</strong><br><span style="font-size:9pt">Diretor Financeiro — ${esc(org.nome)}</span></div>
    <div style="margin-top:50px">____________________<br><strong>${esc(a.contador || "")}</strong><br><span style="font-size:9pt">${esc(a.contador_crc ? "CRC " + a.contador_crc : "Contabilidade")}</span></div>
    <div style="margin-top:40px;font-size:9pt">VISTO — Conselho Fiscal</div>
    ${[a.conselho_presidente, a.conselho1, a.conselho2].filter(Boolean).map((n) => `<div style="margin-top:36px">____________________<br><strong>${esc(n)}</strong><br><span style="font-size:9pt">Conselho Fiscal</span></div>`).join("")}
  </div>`;
  for (const desp of despesas) {
    html += `<div style="page-break-before:always;padding-top:20px"><div style="text-align:center;font-weight:bold">ANEXO Nº${String(desp.num).padStart(2, "0")}</div><div style="text-align:center;font-size:10pt;margin-bottom:16px">CARTA DE JUSTIFICATIVA DE DESPESAS</div>
      <p style="font-size:10pt"><strong>${esc(org.nome)}</strong>${org.cnpj ? `<br>CNPJ: ${esc(org.cnpj)}` : ""}${org.endereco ? `<br>Endereço: ${esc(org.endereco)}` : ""}</p>
      ${cartaJustificativaTexto(desp, org).map((par) => `<p style="font-size:10.5pt;text-align:justify">${esc(par)}</p>`).join("")}
      <p style="margin-top:30px">Atenciosamente,<br>${esc(org.nome)}<br>${esc(a.diretor_financeiro || "Diretor Financeiro")}</p>
      ${desp.nf_url ? (/\.(png|jpe?g|gif|webp)(\?|$)/i.test(desp.nf_url) || (desp.nf_mime || "").startsWith("image/") ? `<div style="text-align:center;margin-top:16px"><img src="${esc(desp.nf_url)}" style="max-width:90%;max-height:520px;border:1px solid #ccc"></div>` : `<p style="margin-top:12px;font-size:9pt">Nota Fiscal anexa: <a href="${esc(desp.nf_url)}">${esc(desp.nf_url)}</a></p>`) : `<p style="margin-top:12px;font-size:9pt;color:#a00">NF pendente.</p>`}
    </div>`;
  }
  html += `</div>`;
  runPrint(html);
}

// ══════════════════ Painéis curados (M21 — NOMOS F1) ══════════════════════
// Módulo único "Painéis": o time cura painéis (proposições/stakeholders/órgãos)
// com prioridade/posicionamento/tags. Multiplexa em /api/intelligence?type=painel_*.
let painelWired = false;

async function loadPaineis() {
  const grid = $("#paineis-grid"), detail = $("#painel-detail");
  if (!grid) return;
  wirePaineis();
  state.currentPainelId = null;
  if (detail) { detail.hidden = true; detail.innerHTML = ""; }
  grid.hidden = false;
  grid.innerHTML = emptyCard("Painéis", "Carregando…");
  try {
    const r = await requestJson("/api/intelligence?type=painel_list");
    const items = r?.items || [];
    if (!items.length) { grid.innerHTML = emptyCard("Painéis", "Nenhum painel ainda. Clique em “+ Criar painel”."); return; }
    grid.innerHTML = items.map((p) => {
      const c = p.counts || {};
      return `<article class="news-card target-card selectable" data-open-painel="${escapeHtml(p.id)}">
        <div class="card-body">
          <div class="card-head"><div>
            <strong>${escapeHtml(p.nome)}</strong>
            <span class="card-sub">${p.cliente ? escapeHtml(p.cliente) + " · " : ""}${escapeHtml((p.descricao || "").slice(0, 80))}</span>
          </div></div>
          <div class="entity-row">
            <span class="entity-pill">${c.proposicao || 0} proposições</span>
            <span class="entity-pill">${c.stakeholder || 0} stakeholders</span>
            <span class="entity-pill">${c.orgao || 0} órgãos</span>
            <button type="button" class="entity-pill" data-painel-del="${escapeHtml(p.id)}">Excluir</button>
          </div>
        </div>
        ${cardFoot("var(--blue)", p.cliente || "Painel", "LINCE//PAINEL")}
      </article>`;
    }).join("");
  } catch (e) { grid.innerHTML = emptyCard("Painéis", `Falha: ${e.message}`); }
}

async function openPainel(id) {
  const grid = $("#paineis-grid"), detail = $("#painel-detail");
  if (!detail) return;
  state.currentPainelId = id;
  state.painelTab = state.painelTab || "dados";
  if (grid) grid.hidden = true;
  detail.hidden = false;
  detail.innerHTML = emptyCard("Painel", "Abrindo…");
  try {
    const d = await requestJson(`/api/intelligence?type=painel_get&id=${encodeURIComponent(id)}`);
    if (!d?.ok) throw new Error(d?.error || "erro");
    state.painelData = d;
    renderPainelDetail(d);
  } catch (e) { detail.innerHTML = emptyCard("Painel", `Falha: ${e.message}`); }
}

function renderPainelDetail(d) {
  const detail = $("#painel-detail");
  if (!detail || !d) return;
  const p = d.painel;
  const tab = state.painelTab || "dados";
  const tabs = [["dados", "Dados Gerais"], ["proposicoes", `Proposições (${d.counts?.proposicoes || 0})`], ["agenda", `Agenda (${d.counts?.agenda || 0})`], ["noticias", `Notícias (${d.counts?.noticias || 0})`], ["stakeholders", `Stakeholders (${d.counts?.stakeholders || 0})`], ["orgaos", `Órgãos (${d.counts?.orgaos || 0})`]];
  detail.innerHTML = `
    <article class="news-card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <button type="button" class="entity-pill" data-painel-back>&larr; Painéis</button>
        <button type="button" class="alert-btn primary" data-painel-report="${escapeHtml(p.id)}">Exportar relatório (.md)</button>
      </div>
      <span class="source-meta">${escapeHtml(p.cliente || "Painel")}</span>
      <strong>${escapeHtml(p.nome)}</strong>
      ${p.descricao ? `<p>${escapeHtml(p.descricao)}</p>` : ""}
      <div class="dossier-tabs">${tabs.map(([id2, lbl]) => `<button type="button" class="dossier-tab ${tab === id2 ? "active" : ""}" data-painel-tab="${id2}">${lbl}</button>`).join("")}</div>
    </article>
    <div id="painel-tab-content">${renderPainelTab(d, tab)}</div>`;
}

function renderPainelTab(d, tab) {
  if (tab === "proposicoes") return renderPainelProposicoes(d);
  if (tab === "agenda") return renderPainelAgenda(d);
  if (tab === "noticias") return renderPainelNoticias(d);
  if (tab === "stakeholders") return renderPainelStakeholders(d);
  if (tab === "orgaos") return renderPainelOrgaos(d);
  return renderPainelDados(d);
}

// F7: aba Notícias — lista curada + curadoria (busca Google News → Fixar; ou colar URL).
function renderPainelNoticias(d) {
  const ns = d.noticias || [], p = d.painel || {};
  const rows = ns.map((n) => {
    const url = safeUrl(n.url);
    const t = escapeHtml(String(n.titulo || n.url || "—").slice(0, 100));
    return `<tr>
      <td>${escapeHtml(String(n.published_at || "").slice(0, 10) || "—")}</td>
      <td>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${t}</a>` : t}</td>
      <td>${escapeHtml(String(n.fonte || "—").slice(0, 40))}</td>
      <td><button type="button" class="entity-pill" data-noticia-remove="${escapeHtml(n.id)}">×</button></td>
    </tr>`;
  }).join("");
  return `<article class="news-card">
    <span class="source-meta">Notícias curadas</span>
    <div class="entity-row" style="flex-wrap:wrap;gap:6px;margin:6px 0">
      <input id="painel-news-q" class="dou-date" style="min-width:220px;flex:1" placeholder="Buscar notícias (Google News)" value="${escapeHtml(p.cliente || p.nome || "")}">
      <button type="button" class="alert-btn primary" id="painel-news-search">Buscar</button>
    </div>
    <div id="painel-news-results"></div>
    <details style="margin:6px 0"><summary style="cursor:pointer;font-size:.78rem;opacity:.7">Adicionar por URL</summary>
      <div class="entity-row" style="flex-wrap:wrap;gap:6px;margin-top:6px">
        <input id="painel-news-url" class="dou-date" style="min-width:200px;flex:1" placeholder="https://...">
        <input id="painel-news-title" class="dou-date" style="min-width:140px" placeholder="Título (opcional)">
        <input id="painel-news-src" class="dou-date" style="min-width:110px" placeholder="Fonte (opcional)">
        <button type="button" class="entity-pill" id="painel-news-manual">Adicionar</button>
      </div>
    </details>
    ${ns.length ? `<div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Data</th><th>Notícia</th><th>Fonte</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p>Nenhuma notícia curada. Busque acima e clique em “Fixar”.</p>`}
  </article>`;
}

async function painelNewsSearch() {
  const q = ($("#painel-news-q")?.value || "").trim();
  const box = $("#painel-news-results");
  if (!q) return;
  if (box) box.innerHTML = `<p style="font-size:.8rem;opacity:.6">Buscando…</p>`;
  try {
    const r = await requestJson(`/api/news?q=${encodeURIComponent(q)}`);
    const items = r?.items || [];
    state.painelNews = items;
    if (box) box.innerHTML = items.length
      ? `<div class="news-list">${items.map((it, i) => `<div class="director-row"><div style="flex:1"><strong>${escapeHtml(String(it.title || "").slice(0, 110))}</strong> <span class="card-sub">${escapeHtml(String(it.source || "").slice(0, 40))}${it.date ? " · " + escapeHtml(String(it.date).slice(0, 16)) : ""}</span></div><button type="button" class="entity-pill" data-news-add="${i}">Fixar</button></div>`).join("")}</div>`
      : `<p style="font-size:.8rem;opacity:.6">Nada encontrado.</p>`;
  } catch (e) { if (box) box.innerHTML = `<p style="font-size:.8rem;opacity:.6">Falha: ${escapeHtml(e.message)}</p>`; }
}

async function painelNewsAdd(index) {
  const it = (state.painelNews || [])[Number(index)];
  if (!it || !state.currentPainelId) return;
  try {
    const r = await postJson("/api/intelligence?type=painel_noticia_add", { painel_id: state.currentPainelId, url: it.link, titulo: it.title, fonte: it.source, published_at: it.date, resumo: it.summary });
    if (r?.ok) openPainel(state.currentPainelId); else alert(r?.error || "erro");
  } catch (e) { alert(`Falha ao fixar: ${e.message}`); }
}

async function painelNewsManual() {
  const url = ($("#painel-news-url")?.value || "").trim();
  const titulo = ($("#painel-news-title")?.value || "").trim();
  const fonte = ($("#painel-news-src")?.value || "").trim();
  if (!url || !state.currentPainelId) return;
  try {
    const r = await postJson("/api/intelligence?type=painel_noticia_add", { painel_id: state.currentPainelId, url, titulo: titulo || null, fonte: fonte || null });
    if (r?.ok) openPainel(state.currentPainelId); else alert(r?.error || "erro");
  } catch (e) { alert(`Falha: ${e.message}`); }
}

// F4: aba Agenda — proposições do painel na pauta de eventos futuros da Câmara.
function renderPainelAgenda(d) {
  const ag = d.agenda || [];
  if (!ag.length) return `<article class="news-card"><span class="source-meta">Agenda — na pauta</span><p>Nenhuma proposição do painel na pauta de eventos futuros. (Atualizada diariamente.)</p></article>`;
  const rows = ag.map((r) => {
    const ev = r.evento || {};
    const url = safeUrl(ev.url);
    const data = escapeHtml(String(ev.data_inicio || "").slice(0, 16).replace("T", " "));
    const titulo = escapeHtml(String(r.prop_titulo || r.proposicao_id));
    return `<tr>
      <td>${data}</td>
      <td>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${titulo}</a>` : titulo}</td>
      <td>${escapeHtml(ev.orgao_sigla || "—")}</td>
      <td>${escapeHtml(ev.tipo || "—")}</td>
      <td>${escapeHtml(String(r.situacao_item || r.topico || "—").slice(0, 40))}</td>
    </tr>`;
  }).join("");
  return `<article class="news-card">
    <span class="source-meta">Agenda — suas proposições na pauta (Câmara)</span>
    <strong>${ag.length} item(ns) na pauta de eventos futuros</strong>
    <div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Data</th><th>Proposição</th><th>Órgão</th><th>Evento</th><th>Situação</th></tr></thead><tbody>${rows}</tbody></table></div>
  </article>`;
}

function renderPainelDados(d) {
  const p = d.painel || {};
  const tram = (d.proposicoes || []).filter((x) => x.data && x.data.situacao).slice(0, 12);
  const freq = p.frequencia || "diario";
  return `<article class="news-card">
    <span class="source-meta">Dados Gerais</span>
    <div class="entity-row">
      <span class="entity-pill">${d.counts?.proposicoes || 0} proposições</span>
      <span class="entity-pill">${d.counts?.stakeholders || 0} stakeholders</span>
      <span class="entity-pill">${d.counts?.orgaos || 0} órgãos</span>
    </div>
    ${tram.length ? `<strong style="margin-top:10px;display:block">Últimas tramitações</strong>
      <div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Proposição</th><th>Situação</th></tr></thead><tbody>${tram.map((x) => `<tr><td>${escapeHtml(x.data.titulo || x.ref_id)}</td><td>${escapeHtml(x.data.situacao || "—")}</td></tr>`).join("")}</tbody></table></div>`
      : `<p>Sem tramitações. Importe proposições na aba Proposições.</p>`}
    <div style="margin-top:14px;border-top:1px solid var(--border);padding-top:10px">
      <strong style="display:block;margin-bottom:6px">Alertas &amp; relatório</strong>
      <div class="entity-row" style="flex-wrap:wrap;gap:6px">
        <input id="painel-owner-email" class="dou-date" type="email" placeholder="e-mail do responsável" value="${escapeHtml(p.owner_email || "")}" style="min-width:180px">
        <input id="painel-webhook" class="dou-date" type="url" placeholder="webhook (Slack/Teams)" value="${escapeHtml(p.webhook_url || "")}" style="min-width:180px">
        <select id="painel-frequencia" class="dou-date">${["diario", "tempo_real", "off"].map((f) => `<option value="${f}" ${freq === f ? "selected" : ""}>${f}</option>`).join("")}</select>
        <button type="button" class="alert-btn primary" data-painel-config-save="${escapeHtml(p.id || "")}">Salvar</button>
        <button type="button" class="entity-pill" data-painel-send="${escapeHtml(p.id || "")}">Enviar agora</button>
      </div>
      <span id="painel-config-status" style="font-size:.75rem;opacity:.6"></span>
    </div>
    <div style="margin-top:14px;border-top:1px solid var(--border);padding-top:10px">
      <strong style="display:block;margin-bottom:6px">Link do cliente (white-label, read-only)</strong>
      <div class="entity-row" style="flex-wrap:wrap;gap:6px">
        <button type="button" class="alert-btn primary" data-painel-share="${escapeHtml(p.id || "")}">${p.share_token ? "Rotacionar link" : "Gerar link do cliente"}</button>
        ${p.share_token ? `<button type="button" class="entity-pill" data-painel-unshare="${escapeHtml(p.id || "")}">Revogar</button>` : ""}
      </div>
      ${p.share_token ? `<div style="margin-top:6px"><input class="dou-date" style="width:100%" readonly onclick="this.select()" value="${escapeHtml(location.origin + "/cliente?p=" + p.share_token)}"></div>` : ""}
      <span id="painel-share-status" style="font-size:.75rem;opacity:.6"></span>
    </div>
  </article>`;
}

function renderPainelProposicoes(d) {
  const props = d.proposicoes || [];
  const PRIO = ["alta", "media", "baixa"], POS = ["favoravel", "neutro", "contrario"];
  const sel = (val, opts, attr, itemId) => `<select data-${attr}="${escapeHtml(itemId)}" class="dou-date">${opts.map((o) => `<option value="${o}" ${val === o ? "selected" : ""}>${o}</option>`).join("")}</select>`;
  const rows = props.map((x) => {
    const pr = x.data || {}; const url = safeUrl(pr.url);
    return `<tr>
      <td>${sel(x.prioridade, PRIO, "item-prio", x.item_id)}</td>
      <td>${sel(x.posicionamento, POS, "item-pos", x.item_id)}</td>
      <td>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(pr.titulo || x.ref_id)}</a>` : escapeHtml(pr.titulo || x.ref_id)}</td>
      <td>${escapeHtml(pr.situacao || "—")}</td>
      <td><button type="button" class="entity-pill" data-item-remove="${escapeHtml(x.item_id)}">×</button></td>
    </tr>`;
  }).join("");
  return `<article class="news-card">
    <div class="entity-row" style="justify-content:space-between">
      <span class="source-meta">Proposições monitoradas</span>
      <button type="button" class="alert-btn primary" id="painel-import-btn">Importar proposições</button>
    </div>
    <div id="painel-import-box" hidden style="margin:8px 0">
      <textarea id="painel-import-text" class="dou-date" style="width:100%;min-height:70px" placeholder="Cole a lista: PEC 42/2024, PL 11/2025"></textarea>
      <div class="entity-row"><button type="button" class="alert-btn primary" id="painel-import-resolve">Analisar</button><span id="painel-import-status" style="font-size:.75rem;opacity:.6"></span></div>
      <div id="painel-import-results"></div>
    </div>
    ${props.length ? `<div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Prioridade</th><th>Posição</th><th>Proposição</th><th>Situação</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<p>Nenhuma proposição. Clique em “Importar proposições”.</p>`}
  </article>`;
}

function renderPainelStakeholders(d) {
  const st = d.stakeholders || [];
  if (!st.length) return `<article class="news-card"><span class="source-meta">Stakeholders</span><p>Nenhum stakeholder no painel.</p></article>`;
  return `<article class="news-card"><span class="source-meta">Stakeholders</span>
    <div class="news-list">${st.map((x) => { const s = x.data || {}; return `<div class="director-row selectable" data-person-id="${escapeHtml(x.ref_id)}"><strong>${escapeHtml(s.full_name || x.ref_id)}</strong> <span class="card-sub">${escapeHtml(s.role || "")}${s.uf ? " · " + escapeHtml(s.uf) : ""}</span></div>`; }).join("")}</div>
  </article>`;
}

function renderPainelOrgaos(d) {
  const og = d.orgaos || [];
  if (!og.length) return `<article class="news-card"><span class="source-meta">Órgãos</span><p>Nenhum órgão no painel.</p></article>`;
  return `<article class="news-card"><span class="source-meta">Órgãos</span>
    <div class="entity-row">${og.map((x) => { const o = x.data || {}; return `<span class="entity-pill">${escapeHtml(o.acronym || x.ref_id)}${o.name ? " · " + escapeHtml(o.name) : ""}</span>`; }).join("")}</div>
  </article>`;
}

async function painelCreate() {
  const nome = window.prompt("Nome do painel (ex.: Energia, Segurança):");
  if (!nome || !nome.trim()) return;
  const cliente = window.prompt("Cliente (opcional):") || "";
  try {
    const r = await postJson("/api/intelligence?type=painel_save", { nome: nome.trim(), cliente: cliente.trim() });
    if (r?.ok && r.painel) { await loadPaineis(); openPainel(r.painel.id); }
  } catch (e) { alert(`Falha ao criar: ${e.message}`); }
}

async function painelImportResolve() {
  const text = $("#painel-import-text")?.value || "";
  const status = $("#painel-import-status"), results = $("#painel-import-results");
  if (status) status.textContent = "Analisando…";
  try {
    const r = await postJson("/api/intelligence?type=painel_import_resolve", { texto: text });
    const found = (r?.resolved || []).flatMap((x) => x.matched || []);
    state.painelImportFound = found;
    if (status) status.textContent = `${found.length} proposição(ões) encontrada(s).`;
    if (results) results.innerHTML = found.length
      ? `<div class="entity-row" style="flex-wrap:wrap;margin:6px 0">${found.map((f) => `<span class="entity-pill">${escapeHtml(f.titulo)} · ${escapeHtml(f.casa)}</span>`).join("")}</div><button type="button" class="alert-btn primary" data-import-confirm>Confirmar importação (${found.length})</button>`
      : `<p style="font-size:.78rem;opacity:.6">Nenhuma proposição reconhecida (use “PL 1234/2025”).</p>`;
  } catch (e) { if (status) status.textContent = `Falha: ${e.message}`; }
}

async function painelImportConfirm() {
  const found = state.painelImportFound || [];
  if (!found.length || !state.currentPainelId) return;
  try {
    const r = await postJson("/api/intelligence?type=painel_import_confirm", { painel_id: state.currentPainelId, items: found });
    if (r?.ok) { state.painelTab = "proposicoes"; openPainel(state.currentPainelId); }
  } catch (e) { alert(`Falha ao importar: ${e.message}`); }
}

// Curadoria inline: grava prioridade/posicionamento, SINCRONIZA o state (p/ a aba
// não reverter o select ao re-renderizar) e REVERTE + avisa se o POST falhar.
async function painelUpdateItem(selectEl, itemId, campo, valor) {
  const item = (state.painelData?.proposicoes || []).find((x) => String(x.item_id) === String(itemId));
  const prev = item ? item[campo] : undefined;
  try {
    const r = await postJson("/api/intelligence?type=painel_item_update", { id: itemId, [campo]: valor });
    if (!r?.ok) throw new Error(r?.error || "erro ao salvar");
    if (item) item[campo] = valor; // mantém state == banco
  } catch (err) {
    if (selectEl && prev !== undefined) selectEl.value = prev; // reverte o controle
    alert(`Não foi possível salvar: ${err.message}`);
  }
}

// F3: baixa um arquivo de texto (o relatório .md p/ levar ao Claude Design).
function downloadText(filename, content) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// F3: exporta o relatório do painel (Markdown) — arte final vai ao Claude Design.
async function exportPainelReport(id) {
  try {
    const r = await requestJson(`/api/intelligence?type=painel_report&id=${encodeURIComponent(id)}`);
    if (!r?.ok) throw new Error(r?.error || "erro");
    const slug = String(r.digest?.painel?.nome || "painel").normalize("NFD").replace(/[^\w]+/g, "-").toLowerCase().slice(0, 40);
    downloadText(`relatorio-${slug || "painel"}.md`, r.markdown || "");
  } catch (e) { alert(`Falha ao exportar: ${e.message}`); }
}

// F3: salva config de alerta (owner_email/webhook/frequencia). Reenvia nome/cliente/
// descricao p/ não zerar (painel_save grava a linha inteira no update).
async function painelConfigSave(id) {
  const p = state.painelData?.painel || {};
  const status = $("#painel-config-status");
  const body = {
    id, nome: p.nome, cliente: p.cliente, descricao: p.descricao, tema: p.tema,
    owner_email: ($("#painel-owner-email")?.value || "").trim() || null,
    webhook_url: ($("#painel-webhook")?.value || "").trim() || null,
    frequencia: $("#painel-frequencia")?.value || "diario"
  };
  if (status) status.textContent = "Salvando…";
  try {
    const r = await postJson("/api/intelligence?type=painel_save", body);
    if (!r?.ok) throw new Error(r?.error || "erro");
    if (state.painelData) state.painelData.painel = r.painel; // sincroniza o state
    if (status) status.textContent = "Configuração salva.";
  } catch (e) { if (status) status.textContent = `Falha: ${e.message}`; }
}

// F5: gera/rotaciona o link read-only do cliente (white-label).
async function painelShare(id) {
  const status = $("#painel-share-status");
  if (status) status.textContent = "Gerando…";
  try {
    const r = await postJson("/api/intelligence?type=painel_share", { id });
    if (!r?.ok || !r.token) throw new Error(r?.error || "erro");
    if (state.painelData?.painel) state.painelData.painel.share_token = r.token;
    renderPainelDetail(state.painelData);
  } catch (e) { if (status) status.textContent = `Falha: ${e.message}`; }
}

// F5: revoga o link do cliente.
async function painelUnshare(id) {
  if (!confirm("Revogar o link do cliente? O link atual deixará de funcionar.")) return;
  try {
    const r = await postJson("/api/intelligence?type=painel_unshare", { id });
    if (!r?.ok) throw new Error(r?.error || "erro");
    if (state.painelData?.painel) state.painelData.painel.share_token = null;
    renderPainelDetail(state.painelData);
  } catch (e) { alert(`Falha: ${e.message}`); }
}

// F3: dispara o envio do relatório AGORA (testa webhook + e-mail).
async function painelSendReport(id) {
  const status = $("#painel-config-status");
  if (status) status.textContent = "Enviando…";
  try {
    const r = await postJson("/api/intelligence?type=painel_send_report", { id });
    if (!r?.ok) throw new Error(r?.error || "erro");
    const fmt = (x) => (x?.ok ? "ok" : (x?.skipped || x?.error || "falha"));
    if (status) status.textContent = `Enviado — webhook: ${fmt(r.delivered?.webhook)} · e-mail: ${fmt(r.delivered?.email)}`;
  } catch (e) { if (status) status.textContent = `Falha: ${e.message}`; }
}

function wirePaineis() {
  if (painelWired) return; painelWired = true;
  const view = $("#view-paineis");
  if (!view) return;
  $("#painel-create")?.addEventListener("click", painelCreate);
  view.addEventListener("click", async (e) => {
    const del = e.target.closest("[data-painel-del]");
    if (del) { e.stopPropagation(); if (confirm("Excluir este painel?")) { await postJson("/api/intelligence?type=painel_delete", { id: del.dataset.painelDel }).catch(() => {}); loadPaineis(); } return; }
    const open = e.target.closest("[data-open-painel]");
    if (open) { openPainel(open.dataset.openPainel); return; }
    const back = e.target.closest("[data-painel-back]");
    if (back) { loadPaineis(); return; }
    const tab = e.target.closest("[data-painel-tab]");
    if (tab) { state.painelTab = tab.dataset.painelTab; renderPainelDetail(state.painelData); return; }
    const rem = e.target.closest("[data-item-remove]");
    if (rem) { await postJson("/api/intelligence?type=painel_item_remove", { id: rem.dataset.itemRemove }).catch(() => {}); openPainel(state.currentPainelId); return; }
    const person = e.target.closest("[data-person-id]");
    if (person) { suppressDirectorsAutoload = true; document.querySelector("[data-view='directors']")?.click(); openDirectorDossier(person.dataset.personId); return; }
    const report = e.target.closest("[data-painel-report]");
    if (report) { exportPainelReport(report.dataset.painelReport); return; }
    const cfg = e.target.closest("[data-painel-config-save]");
    if (cfg) { painelConfigSave(cfg.dataset.painelConfigSave); return; }
    const send = e.target.closest("[data-painel-send]");
    if (send) { painelSendReport(send.dataset.painelSend); return; }
    const share = e.target.closest("[data-painel-share]");
    if (share) { painelShare(share.dataset.painelShare); return; }
    const unshare = e.target.closest("[data-painel-unshare]");
    if (unshare) { painelUnshare(unshare.dataset.painelUnshare); return; }
    if (e.target.closest("#painel-news-search")) { painelNewsSearch(); return; }
    if (e.target.closest("#painel-news-manual")) { painelNewsManual(); return; }
    const newsAdd = e.target.closest("[data-news-add]");
    if (newsAdd) { painelNewsAdd(newsAdd.dataset.newsAdd); return; }
    const noticiaRem = e.target.closest("[data-noticia-remove]");
    if (noticiaRem) { postJson("/api/intelligence?type=painel_noticia_remove", { id: noticiaRem.dataset.noticiaRemove }).then(() => openPainel(state.currentPainelId)).catch(() => {}); return; }
    if (e.target.closest("#painel-import-btn")) { const box = $("#painel-import-box"); if (box) box.hidden = !box.hidden; return; }
    if (e.target.closest("#painel-import-resolve")) { painelImportResolve(); return; }
    if (e.target.closest("[data-import-confirm]")) { painelImportConfirm(); return; }
  });
  view.addEventListener("change", (e) => {
    const prio = e.target.closest("[data-item-prio]");
    if (prio) { painelUpdateItem(prio, prio.dataset.itemPrio, "prioridade", prio.value); return; }
    const pos = e.target.closest("[data-item-pos]");
    if (pos) { painelUpdateItem(pos, pos.dataset.itemPos, "posicionamento", pos.value); }
  });
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

  // Quatro motores em paralelo; cada painel degrada sozinho.
  // F-INT1: riscos vêm de type=giratoria (a detecção forte, com contratos e severity
  // critical) — antes usavam radar_intel.computeRisks (fraca: "tem CNPJ" = risco).
  const [radarRes, giraRes, corrRes, anomRes] = await Promise.allSettled([
    requestJson("/api/intelligence?type=radar_intel"),
    requestJson("/api/intelligence?type=giratoria"),
    requestJson("/api/intelligence?type=correlations"),
    requestJson("/api/intelligence?type=trends_anomalies")
  ]);

  if (giraRes.status === "fulfilled") {
    const cases = giraRes.value.cases || [];
    renderRadarRisks(cases.slice(0, 20));
    const rc = $("#radar-risk-count");
    if (rc) { rc.hidden = !cases.length; rc.textContent = cases.length > 20 ? `20 de ${cases.length}` : String(cases.length); }
  } else if (risksEl) {
    risksEl.innerHTML = emptyCard("Riscos", `Falha: ${escapeHtml(giraRes.reason?.message || "erro")}. Verifique ingestões/migração.`);
  }

  if (radarRes.status === "fulfilled") {
    const r = radarRes.value;
    renderRadarOpportunities(r.opportunities || []);
    renderRadarLegislative(r.legislative || []);
    const oc = $("#radar-opp-count");
    const oppN = (r.opportunities || []).length;
    if (oc) { oc.hidden = !oppN; oc.textContent = String(oppN); }
  } else {
    if (oppEl) oppEl.innerHTML = emptyCard("Oportunidades", `Falha: ${escapeHtml(radarRes.reason?.message || "erro")}`);
  }

  if (corrEl) {
    if (corrRes.status === "fulfilled") {
      renderRadarCorrelations(corrRes.value.correlations || []);
      const cc = $("#radar-corr-count");
      const corrN = (corrRes.value.correlations || []).length;
      if (cc) { cc.hidden = !corrN; cc.textContent = corrN > 20 ? `20 de ${corrRes.value.total || corrN}` : String(corrN); }
    } else corrEl.innerHTML = emptyCard("Conexões", `Falha: ${escapeHtml(corrRes.reason?.message || "erro")}`);
  }

  if (anomEl) {
    if (anomRes.status === "fulfilled") {
      renderRadarAnomalies(anomRes.value.anomalies || []);
      const ac = $("#radar-anom-count");
      const anomN = (anomRes.value.anomalies || []).length;
      if (ac) { ac.hidden = !anomN; ac.textContent = anomN > 15 ? `15 de ${anomN}` : String(anomN); }
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
    suppressDirectorsAutoload = true; // mesma corrida do card de riscos
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

// F-INT1: o painel de riscos passou a consumir type=giratoria — a detecção FORTE
// (cruza sócio × contratos; severity critical p/ self-dealing, com timing do contrato).
// Antes usava radar_intel.computeRisks, que marcava "porta giratória" p/ qualquer sócio de MEI.
const GIRA_SEV = { critical: ["CRÍTICO", "var(--red)", "high"], high: ["ALTO", "var(--red)", "high"], medium: ["MÉDIO", "var(--yellow)", "mid"] };
function renderRadarRisks(items) {
  const el = $("#radar-risks");
  if (!items.length) { el.innerHTML = emptyCard("Riscos", "Nenhum risco de captura detectado (ou faltam dados de mandatos/sócios/contratos)."); return; }
  el.innerHTML = items.map((x) => {
    const [lbl, cor, cls] = GIRA_SEV[x.severity] || GIRA_SEV.medium;
    return `
    <article class="news-card target-card ${x.person_id ? "selectable" : ""}" ${x.person_id ? `data-open-person="${escapeHtml(x.person_id)}"` : ""}>
      <div class="card-body">
        <div class="card-head">
          ${TARGET_ICO}
          <div><strong>${escapeHtml(x.name || "?")}</strong><span class="card-sub">${escapeHtml(x.agency || "")}${x.role ? " · " + escapeHtml(x.role) : ""}${x.active === false ? " · mandato encerrado" : ""}</span></div>
          <span class="card-prio">${lbl}</span>
        </div>
        <p class="card-sub">${escapeHtml(x.rationale || "")}</p>
        <div class="entity-row" style="flex-wrap:wrap">
          <span class="entity-pill score-${cls}">${(x.companies || []).length} empresa(s)</span>
          ${(x.self_dealing || []).length ? `<span class="entity-pill score-high">${x.self_dealing.length} fornece à própria agência</span>` : ""}
          ${x.contract_during_mandate ? `<span class="entity-pill score-high">contrato durante o mandato</span>` : ""}
          ${(x.public_supplier || []).length ? `<span class="entity-pill">${x.public_supplier.length} fornecedor(es) público(s)</span>` : ""}
        </div>
      </div>
      ${cardFoot(cor, x.severity === "critical" ? "self-dealing" : "porta giratória", "LINCE//RISCO")}
    </article>`;
  }).join("");
  el.querySelectorAll("[data-open-person]").forEach((card) => card.addEventListener("click", () => {
    suppressDirectorsAutoload = true; // evita loadDirectors() sobrescrever o dossie (corrida documentada)
    setView("directors");
    openDirectorDossier(card.dataset.openPerson);
  }));
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
    // F-INT1: CNPJ/CPF digitado vira cpf_cnpj (antes o padrão normalizado "12 345 678..."
    // jamais casava com o texto do DOU — monitor por CNPJ era decorativo).
    const digits = onlyDigits(pattern);
    const cpfCnpj = (digits.length === 11 || digits.length === 14) ? digits : null;
    const saved = await postJson("/api/intelligence?type=monitor_save", {
      kind,
      label: label || pattern,
      pattern,
      ...(cpfCnpj ? { cpf_cnpj: cpfCnpj } : {}),
      active: $("#mon-active")?.checked ?? true
    });
    // F-INT1 (F4): o backfill de 90d roda no save — mostra o resultado (ou a falha).
    const bfMsg = saved?.backfill_error
      ? `Monitor criado, mas o backfill falhou: ${saved.backfill_error}`
      : (saved?.backfill_hits ? `✓ Monitor criado — ${saved.backfill_hits} ocorrência(s) encontradas nos últimos 90 dias.` : null);
    if (bfMsg) $("#monitors-list")?.insertAdjacentHTML("afterbegin", `<div class="activity-alert${saved?.backfill_error ? "" : " info"}"><span class="alert-icon">${saved?.backfill_error ? "⚠" : "✓"}</span><span style="font-size:.78rem">${escapeHtml(bfMsg)}</span></div>`);
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
  if ((d.propositions || []).length) {
    sections.push({
      heading: `Proposições de autoria (${d.propositions.length})`,
      html: printItemsTable(d.propositions.slice(0, 40).map((p) => item(
        p.titulo || `${p.tipo || ""} ${p.numero || ""}/${p.ano || ""}`,
        [p.casa, p.situacao].filter(Boolean).join(" — ") || "—",
        "Câmara/Senado · Dados Abertos"
      )))
    });
  }
  if ((d.legislative_votes || []).length) {
    sections.push({
      heading: `Votação nominal — Congresso (${d.legislative_votes.length})`,
      html: printItemsTable(d.legislative_votes.slice(0, 40).map((v) => item(
        `${String(v.data_votacao || "").slice(0, 10)} · ${v.voto || "—"}${v.divergente ? " (infiel)" : ""}`,
        String(v.proposicao_titulo || v.descricao || "—").slice(0, 100),
        "Câmara · Dados Abertos"
      )))
    });
  }
  if ((d.comissoes || []).length) {
    sections.push({
      heading: `Comissões e órgãos (${d.comissoes.length})`,
      html: printItemsTable(d.comissoes.map((c) => item(
        c.sigla || "—", String(c.nome || "").slice(0, 100), c.cargo || "membro"
      )))
    });
  }
  if ((d.financiadores?.count || 0)) {
    sections.push({
      heading: `Financiadores de campanha — ${money(d.financiadores.total)}`,
      html: printItemsTable((d.financiadores.top || []).map((x) => item(
        x.donor_name || "—",
        `${money(x.total)}${x.donor_type ? " · " + x.donor_type : ""}${x.donor_document ? " · " + x.donor_document : ""}`,
        "TSE · prestação de contas"
      )))
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
      suppressDirectorsAutoload = true; // corrida lista×dossie (F-INT1)
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
  panoramic: false,
  aggregate: false
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

// ─── Votação do Colegiado (M19) — métricas dos votos dos diretores ──────────
let _votAgLoaded = false, _votacaoWired = false;

async function populateVotacaoAgencies() {
  if (_votAgLoaded) return;
  const sel = $("#votacao-agency"); if (!sel) return;
  try {
    const sc = await requestJson("/api/intelligence?type=score");
    sel.innerHTML = `<option value="">Todas as agências</option>` +
      (sc.scores || []).map((s) => `<option value="${escapeHtml(s.agency)}">${escapeHtml(s.agency)}</option>`).join("");
    _votAgLoaded = true;
  } catch { /* silencioso */ }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function wireVotacao() {
  $("#votacao-refresh")?.addEventListener("click", () => loadVotacao());
  $("#votacao-agency")?.addEventListener("change", () => loadVotacao());
  const up = $("#votacao-upload");
  if (up) up.addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0]; if (!file) return;
    const agency = $("#votacao-agency")?.value?.trim();
    const msg = $("#votacao-upload-msg");
    if (!agency) { if (msg) msg.textContent = "Selecione a agência antes de enviar o PDF."; up.value = ""; return; }
    if (msg) msg.textContent = `Enviando ${file.name}…`;
    try {
      const b64 = await fileToBase64(file);
      const r = await postJson("/api/intelligence?type=upload_deliberacao", { pdf_base64: b64, agency, filename: file.name });
      if (r.ok) { if (msg) msg.textContent = `OK: deliberação ${escapeHtml(String(r.numero))} · ${r.votos} voto(s) (${r.nominais} nominais)`; loadVotacao(); }
      else if (msg) msg.textContent = `Falha: ${escapeHtml(r.error || "erro")}`;
    } catch (err) { if (msg) msg.textContent = `Falha: ${escapeHtml(err.message)}`; }
    up.value = "";
  });
}

function bar(pct, color) {
  const w = Math.max(0, Math.min(100, Number(pct) || 0));
  return `<div class="vt-bar"><div class="vt-bar-fill" style="width:${w}%; background:${color}"></div></div>`;
}

function renderVotOverview(d) {
  const el = $("#votacao-overview"); if (!el) return;
  if (!d) { el.innerHTML = ""; return; }
  const cell = (label, val) => `<div class="dh-cell"><span class="dh-num">${escapeHtml(String(val))}</span><span class="card-sub">${escapeHtml(label)}</span></div>`;
  el.innerHTML =
    cell("Deliberações", d.total_deliberacoes ?? 0) +
    cell("Deferidas", d.deferidos ?? 0) +
    cell("Indeferidas", d.indeferidos ?? 0) +
    cell("Taxa de deferimento", `${d.taxa_deferimento ?? 0}%`) +
    cell("Reuniões", d.reunioes_unicas ?? 0) +
    cell("Top microtema", d.top_microtema || "—");
}

function renderVotDistribution(rows) {
  const el = $("#votacao-distribution"); if (!el) return;
  if (!rows || !rows.length) { el.innerHTML = `<p class="card-sub">Sem votos.</p>`; return; }
  const COLOR = { Favoravel: "var(--green,#3fb950)", Desfavoravel: "var(--red,#f85149)", Abstencao: "var(--amber,#d29922)", Ausente: "var(--muted,#8b949e)" };
  el.innerHTML = rows.map((r) =>
    `<div class="vt-row"><span class="vt-lbl">${escapeHtml(r.tipo_voto)}</span>${bar(r.pct, COLOR[r.tipo_voto] || "var(--blue)")}<span class="vt-val">${r.count} · ${escapeHtml(String(r.pct))}%</span></div>`
  ).join("");
}

function renderVotConsenso(rows) {
  const el = $("#votacao-consenso"); if (!el) return;
  if (!rows || !rows.length) { el.innerHTML = `<p class="card-sub">Sem série.</p>`; return; }
  el.innerHTML = rows.map((r) =>
    `<div class="vt-row"><span class="vt-lbl">${escapeHtml(r.period)}</span>${bar(r.pct_consenso, "var(--blue)")}<span class="vt-val">${escapeHtml(String(r.pct_consenso))}% · ${r.total_itens} itens</span></div>`
  ).join("");
}

function renderVotMatrix(rows) {
  const el = $("#votacao-matrix"); if (!el) return;
  if (!rows || !rows.length) { el.innerHTML = `<p class="card-sub">Sem votos.</p>`; return; }
  const th = `<tr><th>Diretor</th><th>Total</th><th>Favor</th><th>Contra</th><th>Abst.</th><th>Diverg.</th></tr>`;
  const body = rows.map((r) =>
    `<tr><td>${escapeHtml(r.diretor_nome || r.diretor_id)}</td><td>${r.total ?? 0}</td><td>${r.favoravel ?? 0}</td><td>${r.desfavoravel ?? 0}</td><td>${r.abstencao ?? 0}</td><td>${r.divergente ?? 0}</td></tr>`
  ).join("");
  el.innerHTML = `<table class="vt-table"><thead>${th}</thead><tbody>${body}</tbody></table>`;
}

function renderVotFidelidade(rows) {
  const el = $("#votacao-fidelidade"); if (!el) return;
  if (!rows || !rows.length) { el.innerHTML = `<p class="card-sub">Sem votos.</p>`; return; }
  const th = `<tr><th>Diretor</th><th>Votos</th><th>Nominais</th><th>Divergentes</th><th>Fidelidade</th></tr>`;
  const body = rows.map((r) =>
    `<tr><td>${escapeHtml(r.diretor_nome || r.diretor_id)}</td><td>${r.total_votos ?? 0}</td><td>${r.votos_nominais ?? 0}</td><td>${r.votos_divergentes ?? 0}</td><td>${escapeHtml(String(r.taxa_fidelidade ?? 0))}%</td></tr>`
  ).join("");
  el.innerHTML = `<table class="vt-table"><thead>${th}</thead><tbody>${body}</tbody></table>`;
}

async function loadVotacao() {
  populateVotacaoAgencies();
  if (!_votacaoWired) { wireVotacao(); _votacaoWired = true; }
  const agency = $("#votacao-agency")?.value?.trim() || "";
  const q = agency ? `&agency=${encodeURIComponent(agency)}` : "";
  const url = (t) => `/api/intelligence?type=${t}${q}`;
  const [ov, dist, matrix, fid, cons] = await Promise.all([
    requestJson(url("votos_overview")).catch(() => null),
    requestJson(url("votos_distribution")).catch(() => null),
    requestJson(url("votos_matrix")).catch(() => null),
    requestJson(url("votos_fidelidade")).catch(() => null),
    requestJson(url("votos_consenso")).catch(() => null),
  ]);
  const total = ov?.data?.total_deliberacoes || 0;
  $("#votacao-empty")?.toggleAttribute("hidden", total > 0);
  renderVotOverview(ov?.data);
  renderVotDistribution(dist?.data);
  renderVotConsenso(cons?.data);
  renderVotMatrix(matrix?.data);
  renderVotFidelidade(fid?.data);
}

async function loadNationalGraph() {
  await populateGraphAgencies();
  const agency = $("#graph-agency")?.value?.trim();
  // Panorama agregado (super-nos por agencia) so sem filtro de agencia.
  const aggregate = natGraph.aggregate && !agency;
  // limit=1000 (teto do PostgREST) p/ maior amostra; alem disso, o duplo-clique
  // num no busca a rede real dele no backend (sem esse teto).
  const url = aggregate
    ? "/api/graph?mode=aggregate"
    : `/api/graph${agency ? `?agency=${encodeURIComponent(agency)}&limit=1000` : "?limit=1000"}`;
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
    const trunc = aggregate
      ? ` · panorama agregado (${g.meta?.cross_agency_suppliers ?? 0} fornecedores transversais)`
      : (g.meta?.truncated ? ` · amostra de ${g.meta.limit} (refine por agência ou dê 2 cliques num nó)` : "");
    // F-INT1: camada que falhou na leitura não some mais em silêncio.
    // (modo agregado manda partial como BOOLEAN; panorâmico como array de camadas)
    const partialList = Array.isArray(g.meta?.partial) ? g.meta.partial : (g.meta?.partial ? ["contratos"] : []);
    const partial = partialList.length ? ` · ⚠ fontes indisponíveis: ${partialList.join(", ")}` : "";
    $("#nat-graph-title").textContent = `${natGraph.nodes.length} entidades · ${natGraph.edges.length} vínculos${trunc}${partial}`;
    natGraph.graphView?.fit();
  } catch (error) {
    const empty = $("#nat-graph-empty");
    if (empty) { empty.classList.remove("hidden"); empty.querySelector("p").textContent = `Falha: ${error.message}`; }
  }
}

// Mescla a rede (nodes/edges) de uma expansao no dataset acumulado. ATUALIZA nos
// ja existentes com a versao nova (ex.: um super-no agregado "N contratos" vira a
// sigla real ao dar drill-in) — manter o primeiro deixaria o rotulo stale.
function mergeNatNetwork(g) {
  if (!g || !Array.isArray(g.nodes)) return;
  const idx = new Map(natGraph.allNodes.map((n, i) => [n.id, i]));
  for (const n of g.nodes) {
    if (!n) continue;
    if (idx.has(n.id)) natGraph.allNodes[idx.get(n.id)] = n;
    else { idx.set(n.id, natGraph.allNodes.length); natGraph.allNodes.push(n); }
  }
  const ek = (e) => `${e.from}->${e.to}:${e.relationship}`;
  const haveE = new Set(natGraph.allEdges.map(ek));
  for (const e of g.edges || []) if (e && !haveE.has(ek(e))) { natGraph.allEdges.push(e); haveE.add(ek(e)); }
}

// Expande um no: busca a rede REAL desse no no backend (nao limitada pela amostra
// panoramica de 800) e mescla — assim da p/ navegar por entidade ate a rede
// inteira: decisor -> agencia -> fornecedor -> socios -> socios-dos-socios.
async function expandNatNode(nodeId) {
  if (!nodeId) return;
  const [kind] = nodeId.split(":");
  let g;
  try {
    // ?node=<kind:id> devolve os vinculos diretos do no (relationships + derivados).
    g = await requestJson(`/api/graph?node=${encodeURIComponent(nodeId)}&limit=400`);
  } catch (e) {
    // NAO drillar num grafo vazio em silencio: avisa e mantem o estado atual.
    $("#nat-graph-title").textContent = `Falha ao expandir o nó: ${e.message}`;
    return;
  }
  mergeNatNetwork(g);
  // Para pessoa/empresa, tambem puxa a CADEIA societaria multi-nivel (socios de
  // socios, holdings) num clique — nao so 1 hop. Best-effort (nao quebra se falhar).
  if (kind === "person" || kind === "company") {
    const chain = await requestJson(`/api/graph?node=${encodeURIComponent(nodeId)}&expand=socio&depth=2&limit=400`).catch(() => null);
    if (chain) mergeNatNetwork(chain);
  }
  if (natGraph.panoramic) {
    // Primeiro duplo-clique a partir do panorama: entra no modo focado nesse no.
    natGraph.panoramic = false;
    natGraph.centerId = nodeId;
    natGraph.expanded = new Set([nodeId]);
  } else {
    natGraph.expanded.add(nodeId);
  }
  rebuildNatVisible();
  natGraph.graphView?.fit();
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
  $("#graph-agency")?.addEventListener("change", () => {
    // Escolher uma agencia sai do modo agregado (panorama e so a visao geral).
    if ($("#graph-agency").value) natGraph.aggregate = false;
    $("#nat-aggregate")?.classList.toggle("active", natGraph.aggregate);
    loadNationalGraph();
  });
  $("#nat-aggregate")?.addEventListener("click", () => {
    natGraph.aggregate = !natGraph.aggregate;
    $("#nat-aggregate")?.classList.toggle("active", natGraph.aggregate);
    if (natGraph.aggregate && $("#graph-agency")) $("#graph-agency").value = "";
    loadNationalGraph();
  });
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
                <span class="card-sub">${s.docs_90d ?? s.docs} atos (90d) · ${s.open_alerts} alertas abertos · ${s.active_directors} diretores ativos</span>
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
      if (!all.length) { radar.innerHTML = emptyCard("Radar", "Nenhum contrato ou fim de mandato nos proximos 90 dias. (Contratos dependem do ingest-pncp.)"); }
      else radar.innerHTML = all.map((c) => {
        // F-INT1: contrato e mandato sao eventos diferentes — cards distintos (antes o
        // mandato dizia "Fornecedor nao identificado" e rodape PNCP//).
        const isMandato = c.type === "mandato";
        const sub = isMandato ? `<p class="card-sub">Sucessão de dirigente — fim de mandato</p>`
          : `<p>${escapeHtml(c.supplier || "Fornecedor nao identificado")}${c.value != null ? ` · ${money(c.value)}` : ""}</p>`;
        return `
        <article class="news-card target-card">
          <div class="card-body">
            <div class="card-head">
              <div>
                <strong>${escapeHtml(c.label)}</strong>
                <span class="card-sub">Vence: ${escapeHtml(c.date || "sem data")}</span>
              </div>
              <span class="card-prio">${escapeHtml(c.window)}</span>
            </div>
            ${sub}
          </div>
          ${cardFoot(c.window === "30d" ? "var(--red)" : c.window === "60d" ? "var(--yellow)" : "var(--green)", `${isMandato ? "Mandato" : "Contrato"} ${c.window}`, `${isMandato ? "DOU" : "PNCP"}//${c.agency || "BR"}`)}
        </article>`;
      }).join("");
      if (rd.truncated && (rd.truncated.contratos || rd.truncated.mandatos)) {
        radar.innerHTML += `<p class="card-sub" style="opacity:.7">⚠ Lista truncada em 500 itens por fonte — os mais distantes podem não aparecer.</p>`;
      }
    }
    // Overview daily
    const dailyEl = $("#overview-daily");
    if (dailyEl && daily.by_agency) {
      const entries = Object.entries(daily.by_agency);
      if (!entries.length) { dailyEl.innerHTML = emptyCard("Diario", "Nenhum ato nas ultimas 24h. O cron roda ao meio-dia UTC."); }
      else {
        dailyEl.innerHTML = entries.map(([ac, d]) => `
        <article class="news-card">
          <span class="source-meta">${escapeHtml(ac)} | ${d.normas} normas · ${d.pessoal} atos pessoal · ${d.contratos} contratos</span>
          ${(d.destaques || []).slice(0, 2).map((s) => `<p>${escapeHtml(s)}</p>`).join("")}
        </article>`).join("");
        if (daily.truncated) dailyEl.innerHTML += `<p class="card-sub" style="opacity:.7">⚠ Amostra truncada — as contagens acima são parciais.</p>`;
      }
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
    // F-INT1: sinaliza quando o resultado veio do FALLBACK (títulos do DOU, não os feeds RSS).
    const fonteAviso = /fallback/i.test(String(data.source || "")) ? `<p class="card-sub" style="opacity:.75">⚠ Feeds RSS indisponíveis — mostrando menções no DOU (fallback), não necessariamente consultas abertas.</p>` : "";
    list.innerHTML = fonteAviso + data.items.map((c) => `
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
            ${safeUrl(c.link) ? `<a class="entity-pill" href="${escapeHtml(safeUrl(c.link))}" target="_blank" rel="noreferrer">Abrir</a>` : ""}
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
    const fonteAviso = /fallback/i.test(String(data.source || "")) ? `<p class="card-sub" style="opacity:.75">⚠ Feeds RSS indisponíveis — mostrando menções no DOU (fallback).</p>` : "";
    list.innerHTML = fonteAviso + data.items.map((c) => `
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
            ${safeUrl(c.link) ? `<a class="entity-pill" href="${escapeHtml(safeUrl(c.link))}" target="_blank" rel="noreferrer">Abrir</a>` : ""}
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

// E3 — "CNPJs de teste": fornecedores REAIS na base (contratam com >=2 agências
// reguladoras => dado rico). Responde ao item 5 ("quais CNPJs posso testar?").
// Itaipu nunca aparece (binacional, fora do escopo ingerido).
async function showTestCnpjs() {
  setView("investigate");
  $("#inspector-title").textContent = "CNPJs de teste";
  $("#inspector-body").innerHTML = `<article class="detail-card"><p>Carregando fornecedores reais da base…</p></article>`;
  try {
    const g = await requestJson("/api/graph?mode=aggregate");
    const comps = (g?.nodes || [])
      .filter((n) => n.type === "company" && onlyDigits(n.cnpj || "").length === 14)
      .sort((a, b) => (b.weight || 0) - (a.weight || 0))
      .slice(0, 15);
    if (!comps.length) {
      $("#inspector-body").innerHTML = `<article class="detail-card"><p>Nenhum fornecedor transversal com CNPJ na base ainda. Rode a ingestão do PNCP (<code>ingest:pncp</code>) para popular contratos.</p></article>`;
      return;
    }
    const rows = comps.map((c) => {
      const situ = String(c.meta?.situacao || "").trim();
      const inactive = isInactiveStatus(situ);
      return `<button type="button" class="test-cnpj-row" data-test-cnpj="${escapeHtml(onlyDigits(c.cnpj))}">
        <strong>${escapeHtml(c.title || "Empresa")}</strong>
        <span>${escapeHtml(formatCnpj(c.cnpj))} · ${escapeHtml(String(c.subtitle || ""))}${situ ? " · " + (inactive ? "⛔ " : "") + escapeHtml(situ) : ""}</span>
      </button>`;
    }).join("");
    $("#inspector-body").innerHTML = `<article class="detail-card">
      <p style="margin:0 0 8px">Fornecedores que contratam com ≥2 agências reguladoras (dado rico p/ testar). Clique para investigar. <em>Itaipu não aparece: é binacional e fora do escopo ingerido.</em></p>
      <div class="test-cnpj-list">${rows}</div>
    </article>`;
  } catch (e) {
    $("#inspector-body").innerHTML = `<article class="detail-card"><p>Falha ao carregar CNPJs de teste: ${escapeHtml(e.message)}</p></article>`;
  }
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
  $("#test-cnpjs")?.addEventListener("click", showTestCnpjs);
  $("#center-graph").addEventListener("click", centerGraph);
  // Clique num CNPJ de teste -> preenche a busca e investiga.
  $("#inspector-body")?.addEventListener("click", (event) => {
    const row = event.target.closest("[data-test-cnpj]");
    if (!row) return;
    const cnpj = row.dataset.testCnpj;
    const input = $("#global-search"); if (input) input.value = formatCnpj(cnpj);
    runSearch(cnpj);
  });
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
  // M20: clique no AUTOR de uma proposição (parlamentar) abre o dossiê investigativo.
  // Suprime o autoload da lista de diretores p/ não sobrescrever o dossiê (race).
  $("#legislativo-list")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-person-id]");
    if (!btn) return;
    suppressDirectorsAutoload = true;
    document.querySelector("[data-view='directors']")?.click();
    openDirectorDossier(btn.dataset.personId);
  });
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
    if (ds) ds.textContent = "Disparando ingestão do DOU (últimos dias)… (pode levar até 1 min)";
    try {
      // days=3: cobre buracos de fim de semana/feriado sem depender do CLI.
      const r = await postJson("/api/intelligence?type=refresh&days=3", {});
      if (ds) {
        if (r?.ok) {
          const warn = (r.warnings || []).length ? ` (${r.warnings.length} dia(s) anterior(es) com falha — use o CLI backfill:dou)` : "";
          ds.textContent = `Ingestão concluída (${(r.dates || []).length} dia(s)): ${r.inserted ?? 0} novo(s) ato(s).${warn}`;
        } else {
          ds.textContent = `Falha na ingestão: ${r?.error || "erro"}`;
        }
      }
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
      <td>${safeUrl(it.link) ? `<a href="${escapeHtml(safeUrl(it.link))}" target="_blank" rel="noreferrer" style="color:inherit">${escapeHtml(it.title)}</a>` : escapeHtml(it.title)}</td>
      <td>${escapeHtml(it.date || "")}</td>
      <td>${conf(it.confidence)}</td>
    </tr>`).join("");
}

async function loadTrend(days = 30) {
  const trend = await requestJson(`/api/intelligence?type=trend&days=${days}`).catch(() => null);
  if (trend?.series) { renderTrendChart(trend.series); renderSparkline(trend.series); }
  const docEl = $("#metric-docs");
  if (docEl && trend) docEl.textContent = `${trend.total}${trend.truncated ? "+" : ""}`; // F-INT1: janela truncada visivel
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
    // F-INT1 (F4): frescor POR FONTE — o que envelhece em silêncio agora aparece.
    // erro de leitura ≠ "nunca rodou" (diagnósticos diferentes).
    const freshRows = (d.freshness || []).map((f) => `<li style="display:flex;justify-content:space-between;gap:8px;padding:2px 0;font-size:.78rem">
      <span>${f.stale ? "🔴" : "🟢"} ${escapeHtml(f.source)}</span>
      <span style="opacity:.7">${f.error ? "⚠ erro na leitura" : (f.last ? `${escapeHtml(String(f.last).slice(0, 10))} · ${f.days_stale}d` : "nunca rodou")}</span>
    </li>`).join("");
    const freshBlock = freshRows ? `<div style="margin-top:8px"><strong style="font-size:.8rem">Frescor por fonte</strong><ul style="list-style:none;margin:4px 0 0;padding:0">${freshRows}</ul></div>` : "";
    gapsEl.innerHTML = ((d.gaps || []).length
      ? `<ul class="dh-gap-list">${d.gaps.map((g) => `<li>⚠ ${escapeHtml(g)}</li>`).join("")}</ul>`
      : `<p class="dh-ok">✓ Sem lacunas críticas.</p>`) + freshBlock;
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
      if (entries.length && daily.truncated) dailyEl.innerHTML += `<p class="card-sub" style="opacity:.7">⚠ Amostra truncada — contagens parciais.</p>`; // F-INT1
    }
    const contracts = await requestJson("/api/intelligence?type=radar").catch(() => null);
    if (contracts) {
      // So contratos vencendo 90d (o radar tambem traz fim de mandato -> nao contar aqui).
      const buckets = [contracts.radar?.["30d"], contracts.radar?.["60d"], contracts.radar?.["90d"]];
      const total = buckets.reduce((s, arr) => s + (arr || []).filter((e) => e.type === "contrato").length, 0);
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
  _userEmail = user?.email || null;
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
  // #login-signup foi removido do HTML (acesso restrito); optional chaining evita
  // null-deref que travaria o login inteiro.
  const setBusy = (b) => { $("#login-submit").disabled = b; const s = $("#login-signup"); if (s) s.disabled = b; };
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

  // Cadastro pela página foi removido (acesso restrito, usuário único). O handler
  // fica guardado caso o botão seja reintroduzido, mas não quebra sem ele.
  const signupBtn = $("#login-signup");
  if (signupBtn) signupBtn.addEventListener("click", async () => {
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
