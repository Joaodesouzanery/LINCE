const target = {
  id: "barraca-aceu",
  title: "Barraca do Alceu",
  subtitle: "CNPJ 24.598.038/0001-76",
  summary:
    "Alvo demonstrativo com dados cadastrais, vínculos societários, contatos, documentos, processos, dívida, notícias regulatórias e padrão decisório relacionado a uma agência.",
  riskScore: 82
};

const graphNodes = [
  {
    id: "company",
    type: "company",
    title: "Barraca do Alceu",
    subtitle: "24.598.038/0001-76",
    x: 150,
    y: 210,
    central: true,
    status: "Inativo",
    fields: [
      ["Status CNPJ", "Inativo"],
      ["Cap. social", "R$ 230.000,00"],
      ["Data abertura", "08/02/2013"],
      ["Situação", "Ativa ICMS/PR"],
      ["Cidade/Estado", "Porto Alegre/RS"],
      ["CNAE princ.", "47.81-4-00"]
    ],
    body: "Empresa usada como alvo central da investigação. O LINCE cruza cadastro, fontes regulatórias, notícias, processos e vínculos."
  },
  {
    id: "partner-renata",
    type: "partner",
    title: "Renata Araújo da Silva",
    subtitle: "687.***.***-08",
    x: 560,
    y: 128,
    status: "Inativo",
    fields: [["Situação cadastral", "Inativo"]],
    body: "Sócia vinculada ao QSA. CPF sempre mascarado e tratado conforme fonte pública ou licenciada."
  },
  {
    id: "partner-alceu",
    type: "partner",
    title: "Alceu da Silva",
    subtitle: "123.***.***-02",
    x: 560,
    y: 268,
    status: "Inativo",
    fields: [["Situação cadastral", "Inativo"]],
    body: "Sócio/administrador identificado no quadro societário."
  },
  {
    id: "phone",
    type: "contact",
    title: "Telefone",
    subtitle: "(21) 9999-8887",
    x: 600,
    y: 428,
    status: "Restrito",
    fields: [["Origem", "Base licenciada ou cliente"]],
    body: "Campo demonstrativo. O sistema só deve preencher contatos quando houver fonte pública, licenciada ou dado fornecido pelo cliente."
  },
  {
    id: "email",
    type: "contact",
    title: "E-mail",
    subtitle: "alceu.2024@gmail.com",
    x: 600,
    y: 548,
    status: "Restrito",
    fields: [["Origem", "Base licenciada ou cliente"]],
    body: "E-mail tratado como dado sensível. Exibir apenas com base legal e trilha de origem."
  },
  {
    id: "agency",
    type: "regulatory",
    title: "ARTESP",
    subtitle: "Agência reguladora",
    x: 875,
    y: 100,
    status: "Conectado",
    fields: [["Fonte", "Pautas, atas e deliberações"], ["Coleta", "Scraping + PDF"]],
    body: "Fonte regulatória prioritária para deliberações, atas, documentos SEI e histórico decisório."
  },
  {
    id: "director",
    type: "person",
    title: "Diretor de Regulação",
    subtitle: "Padrão decisório",
    x: 900,
    y: 248,
    status: "Monitorado",
    fields: [["Votos mapeados", "42"], ["Tendência", "Rigor moderado"]],
    body: "Perfil de voto usado para prever sensibilidade a temas, sanções e argumentos técnicos."
  },
  {
    id: "process",
    type: "process",
    title: "Processo regulatório",
    subtitle: "SEI 134.00048923/2025-48",
    x: 890,
    y: 405,
    status: "Publicado",
    fields: [["Tema", "Governança / sanção"], ["Confiança", "91%"]],
    body: "Documento regulatório estruturado por IA do LINCE a partir de PDF/SEI."
  },
  {
    id: "debt",
    type: "debt",
    title: "Dívida / PGFN",
    subtitle: "Checagem pendente",
    x: 870,
    y: 555,
    status: "Alerta",
    fields: [["Origem", "PGFN"], ["Status", "Requer sync"]],
    body: "Indicação de enriquecimento financeiro-fiscal. Deve apontar para fonte oficial ou base licenciada."
  },
  {
    id: "domain",
    type: "domain",
    title: "dominio-alvo.com.br",
    subtitle: "Domínio",
    x: 330,
    y: 565,
    status: "Monitorado",
    fields: [["DNS", "Aguardando crawler"], ["Relação", "Possível ativo digital"]],
    body: "Domínios entram como ativos digitais conectáveis ao alvo quando a fonte for pública."
  },
  {
    id: "news",
    type: "news",
    title: "Notícia regulatória",
    subtitle: "RSS / Scraper",
    x: 330,
    y: 75,
    status: "Novo",
    fields: [["Fonte", "RSS agência"], ["Score", "87%"]],
    body: "Notícias e publicações de agência geram conexões automáticas com empresa, diretor, tema ou processo."
  }
];

