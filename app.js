const sources = [
  {
    name: "ARTESP",
    kind: "Scraping + PDF",
    cadence: "Semanal",
    description: "Pautas, atas e deliberações da diretoria colegiada estadual.",
    url: "https://www.artesp.sp.gov.br/artesp/transparencia/reunioes-diretoria/"
  },
  {
    name: "ANEEL",
    kind: "CKAN / CSV / PDF",
    cadence: "Por reunião",
    description: "Pautas e atas públicas da diretoria com dados estruturados em CKAN.",
    url: "https://dadosabertos.aneel.gov.br/"
  },
  {
    name: "ANATEL",
    kind: "Dados abertos + SEI",
    cadence: "Diária",
    description: "Textos públicos, consultas e documentos do SEI em formato aberto.",
    url: "https://www.gov.br/anatel/pt-br/dados/dados-abertos"
  },
  {
    name: "ANVISA",
    kind: "Portal + PDF",
    cadence: "Por reunião",
    description: "Atas, votos, reuniões públicas e documentos da Diretoria Colegiada.",
    url: "https://www.gov.br/anvisa/pt-br/composicao/diretoria-colegiada"
  },
  {
    name: "DOU",
    kind: "XML / ZIP",
    cadence: "Diária",
    description: "Nomeações, exonerações, portarias, consultas públicas e atos normativos.",
    url: "https://github.com/Imprensa-Nacional/inlabs"
  },
  {
    name: "Receita Federal",
    kind: "CSV público",
    cadence: "Mensal",
    description: "CNPJ, estabelecimentos, CNAE, porte, capital social e QSA.",
    url: "https://www.gov.br/receitafederal/pt-br/assuntos/orientacao-tributaria/cadastros/cnpj"
  },
  {
    name: "CGU",
    kind: "API REST",
    cadence: "Diária / mensal",
    description: "Portal da Transparência, servidores, CEIS, CNEP e acordos de leniência.",
    url: "https://api.portaldatransparencia.gov.br/swagger-ui/index.html"
  },
  {
    name: "CNJ DataJud",
    kind: "API Elasticsearch",
    cadence: "Contínua",
    description: "Metadados de processos judiciais públicos e movimentações.",
    url: "https://www.cnj.jus.br/sistemas/datajud/api-publica/"
  },
  {
    name: "PGFN",
    kind: "CSV",
    cadence: "Trimestral",
    description: "Dívida ativa da União e FGTS por devedor e corresponsável.",
    url: "https://www.gov.br/pgfn/pt-br/assuntos/divida-ativa-da-uniao/transparencia-fiscal-1/dados-abertos"
  },
  {
    name: "PNCP",
    kind: "API / Portal",
    cadence: "Diária",
    description: "Contratos, editais, atas e fornecedores de contratações públicas.",
    url: "https://www.gov.br/pncp"
  },
  {
    name: "CVM",
    kind: "CKAN / ZIP",
    cadence: "Semanal",
    description: "Companhias abertas, documentos eventuais, FRE e governança.",
    url: "https://dados.cvm.gov.br/"
  },
  {
    name: "Senado",
    kind: "Dados abertos",
    cadence: "Por indicação",
    description: "Sabatinas, indicações e aprovação de diretores de agências.",
    url: "https://www12.senado.leg.br/dados-abertos/dados-abertos"
  }
];

