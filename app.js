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
  sources: {},
  graphView: null,
  transform: { x: 80, y: 60, scale: 1 },
  drag: null,
  pan: null
};

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
  delibera: { color: "#2ea89d", style: "solid" }, afeta: { color: "#2ea89d", style: "dotted" }
};
const relColor = (r) => (REL_META[r] || { color: "#4a545c" }).color;
const relStyle = (r) => (REL_META[r] || { style: "solid" }).style;

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
    els.push({ data: { id: n.id, label: n.title || n.id, sub: n.subtitle || "", type: n.type, color: nodeColor(n.type), size: n.central ? 30 : 20 }, classes: n.central ? "central" : "" });
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
    return requestJson(`/api/cnpj?cnpj=${onlyDigits(cnpj)}`);
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
  const response = await fetch(url);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
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
    agenda: ["Calendario regulatorio (M8)", "Agenda e Pautas"]
  };
  const [kicker, title] = titles[view] || ["LINCE", view];
  if (view === "dou") loadDouFeed();
  if (view === "directors") loadDirectors();
  if (view === "graph") loadNationalGraph();
  if (view === "intelligence") loadIntelligence();
  if (view === "consultas") loadConsultas();
  if (view === "agenda") loadAgenda();
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
    realDataProvider.fetchTransparency(cnpj)
  ]);

  const cnpjResult = unwrapResult(results[0]);
  const domainResult = unwrapResult(results[1]);
  const processResult = unwrapResult(results[2]);
  const transparencyResult = unwrapResult(results[3]);

  state.sources.cnpj = resultToSource(cnpjResult);
  state.sources.rdap = resultToSource(domainResult);
  state.sources.datajud = resultToSource(processResult, "key");
  state.sources.transparency = resultToSource(transparencyResult, "key");

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
  renderAll();
  setLoading(false);
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
          ${d.link ? `<div class="entity-row"><a class="entity-pill" href="${escapeHtml(d.link)}" target="_blank" rel="noopener">Abrir no DOU</a></div>` : ""}
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
    irregularities: [],
    alerts: [],
    regulatoryHistory: [],
    decisionPattern: []
  };
}

function item(label, value, source) {
  return { label, value: text(value), source, empty: !value };
}

function compactItems(items) {
  return items.filter((entry) => !entry.empty);
}