const graphEdges = [
  ["company", "partner-renata", "Sócio"],
  ["company", "partner-alceu", "Sócio"],
  ["company", "phone", "Contato"],
  ["company", "email", "Contato"],
  ["company", "agency", "Regulado por"],
  ["agency", "director", "Diretor"],
  ["director", "process", "Votou em"],
  ["company", "process", "Empresa afetada"],
  ["company", "debt", "Aparece em dívida"],
  ["company", "domain", "Domínio"],
  ["news", "company", "Citado em notícia"],
  ["news", "agency", "Publicado por"]
];

const dossierSections = [
  {
    id: "basic",
    label: "Informações Básicas",
    items: [
      ["Razão social", "Barraca do Alceu Ltda.", "Receita Federal / CNPJ"],
      ["CNPJ", "24.598.038/0001-76", "Receita Federal / CNPJ"],
      ["Situação cadastral", "Inativa na demo, validar na base mensal", "Receita Federal / CNPJ"],
      ["Capital social", "R$ 230.000,00", "Receita Federal / CNPJ"],
      ["Cidade/UF", "Porto Alegre/RS", "Cadastro público"]
    ]
  },
  {
    id: "cnaes",
    label: "CNAEs",
    items: [
      ["CNAE principal", "47.81-4-00 - Comércio varejista demonstrativo", "Receita Federal"],
      ["CNAEs secundários", "Lista enriquecida quando disponível no dump CNPJ", "Receita Federal"]
    ]
  },
  {
    id: "partners",
    label: "Sócios",
    items: [
      ["Renata Araújo da Silva", "Sócia - CPF mascarado", "QSA / Receita Federal"],
      ["Alceu da Silva", "Sócio administrador - CPF mascarado", "QSA / Receita Federal"],
      ["Grupo econômico provável", "Inferido por QSA, endereços e participação cruzada", "LINCE"]
    ]
  },
  {
    id: "movements",
    label: "Movimentações",
    items: [
      ["Alteração contratual", "Pendente de integração JUCESP/REDESIM", "Junta comercial / REDESIM"],
      ["Mudança cadastral", "Detectável no dump mensal da Receita", "Receita Federal"]
    ]
  },
  {
    id: "addresses",
    label: "Endereços",
    items: [
      ["Endereço fiscal", "Rua demonstrativa, Porto Alegre/RS", "Receita Federal"],
      ["Endereços relacionados", "Cruzamento por QSA e documentos públicos", "LINCE"]
    ]
  },
  {
    id: "phones",
    label: "Telefones",
    restricted: true,
    items: [
      ["Telefone principal", "Disponível apenas por fonte pública, base licenciada ou dado fornecido pelo cliente.", "Política LGPD"],
      ["Histórico de telefones", "Não preencher sem origem auditável.", "Política LINCE"]
    ]
  },
  {
    id: "emails",
    label: "Emails",
    restricted: true,
    items: [
      ["E-mail encontrado", "Disponível apenas por fonte pública, base licenciada ou dado fornecido pelo cliente.", "Política LGPD"],
      ["Validação", "Exibir origem, data e confiança antes de uso comercial.", "LINCE"]
    ]
  },
  {
    id: "social",
    label: "Redes Sociais",
    restricted: true,
    items: [
      ["Perfis sociais", "Coleta somente de fontes abertas e permitidas pelos termos aplicáveis.", "OSINT permitido"],
      ["Risco reputacional", "Conexões são sinalizadas, não tratadas como prova isolada.", "LINCE"]
    ]
  },
  {
    id: "documents",
    label: "Documentos",
    items: [
      ["Deliberação ARTESP nº 04/2025", "PDF/SEI estruturado por IA do LINCE", "ARTESP"],
      ["Pauta/ata de reunião", "Download, hash, texto extraído e evidência citável", "Agência reguladora"],
      ["DOU/DOE", "Atos normativos, portarias, nomeações e resoluções", "Diários oficiais"]
    ]
  },
  {
    id: "processes",
    label: "Processos",
    items: [
      ["Processo regulatório", "SEI 134.00048923/2025-48", "ARTESP"],
      ["Processos judiciais", "Metadados públicos por CPF/CNPJ quando disponíveis", "CNJ DataJud / bureaus"]
    ]
  },
  {
    id: "debts",
    label: "Dívidas",
    items: [
      ["Dívida ativa", "Checagem em PGFN por CNPJ", "PGFN"],
      ["Execução fiscal", "Metadados judiciais quando houver correspondência", "DataJud / tribunais"]
    ]
  },
  {
    id: "bank",
    label: "Contas Bancárias",
    restricted: true,
    items: [
      ["Dados bancários", "Disponível apenas se fornecido pelo cliente, ordem legal ou base licenciada compatível.", "Política LGPD"],
      ["Uso no dossiê", "Nunca inferir conta bancária por OSINT frágil.", "Governança LINCE"]
    ]
  },
  {
    id: "irregularities",
    label: "Irregularidades e Alertas",
    items: [
      ["Reincidência regulatória", "Aparições repetidas em processos de sanção ou obrigação", "LINCE"],
      ["Conflito potencial", "Diretor com vínculo histórico votando em empresa relacionada", "LINCE"],
      ["Voto-vista recorrente", "Padrão comportamental por diretor e empresa", "LINCE"]
    ]
  },
  {
    id: "alerts",
    label: "Alertas",
    items: [
      ["Nova pauta", "Agência publicou item que cita empresa monitorada", "Scraper/RSS"],
      ["Nova ata", "Documento pronto para extração de votos", "Agência reguladora"],
      ["Mudança societária", "QSA mudou no dump mensal", "Receita Federal"]
    ]
  },
  {
    id: "domains",
    label: "Domínios",
    items: [
      ["dominio-alvo.com.br", "Ativo digital demonstrativo conectado ao alvo", "DNS/OSINT permitido"],
      ["WHOIS/DNS", "Coletar somente dados públicos e permitidos", "Fonte aberta"]
    ]
  },
  {
    id: "news",
    label: "Notícias / RSS regulatório",
    items: [
      ["ARTESP publica nova ata", "Notícia gera conexão com agência, processo e empresa", "RSS/Scraper"],
      ["DOU traz ato normativo", "Publicação alimenta monitoramento por tema", "DOU/InLabs"],
      ["Consulta pública aberta", "Entidades extraídas e score de relevância calculado", "Agência reguladora"]
    ]
  },
  {
    id: "history",
    label: "Histórico Regulatório",
    items: [
      ["Aparições em deliberações", "18 registros demonstrativos", "LINCE"],
      ["Temas dominantes", "Sanção, concessão, governança e reajuste", "LINCE"],
      ["Diretores envolvidos", "Mapa por voto, relator e divergência", "LINCE"]
    ]
  },
  {
    id: "decision",
    label: "Padrão Decisório",
    items: [
      ["Tendência do diretor", "Rigor moderado em sanções; abertura a dosimetria com prova técnica", "IA do LINCE"],
      ["Precedentes similares", "Comparação por agência, tema, relator e resultado", "IA do LINCE"],
      ["Resumo executivo", "Gerado por Codex/OpenAI com evidências citáveis", "IA do LINCE"]
    ]
  }
];

