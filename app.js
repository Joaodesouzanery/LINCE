const sources = [
  ["ARTESP", "Agência estadual", "connected", "Scraping + PDF", "Deliberações, reuniões e atas da diretoria"],
  ["ANEEL", "Agência federal", "connected", "CKAN + PDF", "Pautas, atas, votos e matérias deliberadas"],
  ["ANATEL", "Agência federal", "connected", "Dados abertos + SEI", "Consultas, textos públicos e processos administrativos"],
  ["ANVISA", "Agência federal", "connected", "Portal + PDF", "Dicol, votos, reuniões e documentos técnicos"],
  ["DOU", "Diário Oficial", "connected", "INLABS XML/ZIP", "Nomeações, exonerações, portarias e resoluções"],
  ["Receita Federal", "CNPJ", "connected", "CSV público", "Cadastro, CNAE, QSA, situação e endereços fiscais"],
  ["JUCESP / REDESIM", "Societário", "pending", "API/bureau", "Alterações contratuais e histórico societário"],
  ["CGU", "Transparência", "connected", "API REST", "CEIS, CNEP, servidores, sanções e acordos"],
  ["CNJ DataJud", "Judicial", "connected", "API pública", "Metadados de processos judiciais e movimentações"],
  ["PGFN", "Dívida ativa", "connected", "CSV aberto", "Dívida ativa da União e FGTS"],
  ["PNCP", "Contratos", "connected", "API/portal", "Contratações públicas, atas e fornecedores"],
  ["CVM", "Mercado", "connected", "Dados abertos", "Companhias abertas, FRE e fatos relevantes"],
  ["Senado", "Nomeações", "connected", "Dados abertos", "Sabatinas e aprovações de diretores"],
  ["Cartórios RI", "Patrimonial", "pending", "Bureau licenciado", "Matrículas, imóveis e atos registrais"],
  ["Detran", "Patrimonial", "pending", "Bureau licenciado", "Veículos e vínculos patrimoniais permitidos"],
  ["OSINT reputacional", "Fontes abertas", "error", "Coleta assistida", "Redes, reputação, domínios e perfis públicos"]
];

