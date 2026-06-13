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
  transform: { x: 80, y: 60, scale: 1 },
  drag: null,
  pan: null
};

const $ = (selector) => document.querySelector(selector);

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
  buildGraph(company, domains, state.news);
  renderAll();
  setLoading(false);
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

function buildGraph(company, domains, news) {
  const nodes = [];
  const edges = [];
  nodes.push({
    id: "company",
    type: "company",
    title: company.legalName || formatCnpj(company.cnpj),
    subtitle: formatCnpj(company.cnpj),
    x: 120,
    y: 190,
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
      id,
      type: "partner",
      title: partner.name || "Socio sem nome",
      subtitle: partner.qualification || "QSA",
      x: 520,
      y: 90 + index * 108,
      status: "QSA",
      fields: [["Fonte", "CNPJ.ws"], ["Entrada", partner.entryDate || "Sem dado"]]
    });
    edges.push(["company", id, "Socio"]);
  });

  company.phones.forEach((phone, index) => {
    const id = `phone-${index}`;
    nodes.push({
      id,
      type: "contact",
      title: "Telefone",
      subtitle: phone,
      x: 870,
      y: 90 + index * 108,
      status: "Fonte publica",
      fields: [["Fonte", "CNPJ.ws"]]
    });
    edges.push(["company", id, "Contato"]);
  });

  if (company.email) {
    nodes.push({
      id: "email",
      type: "contact",
      title: "Email",
      subtitle: company.email,
      x: 870,
      y: 305,
      status: "Fonte publica",
      fields: [["Fonte", "CNPJ.ws"]]
    });
    edges.push(["company", "email", "Contato"]);
  }

  domains.slice(0, 8).forEach((domain, index) => {
    const id = `domain-${index}`;
    nodes.push({
      id,
      type: "domain",
      title: domain.name,
      subtitle: domain.aggregate ? "Contagem RDAP" : "Registro.br RDAP",
      x: 240 + index * 150,
      y: 610,
      status: "RDAP",
      fields: [["Fonte", "Registro.br"]]
    });
    edges.push(["company", id, "Dominio"]);
  });

  news.slice(0, 4).forEach((newsItem, index) => {
    const id = `news-${index}`;
    nodes.push({
      id,
      type: "news",
      title: newsItem.title,
      subtitle: newsItem.source,
      x: 240 + index * 250,
      y: 20,
      status: "RSS",
      fields: [["Data", newsItem.date || "Sem data"], ["Fonte", "Google News RSS"]]
    });
    edges.push([id, "company", "Citado em noticia"]);
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
  $("#metric-last").textContent = state.target ? formatCnpj(state.target.cnpj) : "-";
  $("#metric-last-label").textContent = state.target?.legalName || "Nenhum CNPJ consultado";
  $("#overview-source-list").innerHTML = sourceStatus
    .map((source) => {
      const runtime = state.sources[source.id];
      const status = runtime?.status || source.status;
      const detail = runtime?.detail || source.help;
      return `
        <article class="source-row">
          <span class="status-pill ${sourceClass(status)}">${sourceLabel(status)}</span>
          <div>
            <strong>${source.name}</strong>
            <p class="status-help">${detail}</p>
          </div>
        </article>
      `;
    })
    .join("");
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
        <article class="news-card">
          <span class="source-meta">${entry.source} | ${entry.date || "sem data"}</span>
          <strong>${entry.title}</strong>
          <p>${entry.summary || "Sem resumo disponivel no RSS."}</p>
          <div class="entity-row">
            <span class="entity-pill">RSS real</span>
            ${entry.link ? `<a class="entity-pill" href="${entry.link}" target="_blank" rel="noreferrer">Abrir fonte</a>` : ""}
          </div>
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
  const url = date ? `/api/dou-feed?date=${date}` : "/api/dou-feed";
  try {
    const payload = await requestJson(url);
    const items = payload.items || [];
    if (!items.length) {
      list.innerHTML = emptyCard("Monitor DOU", "Sem atos das agencias ingeridos para este periodo. Rode /api/ingest-dou.");
      return;
    }
    list.innerHTML = items
      .map((entry) => `
        <article class="news-card">
          <span class="source-meta">${escapeHtml(entry.agency || "DOU")} | ${escapeHtml(DOU_TYPE_LABEL[entry.type] || entry.type)} | ${escapeHtml(entry.date || "sem data")}</span>
          <strong>${escapeHtml(entry.title)}</strong>
          <p>${escapeHtml(entry.summary || "Sem resumo de IA.")}</p>
          <div class="entity-row">
            ${(entry.entities || []).slice(0, 4).map((e) => `<span class="entity-pill">${escapeHtml(e.name || "")}</span>`).join("")}
            ${entry.link ? `<a class="entity-pill" href="${escapeHtml(entry.link)}" target="_blank" rel="noreferrer">Abrir DOU</a>` : ""}
          </div>
        </article>
      `)
      .join("");
  } catch (error) {
    list.innerHTML = emptyCard("Monitor DOU", `Falha ao carregar: ${error.message}`);
  }
}

async function loadDirectors() {
  const list = $("#directors-list");
  if (!list) return;
  const name = $("#director-search")?.value?.trim();
  if (!name) {
    list.innerHTML = emptyCard("Diretores", "Digite um nome para gerar o dossie do dirigente.");
    return;
  }
  list.innerHTML = emptyCard("Diretores", "Montando dossie...");
  try {
    const d = await requestJson(`/api/dossier-person?name=${encodeURIComponent(name)}`);
    const intel = d.intelligence || {};
    const mandates = (d.mandates || []).map((m) => `<span class="entity-pill">${escapeHtml(m.agencies?.acronym || "")} ${escapeHtml(m.role || "")}</span>`).join("");
    const parties = (d.party_links || []).map((p) => `<span class="entity-pill">${escapeHtml(p.party)}</span>`).join("");
    list.innerHTML = `
      <article class="news-card">
        <span class="source-meta">${escapeHtml(d.person.full_name)} | ${escapeHtml(d.person.role || "dirigente")}</span>
        <strong>Score de captura: ${intel.capture_score ?? "-"}/100 | Votos vencidos: ${intel.dissent_votes ?? 0}</strong>
        <p>Mandato ativo: ${intel.active_mandate ? "sim" : "nao"} | SIAPE: ${(d.siape || []).length} registro(s)</p>
        <div class="entity-row">${mandates}${parties}</div>
      </article>`;
  } catch (error) {
    list.innerHTML = emptyCard("Diretores", `Falha: ${error.message}`);
  }
}

// Estado do grafo nacional (separado do estado do grafo CNPJ).
const natGraph = {
  nodes: [],
  edges: [],
  transform: { x: 80, y: 60, scale: 0.7 },
  selectedId: null,
  drag: null,
  pan: null
};

function natNodeWidth(node) { return node.type === "agency" ? 270 : 238; }

function layoutNatNodes(nodes) {
  // Layout circular por tipo: agencias no centro, pessoas ao redor, empresas na borda.
  const byType = { agency: [], person: [], company: [], other: [] };
  nodes.forEach((n) => { (byType[n.type] || byType.other).push(n); });
  const cx = 700, cy = 450;
  const place = (arr, r, offsetAngle = 0) => arr.forEach((n, i) => {
    const angle = offsetAngle + (i / Math.max(arr.length, 1)) * 2 * Math.PI;
    n.x = Math.round(cx + r * Math.cos(angle));
    n.y = Math.round(cy + r * Math.sin(angle));
  });
  place(byType.agency, 0);   // agencias no centro (empilhadas perto)
  place(byType.agency, byType.agency.length > 1 ? 200 : 0);
  place(byType.person, 420, Math.PI / 6);
  place(byType.company, 700, 0);
  place(byType.other, 550, Math.PI / 3);
}

function renderNatGraph() {
  const stage = $("#nat-graph-stage");
  const edgeLayer = $("#nat-edge-layer");
  const nodeLayer = $("#nat-node-layer");
  if (!stage) return;
  stage.style.transform = `translate(${natGraph.transform.x}px, ${natGraph.transform.y}px) scale(${natGraph.transform.scale})`;
  $("#nat-graph-empty").classList.toggle("hidden", natGraph.nodes.length > 0);

  edgeLayer.setAttribute("viewBox", "0 0 1400 900");
  const nodeById = Object.fromEntries(natGraph.nodes.map((n) => [n.id, n]));
  edgeLayer.innerHTML = natGraph.edges.map(([from, to, label]) => {
    const a = nodeById[from], b = nodeById[to];
    if (!a || !b) return "";
    const w = natNodeWidth(a);
    const x1 = a.x + w, y1 = a.y + 48, x2 = b.x, y2 = b.y + 48;
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    return `<line class="edge-line" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"></line>
            <text class="edge-label" x="${mx + 4}" y="${my - 4}">${escapeHtml(label)}</text>`;
  }).join("");

  nodeLayer.innerHTML = natGraph.nodes.map((node) => {
    const w = natNodeWidth(node);
    const active = node.id === natGraph.selectedId ? " active" : "";
    const central = node.type === "agency" ? " central" : "";
    const fields = (node.fields || []).map(([k, v]) => `<div class="node-field"><span>${escapeHtml(k)}</span><span>${escapeHtml(String(v))}</span></div>`).join("");
    return `<article class="node-card${central}${active}" data-natnode="${escapeHtml(node.id)}" style="left:${node.x}px;top:${node.y}px;width:${w}px">
      <div class="node-icon ${escapeHtml(node.type)}">${iconFor(node.type)}</div>
      <div class="node-body">
        <strong>${escapeHtml(node.title)}</strong>
        <span class="node-sub">${escapeHtml(node.subtitle || "")}</span>
        ${fields}
        <span class="status-pill ok">${escapeHtml(node.status || node.type)}</span>
      </div>
    </article>`;
  }).join("");
}

async function loadNationalGraph() {
  const agency = $("#graph-agency")?.value?.trim();
  const url = `/api/graph${agency ? `?agency=${encodeURIComponent(agency)}&limit=500` : "?limit=500"}`;
  try {
    const g = await requestJson(url);
    if (!g.nodes?.length) { renderNatGraph(); return; }
    natGraph.nodes = g.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      subtitle: n.subtitle || "",
      status: n.type,
      fields: [["Tipo", n.type]],
      x: 200, y: 200
    }));
    natGraph.edges = g.edges.map((e) => [e.from, e.to, e.relationship]);
    layoutNatNodes(natGraph.nodes);
    $("#nat-graph-title").textContent = `${g.nodes.length} entidades · ${g.edges.length} conexoes`;
    renderNatGraph();
  } catch (error) {
    const empty = $("#nat-graph-empty");
    if (empty) { empty.classList.remove("hidden"); empty.querySelector("p").textContent = `Falha: ${error.message}`; }
  }
}