const sourceCapabilities = [
  ["Receita Federal", "CNPJ, CNAE, QSA, situação e endereço", "CSV público mensal", "Conectada"],
  ["JUCESP / REDESIM", "Movimentações societárias e alterações contratuais", "API/bureau", "Pendente"],
  ["ARTESP", "Pautas, atas, deliberações e SEI", "Scraping + PDF", "Conectada"],
  ["ANEEL", "Pautas, atas e votos", "CKAN + PDF", "Conectada"],
  ["DOU / INLABS", "Nomeações, atos, portarias e resoluções", "XML/ZIP/API", "Conectada"],
  ["DOE-SP", "Atos estaduais e SEI/GESP", "Scraping", "Pendente"],
  ["Portal da Transparência", "Servidores, vínculos, CEIS/CNEP", "API REST", "Conectada"],
  ["CNJ DataJud", "Metadados de processos judiciais", "API pública", "Conectada"],
  ["PGFN", "Dívida ativa e FGTS", "CSV trimestral", "Conectada"],
  ["PNCP", "Contratos, editais e fornecedores", "API/portal", "Conectada"],
  ["RSS Agências", "Notícias, consultas e publicações recentes", "RSS/Scraper", "Pendente"],
  ["Contatos / Bancos", "Telefones, e-mails e contas", "Pública/licenciada/cliente", "Restrita"]
];