const targets = [
  {
    id: "ecovias",
    type: "company",
    name: "Ecovias dos Imigrantes S.A.",
    subtitle: "CNPJ 02.509.491/0001-26 · Concessão rodoviária",
    tags: ["ARTESP", "Concessão", "Multas"],
    summary:
      "Empresa regulada com histórico de penalidades, reequilíbrio econômico-financeiro e obrigações contratuais. O valor está em cruzar QSA, deliberações, votos e judicialização.",
    facts: [
      ["Aparições", "18", "Deliberações e atos regulatórios monitorados desde 2023"],
      ["Red flags", "5", "Reincidência, sanção, DataJud, QSA e voto sensível"],
      ["Fonte forte", "ARTESP", "Atas e PDFs com evidência citável"],
      ["Padrão", "Dosimetria", "Discussões recorrentes sobre redução/manutenção de multa"]
    ],
    graph: {
      nodes: [
        ["Ecovias", "company", 450, 250],
        ["ARTESP", "agency", 210, 120],
        ["Diretor Técnico", "person", 700, 120],
        ["Deliberação 04/2025", "case", 705, 360],
        ["QSA / Grupo", "company", 220, 375],
        ["CEIS/CNEP", "risk", 450, 80],
        ["DataJud", "risk", 455, 430]
      ],
      edges: [
        [0, 1, "regulada por"],
        [2, 3, "diretor votou em"],
        [0, 3, "empresa afetada por deliberação"],
        [0, 4, "sócio de / grupo econômico"],
        [0, 5, "aparece em sanção"],
        [0, 6, "possui processo judicial"],
        [1, 3, "agência publicou"]
      ]
    },
    redFlags: [
      ["high", "Reincidência regulatória", "A empresa aparece em 18 atos e 6 tratam de sanção ou obrigação descumprida."],
      ["medium", "Diretor com padrão favorável", "Em casos similares, um diretor aceitou dosimetria quando havia prova técnica robusta."],
      ["medium", "Judicialização relacionada", "Metadados DataJud sugerem disputa vinculada ao contrato de concessão."],
      ["low", "Mudança societária", "QSA deve ser revalidado antes de dossiês comerciais."]
    ],
    timeline: [
      ["2026-05-12", "Recurso administrativo em penalidade", "Deliberação classificada como sanção com impacto financeiro potencial."],
      ["2026-04-18", "Consulta DataJud vinculada", "Processo judicial público associado ao contrato de concessão."],
      ["2026-03-05", "QSA revisado", "Base CNPJ atualizada para checagem de grupo econômico."],
      ["2025-11-21", "Voto divergente", "Divergência sobre gradação de penalidade em caso similar."]
    ],
    evidence: [
      ["ARTESP", "PDF de deliberação", "2026-05-12", "Processo e resultado extraídos do documento original", 94],
      ["Receita Federal", "Base CNPJ", "2026-05-01", "Situação cadastral, CNAE e QSA", 91],
      ["CNJ DataJud", "Metadados processuais", "2026-04-18", "Classe e movimentações públicas", 78],
      ["CGU", "CEIS/CNEP", "2026-04-02", "Checagem de sanções administrativas", 82]
    ],
    dossier:
      "Resumo executivo: Ecovias é um alvo regulatório recorrente na ARTESP, com concentração em temas sancionatórios. As conexões prioritárias são deliberações, votos de diretores, QSA e judicialização. Próximo passo: comparar casos de dosimetria por relator e composição da diretoria."
  },
  {
    id: "director-artesp",
    type: "person",
    name: "Diretor de Regulação da ARTESP",
    subtitle: "Mandato regulatório · Transporte e infraestrutura",
    tags: ["Diretor", "Votos", "ARTESP"],
    summary:
      "Perfil decisório consolidado por votos, relatorias, nomeação, divergências e temas recorrentes. Ideal para prever sensibilidade a argumentos jurídicos e técnicos.",
    facts: [
      ["Votos", "42", "Votos extraídos de atas e deliberações"],
      ["Divergências", "6", "Casos em desacordo com maioria colegiada"],
      ["Tema forte", "Sanções", "Maior previsibilidade em penalidades"],
      ["Conflito", "Baixo", "Sem vínculo societário público forte no dataset demo"]
    ],
    graph: {
      nodes: [
        ["Diretor", "person", 450, 250],
        ["ARTESP", "agency", 210, 120],
        ["Voto 18/2026", "case", 700, 125],
        ["Ecovias", "company", 700, 370],
        ["DOU", "agency", 210, 380],
        ["Senado", "agency", 450, 75],
        ["Divergência", "risk", 450, 430]
      ],
      edges: [
        [0, 1, "cargo em"],
        [0, 2, "diretor votou em"],
        [2, 3, "empresa afetada por deliberação"],
        [4, 0, "citado em DOU"],
        [5, 0, "sabatina / indicação"],
        [0, 6, "padrão decisório divergente"],
        [1, 2, "agência publicou"]
      ]
    },
    redFlags: [
      ["medium", "Padrão de dosimetria", "Tende a aceitar redução de multa quando o processo traz prova técnica detalhada."],
      ["low", "Nomeação recente", "Mudança de composição colegiada pode alterar precedentes internos."],
      ["medium", "Divergência temática", "Maior divergência em reequilíbrio e penalidades contratuais."]
    ],
    timeline: [
      ["2026-05-10", "Voto em penalidade", "Fundamento principal: reincidência e obrigação contratual."],
      ["2026-02-03", "Relatoria em reajuste", "Decisão condicionada a prova econômico-financeira."],
      ["2025-08-14", "Nomeação rastreada", "Ato oficial monitorado em DOU/DOE."],
      ["2025-06-29", "Primeira divergência capturada", "Divergência sobre rito e extensão da sanção."]
    ],
    evidence: [
      ["ARTESP", "Ata de reunião", "2026-05-10", "Voto e justificativa capturados", 88],
      ["DOU", "Ato de nomeação", "2025-08-14", "Ciclo de vida do mandato", 96],
      ["Senado", "Sabatina", "2025-07-21", "Histórico e compromisso público", 79]
    ],
    dossier:
      "Resumo executivo: o diretor tem padrão moderado-rigoroso em sanções, com abertura para dosimetria quando há prova técnica. Para advocacia regulatória, o ponto crítico é preparar precedentes e documentação econômico-financeira antes da deliberação."
  },
  {
    id: "aneel",
    type: "agency",
    name: "ANEEL",
    subtitle: "Agência Nacional de Energia Elétrica · CKAN prioritário",
    tags: ["CKAN", "Atas", "Pautas"],
    summary:
      "Fonte federal prioritária para provar o pipeline de ingestão com dados abertos estruturados, pautas, atas e matérias deliberadas.",
    facts: [
      ["Status", "Conectável", "CKAN e PDFs públicos"],
      ["Uso MVP", "Alto", "Boa previsibilidade de ingestão"],
      ["Alertas", "Pauta/ata", "Monitoramento antes e depois das reuniões"],
      ["Temas", "Energia", "Tarifa, fiscalização, concessão e sanção"]
    ],
    graph: {
      nodes: [
        ["ANEEL", "agency", 450, 250],
        ["Pauta", "case", 210, 125],
        ["Ata", "case", 210, 375],
        ["Diretoria", "person", 700, 125],
        ["Empresa regulada", "company", 700, 375],
        ["DOU", "agency", 450, 80],
        ["CVM", "risk", 450, 430]
      ],
      edges: [
        [0, 1, "agência publicou"],
        [0, 2, "agência publicou"],
        [3, 2, "diretor votou em"],
        [4, 2, "empresa afetada por deliberação"],
        [5, 0, "citado em DOU"],
        [4, 6, "companhia aberta / documentos"],
        [1, 4, "pauta antecipa alvo"]
      ]
    },
    redFlags: [
      ["low", "Fonte estruturada", "Baixo risco de coleta, alto valor para alertas preventivos."],
      ["medium", "Empresa em pauta", "Pauta publicada antes da ata pode gerar alerta comercial antecipado."]
    ],
    timeline: [
      ["2026-05-19", "Fonte priorizada", "CKAN escolhido para ingestão inicial federal."],
      ["2026-05-18", "Campos mapeados", "Pauta, ata, data, assunto e documentos relacionados."],
      ["2026-05-15", "Classificação temática", "Tarifa, autorização, fiscalização, sanção e concessão."],
      ["2026-05-12", "Plano de alerta", "Monitoramento de pauta antes da deliberação."]
    ],
    evidence: [
      ["ANEEL", "CKAN", "2026-05-19", "Dataset de reuniões públicas", 93],
      ["DOU", "Atos normativos", "2026-05-16", "Resoluções e portarias relacionadas", 87],
      ["CVM", "Dados abertos", "2026-05-12", "Documentos de companhias abertas reguladas", 76]
    ],
    dossier:
      "Resumo executivo: ANEEL é a melhor fonte federal para demonstrar ingestão automatizada e alertas preventivos. O primeiro valor comercial está em apontar empresas em pauta antes da decisão e comparar o resultado com precedentes."
  },
  {
    id: "delib-artesp-04",
    type: "case",
    name: "Deliberação ARTESP nº 04/2025",
    subtitle: "SEI 134.00048923/2025-48 · PDF público",
    tags: ["ARTESP", "SEI", "Governança"],
    summary:
      "Documento de governança interna. Mostra que o LINCE diferencia atos institucionais de casos com empresa afetada, sem forçar falso dossiê empresarial.",
    facts: [
      ["Tipo", "Governança", "Sem empresa regulada no exemplo"],
      ["Extração", "Alta", "Processo SEI e órgão identificados"],
      ["Valor", "Composição", "Atualiza estrutura decisória da agência"],
      ["Uso", "Pipeline", "Bom caso de validação de PDF/OCR"]
    ],
    graph: {
      nodes: [
        ["Deliberação 04", "case", 450, 250],
        ["ARTESP", "agency", 210, 125],
        ["SEI", "agency", 210, 375],
        ["Diretoria", "person", 700, 125],
        ["Cargo interno", "case", 700, 375],
        ["Documento PDF", "risk", 450, 80]
      ],
      edges: [
        [0, 1, "agência publicou"],
        [0, 2, "processo administrativo"],
        [3, 0, "diretor votou em"],
        [0, 4, "objeto interno"],
        [5, 0, "evidência citável"],
        [1, 3, "composição"]
      ]
    },
    redFlags: [
      ["low", "Sem empresa afetada", "Classificado como governança, não como oportunidade comercial empresarial."],
      ["low", "Atualização institucional", "Útil para mapa de cargos e composição decisória."]
    ],
    timeline: [
      ["2025-05-19", "PDF recebido", "Documento usado como amostra do pipeline."],
      ["2025-05-19", "Governança classificada", "Sem concessionária afetada."],
      ["2025-05-19", "Processo SEI extraído", "Identificador mapeado para trilha de auditoria."]
    ],
    evidence: [["ARTESP", "PDF de deliberação", "2025-05-19", "Documento original preservado", 95]],
    dossier:
      "Resumo executivo: a Deliberação ARTESP 04/2025 não gera dossiê empresarial, mas atualiza o mapa institucional da agência e valida o parser de documentos SEI."
  }
];

