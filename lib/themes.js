// M14 - Classificacao por TEMA dos atos regulatorios (habilita o "Mapa de
// Landscape": ex. todas as iniciativas de IA/Governanca de Dados/Ouvidoria nas
// 12 agencias). Determinística (funciona sem IA) e enriquecivel depois.
//
// classifyThemes(title, text) -> string[] (temas casados; um ato pode ter varios)
// Padroes sao substrings SEM acento, minusculas; o texto e normalizado igual.
const { stripAccents } = require("./text");

// Taxonomia: label legivel (usado no front) -> padroes (substring, sem acento).
// Mistura temas TRANSVERSAIS (o que um vendor tipo Salesforce procura) com
// temas SETORIAIS (ajudam o recorte por setor/agencia).
const THEMES = {
  "Inteligência Artificial": ["inteligencia artificial", " ia ", " i a ", "machine learning", "aprendizado de maquina", "governanca de ia"],
  "Governança de Dados / LGPD": ["governanca de dados", "protecao de dados", "lgpd", "dados pessoais", "privacidade", "anpd"],
  "Ouvidoria": ["ouvidoria", "ouvidor", "carta de servicos", "atendimento ao usuario", "manifestacao do usuario"],
  "Consulta / Audiência Pública": ["consulta publica", "audiencia publica", "tomada de subsidio", "analise de impacto regulatorio", "participacao social"],
  "Tarifas / Reajuste": ["tarifa", "reajuste", "revisao tarifaria", "revisao periodica", "cobranca pelo uso"],
  "Concessões / Licitações": ["concessao", "licitacao", "leilao", "edital", "outorga", "permissao", "pregao"],
  "Fiscalização": ["fiscalizacao", "auto de infracao", "processo sancionador", "acao fiscal", "poder de policia"],
  "Sanções / Punições": ["sancao", "multa", "inidonea", "inidoneas", "cnep", "ceis", "cepim", "acordo de leniencia", "declaracao de inidoneidade"],
  "Nomeações / Pessoal": ["nomeacao", "exoneracao", "designacao", "cargo em comissao", "nomear", "exonerar"],
  "Simplificação / Guilhotina Regulatória": ["guilhotina regulatoria", "simplificacao", "revogacao", "desburocratizacao", "estoque normativo", "estoque regulatorio"],
  "Sandbox / Inovação": ["sandbox", "ambiente regulatorio experimental", "inovacao regulatoria"],
  "Orçamento / Contingenciamento": ["contingenciamento", "limitacao de empenho", "dotacao orcamentaria", "autonomia financeira", "movimentacao financeira"],
  "Segurança / Cibersegurança": ["ciberseguranca", "seguranca da informacao", "seguranca cibernetica", "incidente de seguranca"],
  "Meio Ambiente / Sustentabilidade": ["meio ambiente", "ambiental", "sustentabilidade", "licenciamento ambiental", "descarbonizacao", " esg "],
  "Saneamento / Água": ["saneamento", "esgoto", "tarifa social", "abastecimento de agua", "normas de referencia"],
  "Energia / Armazenamento": ["energia eletrica", "armazenamento de energia", "bess", "geracao distribuida", "transmissao", "distribuicao de energia", "renovavel"],
  "Transporte / Infraestrutura": ["rodovia", "ferrovia", "porto", "aeroporto", "hidrovia", "mobilidade", "concessao rodoviaria", "contêiner", "conteiner"],
  "Saúde / Vigilância Sanitária": ["registro sanitario", "medicamento", "vigilancia sanitaria", "plano de saude", "reajuste de planos", "autorizacao de funcionamento"],
  "Telecomunicações": ["telecomunicacoes", "radiofrequencia", "espectro", "banda larga", " 5g ", "fibra optica"],
  "Mineração": ["mineracao", "minerario", "cfem", "lavra", "recurso mineral"]
};

// Normaliza para casamento: sem acento, minusculo, pontuacao -> espaco, colapsa
// espacos, e envolve com espacos (permite padroes com fronteira de palavra).
function normalizeForMatch(value) {
  const base = stripAccents(String(value || ""))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return ` ${base} `;
}

// Retorna a lista de temas cujos padroes aparecem no titulo+texto.
function classifyThemes(title, text) {
  const hay = normalizeForMatch(`${title || ""} ${text || ""}`);
  const out = [];
  for (const [label, patterns] of Object.entries(THEMES)) {
    if (patterns.some((p) => hay.includes(p))) out.push(label);
  }
  return out;
}

module.exports = { classifyThemes, THEMES, THEME_LABELS: Object.keys(THEMES) };