const rssItems = [
  {
    source: "ARTESP",
    title: "Ata de reunião publicada com novo processo SEI",
    date: "2026-05-19",
    summary: "Publicação gera conexão entre agência, processo, empresa citada e possível deliberação futura.",
    entities: ["ARTESP", "SEI", "Empresa monitorada"],
    score: 91
  },
  {
    source: "DOU",
    title: "Ato normativo cita setor regulado",
    date: "2026-05-18",
    summary: "Item alimenta alertas por tema e histórico normativo do setor.",
    entities: ["DOU", "Portaria", "Tema regulatório"],
    score: 84
  },
  {
    source: "ANEEL",
    title: "Pauta antecipada inclui matéria tarifária",
    date: "2026-05-17",
    summary: "Pauta permite briefing antes da reunião e comparação com padrão decisório dos diretores.",
    entities: ["ANEEL", "Tarifa", "Diretoria"],
    score: 88
  }
];

const state = {
  selectedNodeId: "company",
  activeView: "investigate",
  searchType: "cnpj",
  activeDossierTab: "basic"
};

const $ = (selector) => document.querySelector(selector);

function getNode(id = state.selectedNodeId) {
  return graphNodes.find((node) => node.id === id) || graphNodes[0];
}

function statusClass(status) {
  const normalized = status.toLowerCase();
  if (normalized.includes("ativo") || normalized.includes("conectado") || normalized.includes("monitorado") || normalized.includes("novo")) {
    return "status-active";
  }
  if (normalized.includes("alerta")) return "status-alert";
  return "status-restricted";
}

function iconFor(type) {
  return {
    company: "▣",
    partner: "♙",
    person: "♙",
    contact: "☎",
    process: "!",
    debt: "!",
    document: "◫",
    news: "◆",
    domain: "⌁",
    regulatory: "⚖"
  }[type] || "•";
}

function setView(view) {
  state.activeView = view;
  document.querySelectorAll(".view").forEach((section) => {
    section.classList.toggle("active", section.id === `view-${view}`);
  });
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
}

function renderGraph() {
  const edgeLayer = $("#edge-layer");
  const nodeLayer = $("#node-layer");
  const byId = Object.fromEntries(graphNodes.map((node) => [node.id, node]));

  edgeLayer.innerHTML = graphEdges
    .map(([from, to, label]) => {
      const a = byId[from];
      const b = byId[to];
      const x1 = a.x + (a.central ? 240 : 214);
      const y1 = a.y + 45;
      const x2 = b.x;
      const y2 = b.y + 45;
      const midX = (x1 + x2) / 2;
      const midY = (y1 + y2) / 2;
      return `
        <line class="edge-line" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"></line>
        <circle cx="${midX}" cy="${midY}" r="5" fill="#b8ef86"></circle>
        <text class="edge-label" x="${midX + 10}" y="${midY + 4}">${label}</text>
      `;
    })
    .join("");

  nodeLayer.innerHTML = graphNodes
    .map((node) => {
      const fields = node.fields
        .map(([label, value]) => `<div class="node-field"><span>${label}</span><strong>${value}</strong></div>`)
        .join("");
      return `
        <article
          class="graph-node ${node.central ? "central" : ""} ${node.id === state.selectedNodeId ? "active" : ""}"
          style="left:${node.x}px; top:${node.y}px"
          data-node="${node.id}"
        >
          <div class="node-head">
            <span class="node-icon ${node.type}">${iconFor(node.type)}</span>
            <div>
              <span class="node-title">${node.title}</span>
              <span class="node-type">${node.subtitle}</span>
            </div>
          </div>
          ${node.central ? '<div class="node-image" aria-hidden="true"></div>' : ""}
          <div class="node-fields">${fields}</div>
          <span class="status-chip ${statusClass(node.status)}">${node.status}</span>
        </article>
      `;
    })
    .join("");
}