const deliberations = [
  ["ARTESP 04/2025", "Governança", "Sem empresa", "SEI 134.00048923/2025-48", "Publicado"],
  ["ARTESP 18/2026", "Sanção", "Ecovias", "Processo sancionador", "Voto divergente"],
  ["ANEEL 22/2026", "Tarifa", "Distribuidora Energia Sul", "Reajuste tarifário", "Em pauta"],
  ["ANATEL 09/2026", "Qualidade", "Telecom Brasil", "Indicadores de serviço", "Consulta aberta"]
];

const votes = [
  ["Diretor de Regulação", "Sanções", "Mantém multa", "Rigor moderado", "88%"],
  ["Diretora Econômica", "Tarifa", "Condiciona reajuste", "Técnico-contábil", "82%"],
  ["Conselheiro Relator", "Concessão", "Acompanha área técnica", "Pró-agência", "91%"],
  ["Diretor Técnico", "Fiscalização", "Reduz penalidade", "Dosimetria", "76%"],
  ["Diretoria Colegiada", "Governança", "Unânime", "Baixo risco", "94%"],
  ["Diretor Substituto", "Autorização", "Pede vista", "Incerteza", "69%"]
];

const liveFeed = [
  ["DOU", "Nova portaria localizada", "Ato normativo cita agência reguladora e deve alimentar alertas de monitoramento."],
  ["ARTESP", "Ata publicada", "Novo PDF disponível para extração de deliberações e votos."],
  ["Receita Federal", "QSA atualizado", "Base mensal pronta para recálculo de grupos econômicos."],
  ["CGU", "CEIS/CNEP sincronizado", "Sanções administrativas reprocessadas para empresas monitoradas."]
];

