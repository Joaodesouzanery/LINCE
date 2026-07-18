/**
 * vote-classifier.js
 * Classifica microtema e pauta interna por keywords determinísticas.
 * Keywords expandidas com base nas deliberações ARTESP reais (jan/2026).
 *
 * Porte fiel de voto-diretores/src/lib/server/classifier.ts (IRIS) para JS vanilla.
 * Sem IA — apenas regex/keywords.
 */

// ─── Dicionário de microtemas ─────────────────────────────────────────────
const MICROTEMA_KEYWORDS = {
  tarifa: [
    "tarifa", "reajuste tarifário", "revisão tarifária", "reajuste de tarifa",
    "reequilíbrio tarifário", "reequilibrio tarifario", "preço público",
    "taxa de pedágio", "pedágio", "tarifa de pedágio",
    "reajuste do pedágio", "impacto tarifário", "impacto proporcional",
    "passageiro equivalente", "linhas metropolitanas", "tarifa de transporte",
  ],
  obras: [
    "obra", "obras", "construção", "reforma", "ampliação", "duplicação",
    "pavimentação", "infraestrutura viária", "melhorias", "investimento em obra",
    "projeto executivo", "prazo de obra", "conservação de pavimento",
    "obras de ampliação", "obras de arte especiais", "conservação especial",
  ],
  multa: [
    "multa", "penalidade", "infração", "autuação", "auto de infração",
    "penalização", "sanção", "aplicação de multa", "recurso de multa",
  ],
  contrato: [
    "contrato", "concessão", "aditivo", "aditamento", "termo aditivo",
    "prorrogação de contrato", "rescisão", "subconcessão", "subconcessionária",
    "termo aditivo e modificativo", "modificativo", "prorrogar", "prorrogação",
    "vigência contratual", "consórcio supervisor", "contrato de concessão",
    "serviços técnicos especializados",
  ],
  reequilibrio: [
    "reequilíbrio econômico", "reequilibrio economico", "equilíbrio econômico-financeiro",
    "desequilíbrio", "fato imprevisível", "caso fortuito", "força maior",
    "revisão extraordinária", "desequilíbrio econômico-financeiro",
    "cronograma físico-financeiro", "adequação de cronograma",
  ],
  fiscalizacao: [
    "fiscalização", "vistoria", "inspeção", "auditoria", "relatório de fiscalização",
    "irregularidade", "notificação", "descumprimento", "inadimplemento",
    "coordenação", "monitoramento de pavimento", "inspeção de obras de artes",
  ],
  seguranca: [
    "segurança", "acidente", "risco", "sinalização", "capacete", "cinto",
    "segurança viária", "condições de tráfego", "manutenção preventiva",
    "saúde e segurança no trabalho",
  ],
  ambiental: [
    "ambiental", "meio ambiente", "licença ambiental", "impacto ambiental",
    "compensação ambiental", "fauna", "flora", "sustentabilidade",
    "programa ambiental",
  ],
  desapropriacao: [
    "desapropriação", "desapropriacao", "indenização", "faixa de domínio",
    "servidão administrativa", "área afetada", "proprietário",
  ],
  adimplencia: [
    "adimplência", "adimplencia", "adimplente", "declaração de adimplência",
    "adimplência contratual", "inadimplência contratual",
  ],
  pessoal: [
    "portaria", "designa", "designação", "substituição", "substitui",
    "cargo em comissão", "empregado", "servidor", "superintendência",
    "indicação para substituição", "cargo em comissão de comando",
    "impedimentos legais e temporários", "titular de cargo",
  ],
  usuario: [
    "usuário", "reclamação", "ouvidoria", "manifestação", "atendimento ao usuário",
    "queixa", "satisfação", "central de atendimento", "call center",
  ],
};

// ─── Microtemas ANM (mineração) ───────────────────────────────────────────
const MICROTEMA_KEYWORDS_ANM = {
  lavra: [
    "lavra", "concessão de lavra", "portaria de lavra", "requerimento de lavra",
    "requerimento de concessão de lavra", "prorrogação de prazo do requerimento de lavra",
    "caducidade de concessão de lavra", "caducidade da concessão",
    "requerimento de lavra", "requerimento de concessão",
  ],
  pesquisa: [
    "pesquisa", "alvará de pesquisa", "autorização de pesquisa",
    "relatório de pesquisa", "relatório final de pesquisa",
    "nulidade do alvará", "título autorizativo de pesquisa",
    "requerimento de autorização de pesquisa",
  ],
  licenciamento: [
    "registro de licença", "licenciamento", "guia de utilização",
    "registro de licenciamento", "renovação do registro de licença",
    "prorrogação de licenciamento", "prorrogação do registro de licença",
  ],
  servidao: [
    "servidão", "área de servidão", "laudo de servidão",
    "instituição de servidão", "servidão de solo",
    "requerimento de área de servidão",
  ],
  multa: [
    "multa", "auto de infração", "penalidade", "sanção",
    "recurso às multas", "imposição da multa",
  ],
  cfem: [
    "cfem", "compensação financeira", "royalties",
    "taxa anual por hectare", "tah", "refis",
  ],
  disponibilidade: [
    "disponibilidade de área", "disponibilidade", "caducidade",
    "decaimento", "bloqueio de área", "bloqueio parcial",
  ],
  recursos: [
    "recurso hierárquico", "recurso administrativo", "reconsideração",
    "pedido de reconsideração", "recurso contra", "análise de recurso",
  ],
  ambiental: [
    "ambiental", "unidade de conservação", "estação ecológica",
    "licenciamento ambiental", "meio ambiente",
  ],
};