const entities = [
  {
    id: "company-ecovias",
    type: "company",
    name: "Ecovias dos Imigrantes S.A.",
    subtitle: "CNPJ 02.509.491/0001-26 · Concessão rodoviária",
    tags: ["ARTESP", "Concessão", "Multas"],
    risk: "high",
    riskLabel: "Risco alto",
    summary:
      "Empresa regulada com histórico de deliberações sobre equilíbrio econômico-financeiro, penalidades e obrigações contratuais.",
    insights: [
      ["Aparições", "18", "Deliberações e atos regulatórios monitorados desde 2023."],
      ["Tema dominante", "Penalidade", "Multas, recursos administrativos e obrigações de serviço."],
      ["Diretor sensível", "Diretor Técnico", "Maior divergência em dosimetria de sanções."],
      ["QSA", "Grupo concessionário", "Relações societárias tratadas como dado contextual."],
      ["Sanções", "2 sinais", "Checagem prevista em CEIS/CNEP e bases da própria agência."],
      ["Judicialização", "5 processos", "Metadados públicos vinculáveis via DataJud."]
    ],
    analysis:
      "O padrão de risco está no cruzamento entre reincidência regulatória e decisões com redução ou manutenção de penalidades. O dossiê deve priorizar histórico de casos similares, votos divergentes e fundamentos usados pela diretoria.",
    dossier:
      "Dossiê preliminar: Ecovias aparece como alvo regulatório recorrente em temas de penalidade e reequilíbrio. A análise recomenda comparar decisões por tipo de infração, relator e composição da diretoria, mantendo evidência documental para cada conclusão.",
    timeline: [
      ["2026-05-12", "Deliberação sobre recurso administrativo", "Caso classificado como sanção com possível impacto financeiro."],
      ["2026-04-18", "Consulta em DataJud", "Metadados públicos indicam judicialização relacionada a contrato de concessão."],
      ["2026-03-05", "Atualização de QSA", "Base CNPJ revisada para checagem de vínculos societários."],
      ["2025-11-21", "Voto divergente identificado", "Divergência sobre gradação de penalidade em caso similar."]
    ],
    evidence: ["ARTESP", "Receita Federal", "CGU", "CNJ DataJud", "PNCP"],
    graph: {
      nodes: [
        ["Ecovias", "company", 380, 210],
        ["ARTESP", "agency", 190, 115],
        ["Diretor Técnico", "person", 580, 120],
        ["Deliberação 04/2025", "case", 575, 315],
        ["QSA", "company", 210, 320]
      ],
      edges: [
        [0, 1, "regulada por"],
        [0, 3, "empresa afetada"],
        [2, 3, "voto"],
        [0, 4, "vínculo societário"],
        [1, 3, "publicou"]
      ]
    }
  },
  {
    id: "person-diretor-artesp",
    type: "person",
    name: "Diretor de Regulação da ARTESP",
    subtitle: "Mandato regulatório · Transporte e infraestrutura",
    tags: ["Diretor", "ARTESP", "Votos"],
    risk: "medium",
    riskLabel: "Risco médio",
    summary:
      "Perfil decisório consolidado por votos, relatorias, temas recorrentes e histórico público de nomeação.",
    insights: [
      ["Votos mapeados", "42", "Votos extraídos de atas e deliberações públicas."],
      ["Tendência", "Rigor moderado", "Mantém penalidades, mas aceita dosimetria em casos documentados."],
      ["Temas", "Tarifa e sanção", "Maior concentração em contratos de concessão."],
      ["Nomeação", "DOU / DOE", "Ciclo de vida do cargo rastreado por atos oficiais."],
      ["Divergências", "6", "Votos em desacordo com a maioria colegiada."],
      ["Conflitos", "Sem alerta forte", "Sem vínculo societário público detectado no dataset de demo."]
    ],
    analysis:
      "O diretor tende a sustentar decisões técnicas quando há documentação robusta da área instrutória. A inteligência útil para escritórios está em prever a sensibilidade a argumentos de dosimetria, precedente administrativo e qualidade da prova.",
    dossier:
      "Dossiê preliminar: o diretor apresenta padrão decisório mais previsível em temas sancionatórios do que em reequilíbrio. Casos com parecer técnico consistente recebem maior aderência ao voto do relator.",
    timeline: [
      ["2026-05-10", "Voto em penalidade de concessionária", "Fundamento principal: reincidência e obrigação contratual."],
      ["2026-02-03", "Relatoria em caso de reajuste", "Decisão condicionada a documentação econômico-financeira."],
      ["2025-08-14", "Sabatina e nomeação monitoradas", "Perfil público associado a infraestrutura regulada."],
      ["2025-06-29", "Primeira divergência capturada", "Divergência sobre rito e extensão da sanção."]
    ],
    evidence: ["ARTESP", "DOU", "Senado", "Portal da Transparência"],
    graph: {
      nodes: [
        ["Diretor", "person", 380, 210],
        ["ARTESP", "agency", 190, 115],
        ["Voto 18/2026", "case", 575, 130],
        ["Ecovias", "company", 585, 315],
        ["DOU", "agency", 205, 320]
      ],
      edges: [
        [0, 1, "cargo"],
        [0, 2, "votou"],
        [2, 3, "empresa afetada"],
        [4, 0, "nomeação"],
        [1, 2, "deliberação"]
      ]
    }
  },
  {
    id: "agency-aneel",
    type: "agency",
    name: "ANEEL",
    subtitle: "Agência Nacional de Energia Elétrica · CKAN prioritário",
    tags: ["CKAN", "Atas", "Pautas"],
    risk: "low",
    riskLabel: "Risco baixo",
    summary:
      "Fonte inicial ideal para o MVP por possuir dados abertos estruturados sobre pautas e atas de reuniões públicas.",
    insights: [
      ["Dataset", "Pautas e atas", "Dados disponíveis em CSV/PDF via portal CKAN."],
      ["Prioridade", "MVP 1", "Alta previsibilidade para ingestão automatizada."],
      ["Documentos", "Reuniões públicas", "Pauta, ata, data, local e matérias deliberadas."],
      ["Conexões", "Empresas de energia", "Possível vínculo com CVM, CNPJ, PGFN e DataJud."],
      ["IA", "Classificação temática", "Tarifa, autorização, fiscalização, sanção e concessão."],
      ["Alertas", "Por reunião", "Nova pauta antes da deliberação e ata após reunião."]
    ],
    analysis:
      "A ANEEL deve ser a primeira fonte federal estruturada porque reduz custo de ingestão e permite treinar o fluxo completo: coleta, normalização, entidades, deliberação, voto, evidência e alerta.",
    dossier:
      "Dossiê preliminar: a ANEEL é fonte âncora para provar o motor de dados regulatórios. A implementação deve começar pelo CKAN, depois PDFs de atas e classificação dos temas deliberados.",
    timeline: [
      ["2026-05-19", "Fonte priorizada no roadmap", "CKAN escolhido para ingestão inicial do MVP."],
      ["2026-05-18", "Mapeamento de campos", "Pauta, ata, data, local e documentos relacionados."],
      ["2026-05-15", "Modelo de classificação", "Temas regulatórios definidos para energia elétrica."],
      ["2026-05-12", "Plano de alerta", "Monitoramento de pauta e publicação de ata."]
    ],
    evidence: ["ANEEL", "Receita Federal", "CVM", "DOU"],
    graph: {
      nodes: [
        ["ANEEL", "agency", 380, 210],
        ["Pauta", "case", 180, 125],
        ["Ata", "case", 180, 315],
        ["Diretoria", "person", 575, 120],
        ["Empresa regulada", "company", 590, 315]
      ],
      edges: [
        [0, 1, "publica"],
        [0, 2, "publica"],
        [3, 2, "votos"],
        [4, 2, "afetada"],
        [1, 4, "antecede"]
      ]
    }
  },
  {
    id: "case-artesp-04",
    type: "case",
    name: "Deliberação ARTESP nº 04/2025",
    subtitle: "SEI 134.00048923/2025-48 · Documento público em PDF",
    tags: ["ARTESP", "SEI", "PDF"],
    risk: "medium",
    riskLabel: "Risco médio",
    summary:
      "Exemplo de documento de deliberação que alimenta o fluxo de extração, classificação e trilha de evidências.",
    insights: [
      ["Documento", "PDF", "Original preservado em storage com hash e URL de origem."],
      ["Extração", "Entidades", "Processo, órgão, cargo, relator e deliberação."],
      ["Empresa", "Não aplicável", "Documento interno sem concessionária afetada no exemplo."],
      ["Classificação", "Governança", "Substituição de cargo e ato administrativo."],
      ["Confiança", "Alta", "Campos determinísticos com baixa ambiguidade."],
      ["Uso", "Treino do pipeline", "Bom caso para validar OCR e parser de SEI."]
    ],
    analysis:
      "Nem toda deliberação terá empresa envolvida. O LINCE deve classificar documentos internos como governança regulatória e separá-los de casos vendáveis para empresas, mantendo valor para mapear composição e dinâmica da agência.",
    dossier:
      "Dossiê preliminar: a deliberação ARTESP 04/2025 não é um caso empresarial, mas é útil para atualizar estrutura decisória, cargos e contexto institucional da agência.",
    timeline: [
      ["2025-05-19", "PDF recebido para análise", "Documento usado como amostra inicial do pipeline."],
      ["2025-05-19", "Classificação de governança", "Sem empresa regulada identificada."],
      ["2025-05-19", "Entidades estruturadas", "Processo SEI e agência extraídos do cabeçalho."],
      ["2025-05-19", "Evidência preservada", "Arquivo original vinculado ao registro de documento."]
    ],
    evidence: ["ARTESP"],
    graph: {
      nodes: [
        ["Deliberação 04", "case", 380, 210],
        ["ARTESP", "agency", 190, 135],
        ["SEI", "agency", 190, 310],
        ["Diretoria", "person", 575, 130],
        ["Cargo interno", "case", 575, 310]
      ],
      edges: [
        [0, 1, "publicada por"],
        [0, 2, "processo"],
        [3, 0, "delibera"],
        [0, 4, "objeto"],
        [1, 3, "compõe"]
      ]
    }
  }
];