const state = {
  module: "overview",
  selectedTargetId: "ecovias",
  query: "",
  filter: "all",
  detailTab: "graph",
  reviewedAlerts: 0
};

const moduleLabels = {
  overview: ["Inteligência operacional", "Overview"],
  investigate: ["Investigação regulatória", "Investigar alvo"],
  companies: ["Quem é a empresa", "Empresas"],
  directors: ["Como a pessoa decide", "Diretores"],
  deliberations: ["Documentos e processos", "Deliberações"],
  votes: ["Tendência decisória", "Votos"],
  sources: ["Conexões de dados", "Fontes"],
  redflags: ["Achados automáticos", "Red Flags"],
  dossiers: ["Relatórios comerciais", "Dossiês"],
  alerts: ["Monitoramento contínuo", "Alertas"]
};

const typeLabels = {
  company: "Empresa",
  person: "Diretor",
  agency: "Agência",
  case: "Deliberação"
};

const $ = (selector) => document.querySelector(selector);

function normalize(value) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function selectedTarget() {
  return targets.find((target) => target.id === state.selectedTargetId) || targets[0];
}

function filteredTargets() {
  const query = normalize(state.query.trim());
  return targets.filter((target) => {
    const matchesFilter = state.filter === "all" || target.type === state.filter;
    const haystack = normalize([target.name, target.subtitle, target.summary, target.tags.join(" ")].join(" "));
    return matchesFilter && (!query || haystack.includes(query));
  });
}