function wireNatGraph() {
  const canvas = $("#nat-graph-canvas");
  if (!canvas) return;
  canvas.addEventListener("pointerdown", (e) => {
    const nodeEl = e.target.closest("[data-natnode]");
    if (nodeEl) {
      natGraph.selectedId = nodeEl.dataset.natnode;
      const node = natGraph.nodes.find((n) => n.id === natGraph.selectedId);
      const title = $("#nat-inspector-title"), body = $("#nat-inspector-body");
      if (title) title.textContent = node?.title || natGraph.selectedId;
      if (body) body.innerHTML = node ? `<div class="inspector-section"><p class="field-source">${escapeHtml(node.type)}</p><p>${escapeHtml(node.subtitle || "")}</p></div>` : "";
      natGraph.drag = { id: natGraph.selectedId, startX: e.clientX, startY: e.clientY, ox: node?.x || 0, oy: node?.y || 0 };
      renderNatGraph();
    } else {
      natGraph.pan = { startX: e.clientX, startY: e.clientY, ox: natGraph.transform.x, oy: natGraph.transform.y };
    }
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (natGraph.drag) {
      const node = natGraph.nodes.find((n) => n.id === natGraph.drag.id);
      if (node) { node.x = natGraph.drag.ox + (e.clientX - natGraph.drag.startX) / natGraph.transform.scale; node.y = natGraph.drag.oy + (e.clientY - natGraph.drag.startY) / natGraph.transform.scale; }
      renderNatGraph();
    } else if (natGraph.pan) {
      natGraph.transform.x = natGraph.pan.ox + (e.clientX - natGraph.pan.startX);
      natGraph.transform.y = natGraph.pan.oy + (e.clientY - natGraph.pan.startY);
      renderNatGraph();
    }
  });
  canvas.addEventListener("pointerup", () => { natGraph.drag = null; natGraph.pan = null; });
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); natGraph.transform.scale = Math.min(2, Math.max(0.3, natGraph.transform.scale - e.deltaY * 0.001)); renderNatGraph(); }, { passive: false });
  $("#nat-zoom-in")?.addEventListener("click", () => { natGraph.transform.scale = Math.min(2, natGraph.transform.scale + 0.12); renderNatGraph(); });
  $("#nat-zoom-out")?.addEventListener("click", () => { natGraph.transform.scale = Math.max(0.3, natGraph.transform.scale - 0.12); renderNatGraph(); });
  $("#nat-reset-graph")?.addEventListener("click", () => { natGraph.transform = { x: 80, y: 60, scale: 0.7 }; renderNatGraph(); });
  $("#graph-agency")?.addEventListener("change", () => loadNationalGraph());
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
      else score.innerHTML = sc.scores.map((s) => `
        <article class="news-card">
          <span class="source-meta">${escapeHtml(s.agency)} | ${s.docs} atos | ${s.open_alerts} alertas abertos | ${s.active_directors} diretores ativos</span>
          <strong>${escapeHtml(s.name)}</strong>
          <div class="entity-row">
            <span class="entity-pill" style="background:${s.score > 60 ? '#ef6760' : s.score > 30 ? '#d7ad4f' : '#61c46e'}">Score ${s.score}/100</span>
          </div>
        </article>`).join("");
    }
    // Radar
    if (radar) {
      const all = [...(rd.radar?.["30d"] || []).map((i) => ({ ...i, window: "30d" })),
                   ...(rd.radar?.["60d"] || []).map((i) => ({ ...i, window: "60d" })),
                   ...(rd.radar?.["90d"] || []).map((i) => ({ ...i, window: "90d" }))];
      if (!all.length) { radar.innerHTML = emptyCard("Radar", "Nenhum contrato a vencer nos proximos 90 dias. Rode ingest-pncp."); }
      else radar.innerHTML = all.map((c) => `
        <article class="news-card">
          <span class="source-meta">${escapeHtml(c.agency || "")} | Vence: ${escapeHtml(c.date || "")} | <strong>${escapeHtml(c.window)}</strong></span>
          <strong>${escapeHtml(c.label)}</strong>
          <p>${escapeHtml(c.supplier || "Fornecedor nao identificado")}</p>
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
      <article class="news-card">
        <span class="source-meta">${escapeHtml(c.agency)} | ${escapeHtml(c.date || "sem data")}</span>
        <strong>${escapeHtml(c.title)}</strong>
        <p>${escapeHtml(c.summary || "")}</p>
        <div class="entity-row">
          ${c.link ? `<a class="entity-pill" href="${escapeHtml(c.link)}" target="_blank" rel="noreferrer">Abrir</a>` : ""}
        </div>
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
      <article class="news-card">
        <span class="source-meta">${escapeHtml(c.agency)} | ${escapeHtml(c.date || "sem data")}</span>
        <strong>${escapeHtml(c.title)}</strong>
        <p>${escapeHtml(c.summary || "")}</p>
        <div class="entity-row">
          ${c.link ? `<a class="entity-pill" href="${escapeHtml(c.link)}" target="_blank" rel="noreferrer">Abrir</a>` : ""}
        </div>
      </article>`).join("");
  } catch (error) {
    list.innerHTML = emptyCard("Agenda", `Erro: ${error.message}`);
  }
}