// ─── Classificação de microtema ───────────────────────────────────────────
// (a interface ClassificationResult do TS vira apenas { microtema, confidence } em JS)

/**
 * Classifica microtema do texto.
 * @param {string} text - texto do documento
 * @param {string|null} [agenciaSigla] - sigla da agência (opcional) para usar dicionário específico
 * @returns {{ microtema: string, confidence: number }}
 */
function classifyMicrotema(text, agenciaSigla) {
  const textLower = text.toLowerCase();

  // Selecionar dicionário baseado na agência
  const dictionaries = [MICROTEMA_KEYWORDS];
  if (agenciaSigla && agenciaSigla.toUpperCase() === "ANM") {
    dictionaries.unshift(MICROTEMA_KEYWORDS_ANM); // ANM tem prioridade
  } else {
    dictionaries.push(MICROTEMA_KEYWORDS_ANM); // fallback
  }

  const scores = new Map();
  for (const dict of dictionaries) {
    for (const [tema, keywords] of Object.entries(dict)) {
      let score = 0;
      for (const kw of keywords) {
        if (textLower.includes(kw.toLowerCase())) {
          // Frases mais específicas (mais palavras) valem mais — evita falso-positivo por palavras genéricas
          const wordCount = kw.trim().split(/\s+/).length;
          score += wordCount;
        }
      }
      if (score > 0) {
        scores.set(tema, (scores.get(tema) ?? 0) + score);
      }
    }
  }

  if (scores.size === 0) return { microtema: "outros", confidence: 0 };

  const totalScore = [...scores.values()].reduce((a, b) => a + b, 0);
  const [[bestTema, bestScore]] = [...scores.entries()].sort((a, b) => b[1] - a[1]);

  return { microtema: bestTema, confidence: bestScore / totalScore };
}

// ─── Classificação de pauta interna ──────────────────────────────────────
const PAUTA_INTERNA_KEYWORDS = [
  "pauta interna",
  "expediente interno",
  "assunto administrativo",
  "remuneração de diretores",
  "recursos humanos",
  "contratação de pessoal",
  "orçamento interno",
  "regimento interno",
  "resolução interna",
  "designação de empregado",
  "indicação para substituição",
  "cargo em comissão de comando",
  "empregado/servidor",
];

/**
 * Classifica se a deliberação é pauta interna.
 * @param {string} text - texto completo do PDF
 * @param {string|null} [interessado] - interessado extraído (se disponível)
 * @param {string|null} [agenciaSigla] - sigla da agência (ex: "ARTESP") para detectar auto-referência
 * @returns {boolean}
 */
function classifyPautaInterna(text, interessado, agenciaSigla) {
  const textLower = text.toLowerCase();

  // Keywords explícitas de pauta interna
  if (PAUTA_INTERNA_KEYWORDS.some((kw) => textLower.includes(kw))) return true;

  // Sem interessado externo → pauta interna
  if (!interessado) return true;

  // Interessado é a própria agência (ex: "ARTESP" como interessado)
  if (agenciaSigla) {
    const interessadoUpper = interessado.toUpperCase();
    const siglaUpper = agenciaSigla.toUpperCase();
    if (interessadoUpper.includes(siglaUpper) || interessadoUpper.includes("AGÊNCIA REGULADORA")) {
      return true;
    }
  }

  return false;
}

// ─── Detecção de agência reguladora no texto do PDF ───────────────────────
// Conta ocorrências de cada sigla conhecida e retorna a mais frequente.
// siglas: lista vinda da DB (produção) ou do modo demo.
/**
 * @param {string} text
 * @param {string[]} siglas
 * @returns {string|null}
 */
function detectAgenciaSigla(text, siglas) {
  if (!text || siglas.length === 0) return null;
  const upper = text.toUpperCase();
  const scores = siglas
    .map((s) => ({ sigla: s, count: countOccurrences(upper, s.toUpperCase()) }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count);
  return scores[0]?.sigla ?? null;
}

/**
 * @param {string} text
 * @param {string} needle
 * @returns {number}
 */
function countOccurrences(text, needle) {
  let count = 0;
  let idx = 0;
  while ((idx = text.indexOf(needle, idx)) !== -1) {
    count++;
    idx++; // avança para evitar loop infinito
  }
  return count;
}

module.exports = {
  classifyMicrotema,
  classifyPautaInterna,
  detectAgenciaSigla,
};