const state = {
  query: "",
  filter: "all",
  selectedId: entities[0].id,
  tab: "overview"
};

const labels = {
  company: "Empresa",
  person: "Diretor",
  agency: "Agência",
  case: "Deliberação"
};

const sourceMap = Object.fromEntries(sources.map((source) => [source.name, source]));

const selectors = {
  search: document.querySelector("#global-search"),
  clearSearch: document.querySelector("#clear-search"),
  resultList: document.querySelector("#result-list"),
  resultCount: document.querySelector("#result-count"),
  profileKind: document.querySelector("#profile-kind"),
  profileTitle: document.querySelector("#profile-title"),
  profileSummary: document.querySelector("#profile-summary"),
  profileRisk: document.querySelector("#profile-risk"),
  insightGrid: document.querySelector("#insight-grid"),
  aiAnalysis: document.querySelector("#ai-analysis"),
  aiTitle: document.querySelector("#ai-title"),
  dossierOutput: document.querySelector("#dossier-output"),
  graph: document.querySelector("#connection-graph"),
  timeline: document.querySelector("#timeline-list"),
  evidenceList: document.querySelector("#evidence-list"),
  sourceGrid: document.querySelector("#source-grid"),
  generateDossier: document.querySelector("#generate-dossier")
};

function normalize(value) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function getSelectedEntity() {
  return entities.find((entity) => entity.id === state.selectedId) || entities[0];
}