function renderGraph() {
  const stage = $("#graph-stage");
  const edgeLayer = $("#edge-layer");
  const nodeLayer = $("#node-layer");
  stage.style.transform = `translate(${state.transform.x}px, ${state.transform.y}px) scale(${state.transform.scale})`;
  $("#graph-empty").classList.toggle("hidden", state.graphNodes.length > 0);
  $("#graph-title").textContent = state.target?.legalName || "Aguardando CNPJ";

  edgeLayer.setAttribute("viewBox", "0 0 1400 900");

  const nodeById = Object.fromEntries(state.graphNodes.map((node) => [node.id, node]));
  edgeLayer.innerHTML = state.graphEdges
    .map(([from, to, label]) => {
      const a = nodeById[from];
      const b = nodeById[to];
      if (!a || !b) return "";
      const x1 = a.x + (a.central ? 270 : 238);
      const y1 = a.y + 48;
      const x2 = b.x;
      const y2 = b.y + 48;
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      return `
        <line class="edge-line" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"></line>
        <text class="edge-label" x="${mx + 8}" y="${my - 5}">${escapeHtml(label)}</text>
      `;
    })
    .join("");

  nodeLayer.innerHTML = state.graphNodes
    .map((node) => {
      const fields = node.fields
        .filter(([, value]) => value)
        .map(([label, value]) => `<div class="node-field"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`)
        .join("");
      return `
        <article
          class="node-card ${node.central ? "central" : ""} ${node.id === state.selectedNodeId ? "active" : ""}"
          data-node="${node.id}"
          style="left:${node.x}px; top:${node.y}px"
        >
          <div class="node-head">
            <span class="node-icon ${node.type}">${iconFor(node.type)}</span>
            <div>
              <span class="node-title">${escapeHtml(node.title)}</span>
              <span class="node-subtitle">${escapeHtml(node.subtitle)}</span>
            </div>
          </div>
          <div class="node-fields">${fields}</div>
          <span class="status-pill status-ok">${escapeHtml(node.status)}</span>
        </article>
      `;
    })
    .join("");
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

function wireEvents() {
  $("#view-nav").addEventListener("click", (event) => {
    const button = event.target.closest("[data-view]");
    if (!button) return;
    setView(button.dataset.view);
  });

  $("#search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    runSearch($("#global-search").value).catch((error) => {
      setLoading(false);
      showInspectorMessage("Erro de consulta", error.message);
    });
  });

  $("#dou-date")?.addEventListener("change", () => loadDouFeed());
  $("#director-search")?.addEventListener("change", () => loadDirectors());
  wireNatGraph();

  $("#open-dossier").addEventListener("click", () => setView("dossier"));
  $("#center-graph").addEventListener("click", centerGraph);
  $("#reset-graph").addEventListener("click", () => {
    state.transform = { x: 80, y: 60, scale: 1 };
    renderGraph();
  });
  $("#zoom-in").addEventListener("click", () => zoomGraph(0.12));
  $("#zoom-out").addEventListener("click", () => zoomGraph(-0.12));

  $("#dossier-tabs").addEventListener("click", (event) => {
    const tab = event.target.closest("[data-dossier-tab]");
    if (!tab) return;
    state.activeDossierTab = tab.dataset.dossierTab;
    renderDossier();
  });

  const canvas = $("#graph-canvas");
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
}