function buildGraph(company, domains, news, processes = [], transparency = []) {
  const nodes = [];
  const edges = [];
  nodes.push({
    id: "company",
    type: "company",
    title: company.legalName || formatCnpj(company.cnpj),
    subtitle: formatCnpj(company.cnpj),
    central: true,
    status: company.status || "Conectado",
    fields: [
      ["Fonte", "CNPJ.ws"],
      ["Situacao", company.status || "Sem dado"],
      ["CNAE", company.mainCnae.code || "Sem dado"],
      ["Cidade/UF", [company.address.city, company.address.state].filter(Boolean).join("/") || "Sem dado"]
    ]
  });

  company.partners.slice(0, 10).forEach((partner, index) => {
    const id = `partner-${index}`;
    nodes.push({
      id, type: "partner",
      title: partner.name || "Socio sem nome",
      subtitle: partner.qualification || "QSA",
      status: "QSA",
      fields: [["Fonte", "CNPJ.ws"], ["Entrada", partner.entryDate || "Sem dado"]]
    });
    edges.push(["company", id, "Socio", 0.9]);
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
      list.innerHTML = emptyCard("Diretores", name ? `Nenhum diretor com "${name}".` : "Nenhum diretor mapeado ainda. Rode a ingestao do DOU.");
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
    const d = await requestJson(`/api/dossier-person?id=${encodeURIComponent(id)}`);
    const intel = d.intelligence || {};
    const mandates = (d.mandates || []).map((m) => `<span class="entity-pill">${escapeHtml(m.agencies?.acronym || "")} ${escapeHtml(m.role || "")}</span>`).join("");
    const parties = (d.party_links || []).map((p) => `<span class="entity-pill">${escapeHtml(p.party)}</span>`).join("");
    const rels = (d.relationships || []).length;
    list.innerHTML = `
      <article class="news-card">
        <button type="button" class="entity-pill" id="director-back">&larr; Voltar a lista</button>
        <span class="source-meta">${escapeHtml(d.person.full_name)} | ${escapeHtml(d.person.role || "dirigente")}</span>
        <strong>Score de captura: ${intel.capture_score ?? "-"}/100 | Votos vencidos: ${intel.dissent_votes ?? 0}</strong>
        <p>Mandato ativo: ${intel.active_mandate ? "sim" : "nao"} | Conexoes: ${rels} | SIAPE: ${(d.siape || []).length} registro(s)</p>
        <div class="entity-row">${mandates}${parties}</div>
      </article>`;
    $("#director-back")?.addEventListener("click", () => loadDirectors());
  } catch (error) {
    list.innerHTML = emptyCard("Diretores", `Falha: ${error.message}`);
  }
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
  pan: null
};

const NAT_EXPAND_LIMIT = 80; // teto de vizinhos por expansao (legibilidade do grafo).

// Reconstroi nodes/edges visiveis a partir do dataset completo e do conjunto expanded.
function rebuildNatVisible() {
  const allById = Object.fromEntries(natGraph.allNodes.map((n) => [n.id, n]));
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
    const center = agency
      ? g.nodes.find((n) => n.type === "agency" && (n.subtitle || "").toUpperCase() === agency.toUpperCase())
      : g.nodes[0];
    natGraph.centerId = center ? center.id : g.nodes[0].id;
    natGraph.expanded = new Set([natGraph.centerId]); // ja revela os vizinhos do no central.
    natGraph.selectedId = null;
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
  if (!nodeId) return;
  natGraph.expanded.add(nodeId);
  rebuildNatVisible();
  $("#nat-graph-title").textContent = `${natGraph.nodes.length} entidades · ${natGraph.edges.length} vínculos`;
}

// Colapsa um no: esconde os vizinhos revelados por ele (mantem o central).
function collapseNatNode(nodeId) {
  if (!nodeId || nodeId === natGraph.centerId) return;
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

function ensureCnpjGraphView() {
  if (state.graphView || !$("#graph-cy")) return state.graphView;
  state.graphView = createGraphView({
    container: $("#graph-cy"),
    legendEl: $("#graph-legend"),
    onSelect: (id) => { state.selectedNodeId = id; renderInspector(); }
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
  $("#inspector-body").innerHTML = `
    <article class="detail-card">
      <span class="field-source">${escapeHtml(node.type)} | ${escapeHtml(node.status)}</span>
      <strong>${escapeHtml(node.subtitle)}</strong>
      <p>Dado exibido somente porque foi retornado por fonte real conectada.</p>
    </article>
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
  $("#dossier-summary").textContent = state.target
    ? `Dossie real-only para ${formatCnpj(state.target.cnpj)}. Secoes sem retorno real aparecem como vazias.`
    : "As secoes abaixo so serao preenchidas quando houver dado retornado por fonte real.";

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

function renderDossierTabs() {
  $("#dossier-tabs").innerHTML = dossierTabs
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
    irregularities: "Alertas reais dependem de dados conectados e regras aplicadas.",
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

  $("#search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const raw = ($("#global-search").value || "").trim();
    const digits = onlyDigits(raw);
    if (digits.length === 14) {
      // CNPJ -> investigação tradicional
      runSearch(raw).catch((error) => {
        setLoading(false);
        showInspectorMessage("Erro de consulta", error.message);
      });
    } else if (raw.length >= 3) {
      // Texto -> busca por palavra-chave nos atos do DOU
      runKeywordSearch(raw).catch((error) => {
        showInspectorMessage("Erro de busca", error.message);
      });
    } else {
      showInspectorMessage("Busca", "Informe um CNPJ (14 dígitos) ou termo de busca (mín. 3 letras).");
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

async function loadOverviewMetrics() {
  try {
    loadTrend(30);
    requestJson("/api/intelligence?type=recent&limit=20").then((r) => renderRecentActs(r?.items)).catch(() => {});

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
      const alEl = $("#metric-alerts");
      if (alEl) alEl.textContent = alertsData.items.length;
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
}

init();