function getFilteredEntities() {
  const query = normalize(state.query.trim());
  return entities.filter((entity) => {
    const matchesFilter = state.filter === "all" || entity.type === state.filter;
    const haystack = normalize(
      [entity.name, entity.subtitle, entity.summary, entity.tags.join(" ")].join(" ")
    );
    return matchesFilter && (!query || haystack.includes(query));
  });
}

function renderMetrics() {
  document.querySelector("#metric-docs").textContent = "1.248";
  document.querySelector("#metric-votes").textContent = "312";
  document.querySelector("#metric-links").textContent = "4.906";
}

function renderResults() {
  const filtered = getFilteredEntities();
  selectors.resultCount.textContent = `${filtered.length} ${filtered.length === 1 ? "item" : "itens"}`;

  selectors.resultList.innerHTML = filtered
    .map(
      (entity) => `
        <button class="result-card ${entity.id === state.selectedId ? "active" : ""}" data-id="${entity.id}" type="button">
          <strong>${entity.name}</strong>
          <span>${entity.subtitle}</span>
          <span class="tag-row">${entity.tags.map((tag) => `<span class="tag">${tag}</span>`).join("")}</span>
        </button>
      `
    )
    .join("");

  if (!filtered.some((entity) => entity.id === state.selectedId) && filtered[0]) {
    state.selectedId = filtered[0].id;
    renderProfile();
  }
}

function renderProfile() {
  const entity = getSelectedEntity();
  selectors.profileKind.innerHTML = `<span></span>${labels[entity.type]}`;
  selectors.profileTitle.textContent = entity.name;
  selectors.profileSummary.textContent = entity.summary;
  selectors.profileRisk.textContent = entity.riskLabel;
  selectors.profileRisk.className = `risk-badge ${entity.risk}`;

  selectors.insightGrid.innerHTML = entity.insights
    .map(
      ([label, value, description]) => `
        <article class="insight-card">
          <span>${label}</span>
          <strong>${value}</strong>
          <p>${description}</p>
        </article>
      `
    )
    .join("");

  selectors.aiTitle.textContent =
    entity.type === "company"
      ? "Padrão regulatório da empresa"
      : entity.type === "person"
        ? "Padrão decisório do diretor"
        : entity.type === "agency"
          ? "Plano de ingestão da fonte"
          : "Classificação da deliberação";
  selectors.aiAnalysis.textContent = entity.analysis;
  selectors.dossierOutput.classList.remove("visible");
  selectors.dossierOutput.textContent = "";

  renderGraph(entity);
  renderTimeline(entity);
  renderEvidence(entity);
  renderResults();
}