function renderInspector() {
  const node = getNode();
  $("#inspector-title").textContent = node.title;
  $("#inspector-body").innerHTML = `
    <article class="detail-card">
      <span class="field-source">${node.type} · ${node.status}</span>
      <strong>${node.subtitle}</strong>
      <p>${node.body}</p>
    </article>
    ${node.fields
      .map(
        ([label, value]) => `
          <article class="detail-card">
            <span class="field-source">${label}</span>
            <strong>${value}</strong>
            <p>Campo rastreável com origem e confiança no dossiê.</p>
          </article>
        `
      )
      .join("")}
  `;
}

function renderDossierHeader() {
  $("#dossier-title").textContent = `Dossiê: ${target.title}`;
  $("#dossier-summary").textContent = target.summary;
  $("#risk-score").textContent = target.riskScore;
}

function renderDossierTabs() {
  $("#dossier-tabs").innerHTML = dossierSections
    .map(
      (section) => `
        <button class="dossier-tab ${section.id === state.activeDossierTab ? "active" : ""}" type="button" data-dossier-tab="${section.id}">
          ${section.label}
        </button>
      `
    )
    .join("");
}

function renderDossierContent() {
  const section = dossierSections.find((item) => item.id === state.activeDossierTab) || dossierSections[0];
  $("#dossier-content").innerHTML = section.items
    .map(
      ([label, value, source]) => `
        <article class="dossier-item ${section.restricted ? "restricted" : ""}">
          <span class="field-source">${source}</span>
          <strong>${label}</strong>
          <p>${value}</p>
        </article>
      `
    )
    .join("");
}

function renderSources() {
  $("#source-grid").innerHTML = sourceCapabilities
    .map(
      ([source, data, method, status]) => `
        <article class="source-card">
          <span class="source-meta">${method}</span>
          <strong>${source}</strong>
          <p>${data}</p>
          <span class="status-chip ${statusClass(status)}">${status}</span>
        </article>
      `
    )
    .join("");

  $("#rss-feed").innerHTML = rssItems
    .map(
      (item) => `
        <article class="rss-card">
          <span class="source-meta">${item.source} · ${new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium" }).format(new Date(`${item.date}T12:00:00`))}</span>
          <strong>${item.title}</strong>
          <p>${item.summary}</p>
          <div class="entities">
            ${item.entities.map((entity) => `<span class="entity-pill">${entity}</span>`).join("")}
            <span class="entity-pill">Score ${item.score}%</span>
          </div>
        </article>
      `
    )
    .join("");
}

function generateDossier() {
  state.activeDossierTab = "decision";
  renderDossierTabs();
  renderDossierContent();
  setView("dossier");
}

function wireEvents() {
  $("#view-nav").addEventListener("click", (event) => {
    const button = event.target.closest("[data-view]");
    if (!button) return;
    setView(button.dataset.view);
  });

  $("#node-layer").addEventListener("click", (event) => {
    const node = event.target.closest("[data-node]");
    if (!node) return;
    state.selectedNodeId = node.dataset.node;
    renderGraph();
    renderInspector();
  });

  $("#dossier-tabs").addEventListener("click", (event) => {
    const tab = event.target.closest("[data-dossier-tab]");
    if (!tab) return;
    state.activeDossierTab = tab.dataset.dossierTab;
    renderDossierTabs();
    renderDossierContent();
  });

  document.querySelectorAll("[data-search-type]").forEach((button) => {
    button.addEventListener("click", () => {
      state.searchType = button.dataset.searchType;
      document.querySelectorAll("[data-search-type]").forEach((item) => {
        item.classList.toggle("active", item === button);
      });
      $("#global-search").placeholder = `Buscar por ${button.textContent.trim()}`;
    });
  });

  $("#search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    setView("investigate");
    state.selectedNodeId = "company";
    renderGraph();
    renderInspector();
  });

  $("#generate-dossier").addEventListener("click", generateDossier);
  $("#open-dossier").addEventListener("click", () => setView("dossier"));
  $("#expand-node").addEventListener("click", () => {
    const node = getNode();
    $("#inspector-body").insertAdjacentHTML(
      "afterbegin",
      `<article class="notice-card"><p>IA do LINCE expandiu conexões relacionadas a ${node.title}. Em produção, esta ação consultaria Supabase, fontes públicas e scrapers/RSS.</p></article>`
    );
  });
}

function init() {
  renderGraph();
  renderInspector();
  renderDossierHeader();
  renderDossierTabs();
  renderDossierContent();
  renderSources();
  wireEvents();
}

init();