function onPointerDown(event) {
  const nodeEl = event.target.closest("[data-node]");
  const canvas = $("#graph-canvas");
  canvas.setPointerCapture(event.pointerId);
  if (nodeEl) {
    const node = state.graphNodes.find((entry) => entry.id === nodeEl.dataset.node);
    state.selectedNodeId = node.id;
    state.drag = {
      id: node.id,
      startX: event.clientX,
      startY: event.clientY,
      nodeX: node.x,
      nodeY: node.y
    };
    renderGraph();
    renderInspector();
    return;
  }
  state.pan = {
    startX: event.clientX,
    startY: event.clientY,
    x: state.transform.x,
    y: state.transform.y
  };
  canvas.classList.add("dragging");
}

function onPointerMove(event) {
  if (state.drag) {
    const node = state.graphNodes.find((entry) => entry.id === state.drag.id);
    if (!node) return;
    node.x = Math.max(0, state.drag.nodeX + (event.clientX - state.drag.startX) / state.transform.scale);
    node.y = Math.max(0, state.drag.nodeY + (event.clientY - state.drag.startY) / state.transform.scale);
    renderGraph();
  }
  if (state.pan) {
    state.transform.x = state.pan.x + event.clientX - state.pan.startX;
    state.transform.y = state.pan.y + event.clientY - state.pan.startY;
    renderGraph();
  }
}