function setModule(module) {
  state.module = module;
  document.querySelectorAll(".module-view").forEach((view) => {
    view.classList.toggle("active", view.id === `view-${module}`);
  });
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.module === module);
  });
  const [kicker, title] = moduleLabels[module];
  $("#module-kicker").textContent = kicker;
  $("#module-title").textContent = title;
}

function renderMetrics() {
  $("#metric-investigations").textContent = "24";
  $("#metric-redflags").textContent = "31";
  $("#metric-votes").textContent = "312";
  $("#metric-sources").textContent = "52";
}

function renderTargets() {
  const list = filteredTargets();
  $("#result-count").textContent = `${list.length} ${list.length === 1 ? "item" : "itens"}`;
  $("#target-list").innerHTML = list
    .map(
      (target) => `
        <button class="target-card ${target.id === state.selectedTargetId ? "active" : ""}" type="button" data-target="${target.id}">
          <span class="card-kicker">${typeLabels[target.type]}</span>
          <strong>${target.name}</strong>
          <p>${target.subtitle}</p>
          <div class="tag-row">${target.tags.map((tag) => `<span class="tag">${tag}</span>`).join("")}</div>
        </button>
      `
    )
    .join("");
}

function renderSelectedTarget() {
  const target = selectedTarget();
  $("#focus-name").textContent = target.name;
  $("#target-title").textContent = target.name;
  $("#target-summary").textContent = target.summary;

  $("#target-facts").innerHTML = target.facts
    .map(
      ([label, value, description]) => `
        <article class="fact-card">
          <span>${label}</span>
          <strong>${value}</strong>
          <p>${description}</p>
        </article>
      `
    )
    .join("");

  const flags = target.redFlags
    .map(
      ([severity, title, description]) => `
        <article class="flag-card ${severity}">
          <span class="severity-chip ${severity}">${severity}</span>
          <strong>${title}</strong>
          <p>${description}</p>
        </article>
      `
    )
    .join("");
  $("#focus-redflags").innerHTML = flags;

  renderGraph("#connection-graph", target.graph, 900, 500);
  renderGraph("#overview-graph", target.graph, 780, 430);

  $("#timeline-list").innerHTML = target.timeline
    .map(
      ([date, title, description]) => `
        <li>
          <time datetime="${date}">${new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium" }).format(new Date(`${date}T12:00:00`))}</time>
          <strong>${title}</strong>
          <p>${description}</p>
        </li>
      `
    )
    .join("");

  $("#evidence-list").innerHTML = target.evidence
    .map(
      ([source, type, date, description, confidence]) => `
        <article class="evidence-card">
          <span class="card-kicker">${source} · ${type} · ${date}</span>
          <strong>${description}</strong>
          <div class="confidence-bar" aria-label="Confiança ${confidence}%"><i style="width:${confidence}%"></i></div>
          <p>Confiança da extração: ${confidence}%</p>
        </article>
      `
    )
    .join("");

  renderTargets();
}

function renderGraph(selector, graph, width = 900, height = 500) {
  const svg = $(selector);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const edgeSvg = graph.edges
    .map(([from, to, label]) => {
      const a = graph.nodes[from];
      const b = graph.nodes[to];
      const midX = (a[2] + b[2]) / 2;
      const midY = (a[3] + b[3]) / 2;
      return `
        <line class="graph-edge" x1="${a[2]}" y1="${a[3]}" x2="${b[2]}" y2="${b[3]}"></line>
        <text class="graph-edge-label" x="${midX}" y="${midY - 9}" text-anchor="middle">${label}</text>
      `;
    })
    .join("");
  const nodeSvg = graph.nodes
    .map(
      ([label, type, x, y]) => `
        <g class="graph-node ${type}" transform="translate(${x} ${y})">
          <circle r="48"></circle>
          <text text-anchor="middle" y="-3">${label.split(" ").slice(0, 2).join(" ")}</text>
          <text text-anchor="middle" y="14">${label.split(" ").slice(2).join(" ")}</text>
        </g>
      `
    )
    .join("");
  svg.innerHTML = `${edgeSvg}${nodeSvg}`;
}