function renderGraph(entity) {
  const { nodes, edges } = entity.graph;
  const edgeSvg = edges
    .map(([from, to, label]) => {
      const a = nodes[from];
      const b = nodes[to];
      const midX = (a[2] + b[2]) / 2;
      const midY = (a[3] + b[3]) / 2;
      return `
        <line class="graph-edge" x1="${a[2]}" y1="${a[3]}" x2="${b[2]}" y2="${b[3]}"></line>
        <text x="${midX}" y="${midY - 8}" text-anchor="middle" fill="#7d766b" font-size="11" font-weight="700">${label}</text>
      `;
    })
    .join("");

  const nodeSvg = nodes
    .map(
      ([label, type, x, y]) => `
        <g class="graph-node ${type}" transform="translate(${x} ${y})">
          <circle r="42"></circle>
          <text y="5" text-anchor="middle">${label}</text>
        </g>
      `
    )
    .join("");

  selectors.graph.innerHTML = `${edgeSvg}${nodeSvg}`;
}

function renderTimeline(entity) {
  selectors.timeline.innerHTML = entity.timeline
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
}

function renderEvidence(entity) {
  selectors.evidenceList.innerHTML = entity.evidence
    .map((name) => {
      const source = sourceMap[name] || { name, kind: "Fonte pública", description: "Fonte vinculada ao dossiê.", url: "#" };
      return `
        <article class="evidence-item">
          <span class="source-meta">${source.kind}</span>
          <a href="${source.url}" target="_blank" rel="noreferrer">${source.name}</a>
          <p>${source.description}</p>
        </article>
      `;
    })
    .join("");
}

function renderSources() {
  selectors.sourceGrid.innerHTML = sources
    .map(
      (source) => `
        <article class="source-card">
          <span class="source-meta">${source.kind} · ${source.cadence}</span>
          <h3>${source.name}</h3>
          <p>${source.description}</p>
          <p><a href="${source.url}" target="_blank" rel="noreferrer">Fonte oficial</a></p>
        </article>
      `
    )
    .join("");
}

function activateTab(tab) {
  state.tab = tab;
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tab);
  });
  document.querySelectorAll(".tab-content").forEach((content) => {
    content.classList.toggle("active", content.id === `tab-${tab}`);
  });
}

function wireEvents() {
  selectors.search.addEventListener("input", (event) => {
    state.query = event.target.value;
    renderResults();
  });

  selectors.clearSearch.addEventListener("click", () => {
    state.query = "";
    selectors.search.value = "";
    renderResults();
  });

  document.querySelectorAll(".filter-chip").forEach((button) => {
    button.addEventListener("click", () => {
      state.filter = button.dataset.filter;
      document.querySelectorAll(".filter-chip").forEach((item) => {
        item.classList.toggle("active", item === button);
      });
      renderResults();
    });
  });

  selectors.resultList.addEventListener("click", (event) => {
    const card = event.target.closest(".result-card");
    if (!card) return;
    state.selectedId = card.dataset.id;
    renderProfile();
  });

  document.querySelectorAll(".tab-button").forEach((button) => {
    button.addEventListener("click", () => activateTab(button.dataset.tab));
  });

  selectors.generateDossier.addEventListener("click", () => {
    const entity = getSelectedEntity();
    selectors.dossierOutput.innerHTML = `
      <strong>Dossiê gerado por Codex</strong>
      <p>${entity.dossier}</p>
      <p>Próxima etapa: anexar trechos citáveis do documento original, score de confiança e fila de revisão humana antes da entrega comercial.</p>
    `;
    selectors.dossierOutput.classList.add("visible");
  });
}

renderMetrics();
renderSources();
renderResults();
renderProfile();
wireEvents();