function onPointerUp(event) {
  $("#graph-canvas").releasePointerCapture?.(event.pointerId);
  $("#graph-canvas").classList.remove("dragging");
  state.drag = null;
  state.pan = null;
}

function onWheel(event) {
  event.preventDefault();
  zoomGraph(event.deltaY > 0 ? -0.08 : 0.08);
}

function zoomGraph(delta) {
  state.transform.scale = Math.min(1.8, Math.max(0.45, state.transform.scale + delta));
  renderGraph();
}

function centerGraph() {
  state.transform = { x: 80, y: 60, scale: 1 };
  setView("investigate");
  renderGraph();
}

async function loadOverviewMetrics() {
  try {
    const [score, daily] = await Promise.all([
      requestJson("/api/intelligence?type=score").catch(() => null),
      requestJson("/api/intelligence?type=daily").catch(() => null)
    ]);
    if (score?.scores) {
      const total = score.scores.reduce((s, a) => s + a.docs, 0);
      const people = score.scores.reduce((s, a) => s + a.active_directors, 0);
      const alerts = score.scores.reduce((s, a) => s + a.open_alerts, 0);
      const docEl = $("#metric-docs"), ppEl = $("#metric-people"), alEl = $("#metric-alerts");
      if (docEl) { docEl.textContent = total; $("#metric-docs-label").textContent = "Atos do DOU no banco"; }
      if (ppEl) ppEl.textContent = people;
      if (alEl) alEl.textContent = alerts;
    }
    const dailyEl = $("#overview-daily");
    if (dailyEl && daily?.by_agency) {
      const entries = Object.entries(daily.by_agency);
      dailyEl.innerHTML = entries.length
        ? entries.map(([ac, d]) => `<article class="news-card"><span class="source-meta">${escapeHtml(ac)}</span><strong>${d.normas} normas · ${d.pessoal} atos pessoal · ${d.contratos} contratos</strong>${(d.destaques||[]).slice(0,1).map(s=>`<p>${escapeHtml(s)}</p>`).join("")}</article>`).join("")
        : emptyCard("Diario", "Nenhum ato nas ultimas 24h. Cron roda ao meio-dia UTC.");
    }
    // contratos
    const contracts = await requestJson("/api/intelligence?type=radar").catch(() => null);
    if (contracts) {
      const total = (contracts.radar?.["30d"]?.length || 0) + (contracts.radar?.["60d"]?.length || 0) + (contracts.radar?.["90d"]?.length || 0);
      const el = $("#metric-contracts");
      if (el) el.textContent = total;
    }
  } catch { /* sem dados ainda */ }
}

function init() {
  renderAll();
  wireEvents();
  loadOverviewMetrics();
}

init();