function renderLiveFeed() {
  $("#live-feed").innerHTML = liveFeed
    .map(
      ([source, title, description]) => `
        <article class="feed-item">
          <span class="card-kicker">${source}</span>
          <strong>${title}</strong>
          <p>${description}</p>
        </article>
      `
    )
    .join("");
}

function renderCompanies() {
  const companies = targets.filter((target) => target.type === "company");
  $("#company-table").innerHTML = companies
    .map(
      (company) => `
        <article class="table-row">
          <strong>${company.name}</strong>
          <span>${company.subtitle}</span>
          <span>${company.redFlags.length} red flags</span>
          <button class="ghost-button" type="button" data-open-target="${company.id}">Investigar</button>
        </article>
      `
    )
    .join("");
  $("#company-context").innerHTML = [
    ["Receita Federal", "CNPJ, CNAE, situação cadastral, QSA e endereço fiscal."],
    ["JUCESP / REDESIM", "Alterações contratuais e histórico societário para grupo econômico provável."],
    ["CGU / PGFN / DataJud", "Sanções, dívida ativa e judicialização pública em um mesmo dossiê."],
    ["Agências reguladoras", "Aparições em deliberações, votos, recursos e consultas públicas."]
  ]
    .map(([title, description]) => `<article class="context-card"><h3>${title}</h3><p>${description}</p></article>`)
    .join("");
}

function renderDirectors() {
  const people = targets.filter((target) => target.type === "person");
  $("#director-list").innerHTML = people
    .map(
      (person) => `
        <article class="record-card">
          <span class="card-kicker">${person.subtitle}</span>
          <strong>${person.name}</strong>
          <p>${person.summary}</p>
          <div class="tag-row">${person.tags.map((tag) => `<span class="tag">${tag}</span>`).join("")}</div>
        </article>
      `
    )
    .join("");
  $("#director-matrix").innerHTML = [
    ["Sanções", "Mantém penalidades em casos de reincidência, mas aceita dosimetria com prova técnica."],
    ["Tarifas", "Condiciona reajuste à qualidade da documentação econômico-financeira."],
    ["Concessões", "Segue precedentes quando há parecer técnico robusto."],
    ["Governança", "Baixo nível de divergência em atos internos."]
  ]
    .map(([theme, detail]) => `<article class="matrix-card"><span>${theme}</span><h3>${detail}</h3></article>`)
    .join("");
}

function renderDeliberations() {
  $("#deliberation-table").innerHTML = deliberations
    .map(
      ([number, theme, company, process, status]) => `
        <article class="table-row">
          <strong>${number}</strong>
          <span>${theme}</span>
          <span>${company}</span>
          <span>${process}</span>
          <span class="status-chip ${status === "Em pauta" ? "pending" : "connected"}">${status}</span>
        </article>
      `
    )
    .join("");
}

function renderVotes() {
  $("#vote-grid").innerHTML = votes
    .map(
      ([director, theme, direction, tendency, confidence]) => `
        <article class="vote-card">
          <span>${theme} · confiança ${confidence}</span>
          <h3>${director}</h3>
          <p>${direction}</p>
          <div class="tag-row"><span class="tag">${tendency}</span></div>
        </article>
      `
    )
    .join("");
}

function renderSources() {
  $("#source-grid").innerHTML = sources
    .map(
      ([name, group, status, method, description]) => `
        <article class="source-card">
          <span>${group} · ${method}</span>
          <h3>${name}</h3>
          <p>${description}</p>
          <span class="status-chip ${status}">${status}</span>
        </article>
      `
    )
    .join("");
}

function allRedFlags() {
  return targets.flatMap((target) =>
    target.redFlags.map(([severity, title, description]) => ({
      target: target.name,
      severity,
      title,
      description
    }))
  );
}

function renderRedFlags() {
  $("#redflag-board").innerHTML = allRedFlags()
    .map(
      (flag) => `
        <article class="flag-card ${flag.severity}">
          <span class="severity-chip ${flag.severity}">${flag.severity}</span>
          <strong>${flag.title}</strong>
          <p>${flag.description}</p>
          <p class="card-kicker">${flag.target}</p>
        </article>
      `
    )
    .join("");
}

function renderDossiers() {
  $("#dossier-list").innerHTML = targets
    .map(
      (target) => `
        <article class="dossier-card">
          <span class="card-kicker">${typeLabels[target.type]} · ${target.tags.join(" · ")}</span>
          <strong>${target.name}</strong>
          <p>${target.dossier}</p>
        </article>
      `
    )
    .join("");
}

function renderAlerts() {
  const alerts = [
    ["high", "Nova deliberação com empresa monitorada", "ARTESP publicou documento envolvendo alvo com histórico sancionatório."],
    ["medium", "Pauta regulatória antecipada", "ANEEL adicionou matéria com empresa do setor elétrico monitorada."],
    ["medium", "Atualização de QSA", "Receita Federal alterou dados societários de empresa investigada."],
    ["low", "Nomeação rastreada", "DOU publicou ato que altera composição de diretoria regulatória."]
  ];
  $("#alert-list").innerHTML = alerts
    .map(
      ([severity, title, description], index) => `
        <article class="alert-card">
          <span class="severity-chip ${severity}">${severity}</span>
          <strong>${title}</strong>
          <p>${description}</p>
          <p class="card-kicker">${index < state.reviewedAlerts ? "Revisado" : "Pendente"}</p>
        </article>
      `
    )
    .join("");
}

function setDetailTab(tab) {
  state.detailTab = tab;
  document.querySelectorAll("[data-detail-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.detailTab === tab);
  });
  document.querySelectorAll(".detail-view").forEach((view) => {
    view.classList.toggle("active", view.id === `detail-${tab}`);
  });
}

function generateDossier() {
  const target = selectedTarget();
  $("#dossier-output").classList.add("ready");
  $("#dossier-output").innerHTML = `
    <h3>Dossiê gerado por Codex</h3>
    <p>${target.dossier}</p>
    <div class="tag-row">
      <span class="tag">Resumo executivo</span>
      <span class="tag">Red flags</span>
      <span class="tag">Evidências citáveis</span>
      <span class="tag">Padrão decisório</span>
    </div>
  `;
  setModule("investigate");
}

function wireEvents() {
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.addEventListener("click", () => setModule(button.dataset.module));
  });
  document.querySelectorAll("[data-module-jump]").forEach((button) => {
    button.addEventListener("click", () => setModule(button.dataset.moduleJump));
  });
  $("#global-search").addEventListener("input", (event) => {
    state.query = event.target.value;
    renderTargets();
    setModule("investigate");
  });
  $("#clear-search").addEventListener("click", () => {
    state.query = "";
    $("#global-search").value = "";
    renderTargets();
  });
  document.querySelectorAll("[data-type]").forEach((button) => {
    button.addEventListener("click", () => {
      state.filter = button.dataset.type;
      document.querySelectorAll("[data-type]").forEach((chip) => chip.classList.toggle("active", chip === button));
      renderTargets();
    });
  });
  $("#target-list").addEventListener("click", (event) => {
    const card = event.target.closest("[data-target]");
    if (!card) return;
    state.selectedTargetId = card.dataset.target;
    renderSelectedTarget();
  });
  document.body.addEventListener("click", (event) => {
    const openTarget = event.target.closest("[data-open-target]");
    if (!openTarget) return;
    state.selectedTargetId = openTarget.dataset.openTarget;
    renderSelectedTarget();
    setModule("investigate");
  });
  document.querySelectorAll("[data-detail-tab]").forEach((button) => {
    button.addEventListener("click", () => setDetailTab(button.dataset.detailTab));
  });
  $("#generate-dossier").addEventListener("click", generateDossier);
  $("#generate-dossier-secondary").addEventListener("click", generateDossier);
  $("#mark-reviewed").addEventListener("click", () => {
    state.reviewedAlerts = Math.min(state.reviewedAlerts + 1, 4);
    renderAlerts();
    setModule("alerts");
  });
}

function init() {
  renderMetrics();
  renderTargets();
  renderSelectedTarget();
  renderLiveFeed();
  renderCompanies();
  renderDirectors();
  renderDeliberations();
  renderVotes();
  renderSources();
  renderRedFlags();
  renderDossiers();
  renderAlerts();
  wireEvents();
}

init();
