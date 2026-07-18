/**
 * nlp-extractor.js
 * Extrai campos estruturados de texto de deliberações usando regex + varredura linha a linha.
 * Estratégia de dois estágios por campo:
 *   1. Regex globais cobrindo múltiplos rótulos e formatos
 *   2. Varredura linha a linha (extractLabeledFields) como segunda tentativa
 *
 * Suporta múltiplas agências:
 *   - ARTESP: Deliberações com verbos decisórios (RATIFICA, APROVA, etc.)
 *   - ANM: Atas de reunião com múltiplos items (split via ata-splitter.js)
 *   - Genérico: DEFERIDO/INDEFERIDO de outras agências
 * Mantém retrocompatibilidade com padrão DEFERIDO/INDEFERIDO de outras agências.
 */

const { parseDataExtensoANM } = require("./ata-splitter");
const { isRoleWordOnly } = require("./name-matcher");

// ─── Regex patterns ────────────────────────────────────────────────────────
// Nome completo aceitando PREPOSIÇÕES internas (de/da/do/dos/das/e) entre tokens
// capitalizados — definido no topo para ser reusado pelos padrões de voto/ausência.
const NOME = "[A-ZÁÉÍÓÚÂÊÔÃÕÇÀÜ][a-záéíóúâêôãõçàü]+(?:\\s+(?:d[aeo]s?|e|[A-ZÁÉÍÓÚÂÊÔÃÕÇÀÜ][a-záéíóúâêôãõçàü]+)){1,5}";
// Traços/hífens usados como separador de voto em PDFs (hífen, en/em-dash, figure/horizontal bar).
// O hífen literal vem primeiro na classe para não ser interpretado como range.
const DASHES = "[-–—‒―]";

const RE_DELIBERACAO = /DELIBERA[ÇC][AÃ]O\s*N[ºo°]?\s*([\d\.]+)/gi;
const RE_REUNIAO     = /(\d{3,4})[ªa°º]?\s*(?:Reuni[aã]o\s*)?(?:Ordin[aá]ria|Extraordin[aá]ria)/gi;

// Processo: SEI, PA, Processo Adm., Proc. nº, Autos nº, Procedimento nº
const RE_PROCESSO = /(?:SEI[!]?\s*n[ºo°]?|Processo\s*(?:SEI\s*)?n[ºo°]?|PA\s*n[ºo°]?|Proc(?:esso)?\s*(?:Adm(?:inistrativo)?\s*)?n[ºo°]?|Procedimento\s*n[ºo°]?|Autos?\s*n[ºo°]?)\s*([\d\.\/\-]+)/gi;

// Interessado: 13 rótulos cobrindo terminologia de todas as agências reguladoras
const RE_INTERESSADO = /(?:Interessad[ao][:\s]+|Requerente[:\s]+|Empresa[:\s]+|Solicitante[:\s]+|Demandante[:\s]+|Concession[aá]ri[ao][:\s]+|Permission[aá]ri[ao][:\s]+|Peticion[aá]rio[:\s]+|Proponente[:\s]+|Benefici[aá]ri[ao][:\s]+|Outorgad[ao][:\s]+|Postulante[:\s]+|Requerida[:\s]+)([^\n]{3,200})/gi;

const RE_ASSUNTO     = /Assunto[:\s]+([^\n]{3,300})/gi;
const RE_PROCEDENCIA = /Proced[eê]ncia[:\s]+([^\n]{3,150})/gi;

// Captura verbos de decisão reais das deliberações brasileiras.
// Inclui verbos extras: HOMOLOGA, ARQUIVA, ANULA, REVOGA, CANCELA, PREJUDICA.
// Prioridade de normalização definida em normalizeResultado().
// Inclui as formas no PRETÉRITO (DEFERIU/INDEFERIU/APROVOU/...), que são exatamente
// como o dispositivo das decisões colegiadas é escrito ("a Diretoria INDEFERIU o pleito")
// e que o padrão antigo ignorava por completo.
const RE_RESULTADO = /\b(INDEFERIDO|INDEFERIMENTO|INDEFERIU|DEFERIDO|DEFERIMENTO|DEFERIU|PARCIALMENTE\s*DEFERIDO|RETIRADO\s*DE\s*PAUTA|RATIFICA(?:DO)?|RATIFICOU|APROVA(?:DO)?(?:\s*COM\s*RESSALVAS)?|APROVOU|RECOMENDA(?:DO)?|RECOMENDOU|DETERMINA(?:DO)?|DETERMINOU|AUTORIZA(?:DO)?|AUTORIZOU|HOMOLOGA(?:DO)?|HOMOLOGOU|ARQUIVA(?:DO)?|ARQUIVOU|ANULA(?:DO)?|ANULOU|REVOGA(?:DO)?|REVOGOU|CANCELA(?:DO)?|CANCELOU|PREJUDICA(?:DO)?)\b/gi;

// Unanimidade — qualquer das frases comuns em deliberações brasileiras
// Alternativas simples sem quantificadores aninhados (evita ReDoS)
// SEM flag /g: é usada com .test() — com /g o lastIndex persiste entre chamadas e
// documentos processados em sequência davam falso negativo (bug pego pelo corpus real).
const RE_UNANIMIDADE = /(?:por\s+unanimidade\s+dos?\s+votos?|por\s+unanimidade\s+dos?\s+presentes?|por\s+unanimidade|unanimidade\s+dos?\s+votos?|unanimidade\s+dos?\s+presentes?|aprovad[oa]\s+por\s+unanimidade)/i;

// Voto dissidente / divergente — extrai o nome do diretor que votou contra.
// Cobre "voto divergente/dissidente/contrário/vencido do Diretor X" e "(restando) vencido o Diretor X".
const RE_VOTO_DISSIDENTE = new RegExp(
  `(?:venci[dn][oa](?:\\(a\\))?\\s+(?:o\\s+|a\\s+)?(?:Diretor[a]?\\s+|Conselheiro[a]?\\s+)?` +
  `|(?:com\\s+o\\s+|pelo\\s+)?voto\\s+(?:dissidente|divergente|contr[aá]ri[ao]|vencido)\\s+d[oa]\\s+(?:Diretor[a]?\\s+|Conselheiro[a]?\\s+)?)(${NOME})`,
  "gi",
);
// Forma verbal: "o Diretor X votou contrariamente/de forma divergente", "X divergiu/discordou".
const RE_VOTO_DISSIDENTE_VERBAL = new RegExp(
  `(?:Diretor[a]?\\s+|Conselheiro[a]?\\s+)?(${NOME})\\s+(?:votou\\s+(?:de\\s+forma\\s+)?(?:contr[aá]ri[ao]|contrariamente|dissidente|divergente)|divergiu|discordou)`,
  "gi",
);

// ─── Datas ─────────────────────────────────────────────────────────────────
// Ausência: "ausente o Diretor X", "ausência do Diretor X", "X (esteve) ausente". Usa NOME (acentos OK).
// Dois grupos de captura (forma-prefixo OU forma-sufixo) — o consumidor usa aus[1] ?? aus[2].
// SEM flag 'i': com 'i', o NOME (classes maiúsculas/minúsculas) viraria case-insensitive
// e engoliria palavras minúsculas como "esteve" antes de "ausente". Os literais são
// casados explicitamente com [Aa]/[Dd]/[Oo].
const RE_VOTO_AUSENTE = new RegExp(
  `(?:[Aa]usente[:\\s]+(?:[Oo]\\s+|[Aa]\\s+)?(?:[Dd]iretor[a]?\\s+)?|[Aa]us[êe]ncia\\s+d[oa]\\s+(?:[Dd]iretor[a]?\\s+)?)(${NOME})` +
  `|(?:[Dd]iretor[a]?\\s+)?(${NOME})\\s+(?:esteve\\s+)?[Aa]usente`,
  "g",
);
const RE_AUSENTE_LABEL = /Ausente[s]?:\s*([^\n.]{5,180})/gi;
// Abstenção narrativa: "Fulano absteve-se" / "Fulano se absteve" / "Fulano votou pela abstenção".
const RE_VOTO_ABSTENCAO = new RegExp(
  `(?:Diretor[a]?\\s+)?(${NOME})\\s*(?:absteve-se|se\\s+absteve|(?:votou\\s+(?:pela\\s+|em\\s+)?)?absten[çc][aã]o)`,
  "gi",
);

const MESES = {
  janeiro: 1, fevereiro: 2, março: 3, marco: 3, abril: 4,
  maio: 5, junho: 6, julho: 7, agosto: 8,
  setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};
const RE_DATA_EXTENSO  = /(\d{1,2})\s+de\s+([a-záéíóúâêôãõçàü]+)\s+de\s+(\d{4})/gi;
const RE_DATA_NUMERICA = /(\d{2})\/(\d{2})\/(\d{4})/g;
// Data numérica próxima a contexto de reunião (mais confiável que a primeira data do documento)
const RE_DATA_NUMERICA_CTX = /(?:Reuni[aã]o|realizada?\s+em|São\s+Paulo)\s*[,:]?\s*(\d{2})\/(\d{2})\/(\d{4})/gi;

// Data específica do cabeçalho da deliberação — prioridade máxima
// Ex: "DELIBERAÇÃO ARTESP Nº 66, DE 22 DE JANEIRO DE 2026"
const RE_DATA_CABECALHO = /DELIBERA[ÇC][AÃ]O\s*(?:ARTESP\s*)?N[ºo°]?\s*[\d\.]+[,\s]+DE\s+(\d{1,2})\s+DE\s+([a-zA-ZáéíóúâêôãõçàüÁÉÍÓÚÂÊÔÃÕÇÀÜ]+)\s+DE\s+(\d{4})/i;

// ─── Extração de nomes de diretores ───────────────────────────────────────
// (macro NOME definida no topo do arquivo)

// Padrões A/B/C: contexto de voto em frases narrativas
const RE_VOTO_CONTEXTO = [
  new RegExp(`(?:Diretor[a]?\\s+|Conselheiro[a]?\\s+)(${NOME})\\s*(?:votou|vot[ao]|manifestou)`, "gi"),
  new RegExp(`(?:voto\\s+d[oa]\\s+(?:Diretor[a]?\\s+|Conselheiro[a]?\\s+))(${NOME})`, "gi"),
  new RegExp(`\\b(${NOME})\\s*${DASHES}\\s*(?:Favorável|Contrári[ao]|Favoravel|Abstenção|Ausente)`, "gi"),
];

// Pattern D extendido: captura nome E direção do voto para split favor/contra
const RE_VOTO_DIRECAO = new RegExp(`\\b(${NOME})\\s*${DASHES}\\s*(Favor[aá]vel|Contr[aá]ri[ao]|Absten[çc][aã]o|Ausente)`, "gi");

// Adesão ao relator: "X acompanhou/seguiu/aderiu" → favor; "X divergiu/discordou" → contra.
// Padrão DIRECIONAL dedicado (não entra em RE_VOTO_CONTEXTO para não perder a direção).
const RE_VOTO_CONCORDANCIA = new RegExp(`(?:Diretor[a]?\\s+|Conselheiro[a]?\\s+)?(${NOME})\\s+(acompanh|segui|aderi|divergi|discord)\\w*`, "gi");

// Número ordinal da reunião — apenas o dígito "1176"
const RE_NUMERO_REUNIAO = /(\d{3,4})[ªa°º]?\s*Reuni[aã]o/gi;

// Tipo de reunião: Ordinária ou Extraordinária
const RE_TIPO_REUNIAO = /\b(Ordin[aá]ria|Extraordin[aá]ria)\b/i;

// Padrão D: bloco de assinatura em Title Case — "Nome Completo\nDiretor-Presidente"
const RE_ASSINATURA = /^([A-ZÁÉÍÓÚÂÊÔÃÕÇÀÜ][a-záéíóúâêôãõçàü][a-záéíóúâêôãõçàü\s]+)\s*\n\s*(?:Diretor(?:-Presidente)?|Diretora(?:-Presidente)?|Conselheiro(?:-Presidente)?|Conselheira|Presidente)/gm;

// Padrão E: bloco de assinatura ARTESP em CAIXA ALTA — "NOME COMPLETO\nDiretor-Presidente"
// Necessário porque deliberações ARTESP usam nomes em maiúsculas no rodapé.
const RE_ASSINATURA_CAPS = /^([A-ZÁÉÍÓÚÂÊÔÃÕÇÀÜ]{2}[A-ZÁÉÍÓÚÂÊÔÃÕÇÀÜ\s]+)\s*\n\s*(?:Diretor(?:-Presidente)?|Diretora(?:-Presidente)?|Conselheiro(?:-Presidente)?|Conselheira|Presidente)/gm;

// Bloco de atestação eletrônica SEI — deve ser removido antes de extrair signatários
// para evitar duplicação de nomes (o SEI repete os nomes dos diretores nesse bloco)
const RE_BLOCO_SEI_ASSINATURA = /Documento assinado eletronicamente[\s\S]*?(?=A autenticidade|$)/g;

// Padrão F: assinatura ANM com dash — "Nome - Diretor(a)" ou "Nome - Diretor-Geral"
const RE_ASSINATURA_DASH = new RegExp(`^\\s*([A-ZÁÉÍÓÚÂÊÔÃÕÇÀÜ][a-záéíóúâêôãõçàü\\s]+)\\s*${DASHES}\\s*(?:Diretor[a]?(?:[- ]Geral)?(?:\\s*Substitut[oa])?|Conselheiro[a]?(?:-Presidente)?|Presidente)`, "gm");

// Pauta ANM: "1. DIRETOR-GERAL MAURO HENRIQUE MOREIRA SOUSA".
// Isso identifica o diretor responsavel/relator do item, mas nao prova voto nominal.
const RE_DIRETOR_HEADING_CAPS = /^\s*(?:\d+(?:\.\d+)*\.?\s*)?(?:DIRETOR(?:A)?(?:[- ]GERAL)?|DIRETOR(?:A)?\s+SUBSTITUT[OA]|RELATOR(?:A)?)\s+([A-ZÁÉÍÓÚÂÊÔÃÕÇÀÜ][A-ZÁÉÍÓÚÂÊÔÃÕÇÀÜ\s.'-]{5,})\s*$/gm;

// Número da reunião para atas ANM: "ATA 1ª REUNIÃO"
const RE_NUMERO_ATA = /ATA\s+(\d+)[ªa°º]?\s*REUNI[AÃ]O/i;

// Relator rotulado: "Relator: Conselheiro João Pedro de Almeida" (linha ancorada, exige ":").
// Não casa prosa ("O relator do processo...") nem "Voto: pela procedência".
const RE_RELATOR_LABEL = /^\s*Relator(?:a)?\s*:\s*(?:Conselheir[oa]\s+|Diretor[a]?(?:[- ]Geral)?\s+)?([A-ZÁÉÍÓÚÂÊÔÃÕÇÀÜ][A-Za-zÁÉÍÓÚÂÊÔÃÕÇÀÜáéíóúâêôãõçàü.'-]+(?:\s+[A-Za-zÁÉÍÓÚÂÊÔÃÕÇÀÜáéíóúâêôãõçàü.'-]+){1,6})\s*$/im;

// ─── Utilitários ───────────────────────────────────────────────────────────
function firstMatch(text, pattern, group = 1) {
  pattern.lastIndex = 0;
  const match = pattern.exec(text);
  return match ? match[group].trim() : null;
}

function uniquePush(list, value) {
  const clean = value?.replace(/\s+/g, " ").trim();
  if (!clean || clean.length < 5) return;
  if (!list.some((item) => item.toLocaleLowerCase("pt-BR") === clean.toLocaleLowerCase("pt-BR"))) {
    list.push(clean);
  }
}

function splitDirectorNames(value) {
  return value
    .replace(/\b(?:Diretor(?:a)?|Diretor-Geral|Conselheiro(?:a)?|Presidente)\b/gi, "")
    .split(/\s*(?:,|;|\se\s)\s*/i)
    .map((name) => name.replace(/\s+/g, " ").trim())
    .filter((name) => name.split(/\s+/).length >= 2 && name.length <= 100);
}

function extractDiretorHeadings(text) {
  const names = [];
  RE_DIRETOR_HEADING_CAPS.lastIndex = 0;
  let match;
  while ((match = RE_DIRETOR_HEADING_CAPS.exec(text)) !== null) {
    const nome = match[1]
      .replace(/\b(?:PROCESSO|INTERESSAD[AO]|ASSUNTO|VOTO|VISTA|RECURSO)\b.*$/i, "")
      .trim();
    uniquePush(names, nome);
  }

  const lines = text.split("\n");
  const roleLine = /^\s*(?:\d+(?:\.\d+)*\.?\s*)?(?:DIRETOR(?:A)?(?:[- ]GERAL)?|DIRETOR(?:A)?\s+SUBSTITUT[OA]|RELATOR(?:A)?)\s+(.+)$/;
  for (let i = 0; i < lines.length; i++) {
    const current = lines[i].trim();
    const lineMatch = roleLine.exec(current);
    if (!lineMatch) continue;

    let nome = lineMatch[1].trim();
    const next = lines[i + 1]?.trim() ?? "";
    if (
      next &&
      /^[A-ZÁÉÍÓÚÂÊÔÃÕÇÀÜ\s.'-]{5,}$/.test(next) &&
      !/^(PROCESSO|INTERESSAD[AO]|ASSUNTO|VOTO|MAT[EÉ]RIAS|APROVA)/i.test(next)
    ) {
      nome = `${nome} ${next}`;
    }
    nome = nome.replace(/\b(?:PROCESSO|INTERESSAD[AO]|ASSUNTO|VOTO|VISTA|RECURSO)\b.*$/i, "").trim();
    uniquePush(names, nome);
  }
  return names;
}

// ─── Extrator linha a linha (segunda estratégia) ──────────────────────────
// Faz varredura linha a linha buscando padrão "Rótulo: Valor".
// Mais tolerante a variações de espaçamento/pontuação que regex de largura fixa.
const LABEL_PATTERNS = [
  ["interessado", /^(?:Interessad[ao]|Requerente|Empresa|Solicitante|Concession[aá]ri[ao]|Outorgad[ao]|Peticion[aá]rio|Proponente|Benefici[aá]ri[ao]|Permission[aá]ri[ao]|Demandante|Postulante|Requerida)\s*:/i],
  ["processo",    /^(?:SEI[!]?|Processo(?:\s*SEI)?|PA|Proc(?:esso)?(?:\s*Adm(?:inistrativo)?)?)\s*n[ºo°]?\s*(?:[:–]|$)/i],
  ["assunto",     /^(?:Assunto|Ementa|Tema)\s*:/i],
  ["resultado",   /^(?:Resultado|Decis[aã]o)\s*:/i],
];

function extractLabeledFields(text) {
  const map = new Map();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length < 4) continue;
    for (const [key, re] of LABEL_PATTERNS) {
      if (map.has(key)) continue;
      if (re.test(trimmed)) {
        // Remove o rótulo + separadores e pega o valor restante
        const value = trimmed.replace(re, "").replace(/^[\s:–\-]+/, "").trim();
        if (value.length >= 3) map.set(key, value.slice(0, 250));
      }
    }
  }
  return map;
}

function allMatches(text, pattern, group = 1) {
  pattern.lastIndex = 0;
  const results = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    results.push(match[group].trim());
  }
  return results;
}

/** Extrai data do cabeçalho "DELIBERAÇÃO Nº X, DE DD DE MÊS DE AAAA" */
function parseDataCabecalho(text) {
  const match = RE_DATA_CABECALHO.exec(text);
  if (!match) return null;
  const day = parseInt(match[1], 10);
  const mesNome = match[2].toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const year = parseInt(match[3], 10);
  const month = MESES[mesNome];
  if (!month || day < 1 || day > 31 || year < 1990 || year > 2099) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseOneDateExtenso(match) {
  const day     = parseInt(match[1], 10);
  const mesNome = match[2].toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const year    = parseInt(match[3], 10);
  const month   = MESES[mesNome];
  if (!month || day < 1 || day > 31 || year < 1990 || year > 2099) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseDataExtenso(text) {
  // Primeiro: busca data próxima a contextos de reunião (mais confiável)
  const RE_DATA_REUNIAO_CTX = /(?:Reuni[aã]o|realizada?\s+em|data\s+da\s+reuni[aã]o|São\s+Paulo,?)\s*[,:]?\s*(\d{1,2})\s+de\s+([a-záéíóúâêôãõçàü]+)\s+de\s+(\d{4})/gi;
  RE_DATA_REUNIAO_CTX.lastIndex = 0;
  let m = RE_DATA_REUNIAO_CTX.exec(text);
  if (m) {
    const result = parseOneDateExtenso([m[0], m[1], m[2], m[3]]);
    if (result) return result;
  }

  // Fallback: primeira data em extenso encontrada no documento
  RE_DATA_EXTENSO.lastIndex = 0;
  m = RE_DATA_EXTENSO.exec(text);
  if (!m) return null;
  return parseOneDateExtenso(m);
}

function parseOneDateNumerica(d, m, y) {
  const day   = parseInt(d, 10);
  const month = parseInt(m, 10);
  const year  = parseInt(y, 10);
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1990 || year > 2099) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseDataNumerica(text) {
  // Primeiro: data numérica próxima a contexto de reunião
  RE_DATA_NUMERICA_CTX.lastIndex = 0;
  const ctxMatch = RE_DATA_NUMERICA_CTX.exec(text);
  if (ctxMatch) {
    const result = parseOneDateNumerica(ctxMatch[1], ctxMatch[2], ctxMatch[3]);
    if (result) return result;
  }
  // Fallback: primeira data numérica do documento
  RE_DATA_NUMERICA.lastIndex = 0;
  const match = RE_DATA_NUMERICA.exec(text);
  if (!match) return null;
  return parseOneDateNumerica(match[1], match[2], match[3]);
}

// Data de publicação no Diário Oficial (DOU/DOE), distinta da data da reunião.
// Ex: "Publicado no DOU em 25/01/2026", "publicada no D.O.E. de 25 de janeiro de 2026".
const RE_DATA_PUBLICACAO_NUM =
  /(?:publicad[oa]|publica[çc][ãa]o|D\.?O\.?[UE]\.?|di[áa]rio\s+oficial)[^\d]{0,40}(\d{2})\/(\d{2})\/(\d{4})/gi;
const RE_DATA_PUBLICACAO_EXT =
  /(?:publicad[oa]|publica[çc][ãa]o|D\.?O\.?[UE]\.?|di[áa]rio\s+oficial)[^\d]{0,40}(\d{1,2})\s+de\s+([a-záéíóúâêôãõçàü]+)\s+de\s+(\d{4})/gi;

// Âncora FORTE de publicação ("publicado em/no", "DOU de", "D.O.E. nº") — distingue
// a data de publicação real de uma data solta que coincide com a da reunião.
const RE_PUBLICACAO_STRONG =
  /(?:publicad[oa]\s+(?:em|no|na)|public(?:a[çc][ãa]o)\s+(?:em|no|na)|D\.?O\.?[UE]\.?\s*(?:de|em|n[º°o]))/i;

function parseDataPublicacao(text, dataReuniao = null) {
  const strong = RE_PUBLICACAO_STRONG.test(text);
  // Sem âncora forte, uma data igual à da reunião é provável falso positivo → descarta.
  const accept = (iso) =>
    iso && !(iso === dataReuniao && !strong) ? iso : null;

  // Primeiro por extenso (mais específico), depois numérico.
  RE_DATA_PUBLICACAO_EXT.lastIndex = 0;
  const ext = RE_DATA_PUBLICACAO_EXT.exec(text);
  if (ext) {
    const result = accept(parseOneDateExtenso([ext[0], ext[1], ext[2], ext[3]]));
    if (result) return result;
  }
  RE_DATA_PUBLICACAO_NUM.lastIndex = 0;
  const num = RE_DATA_PUBLICACAO_NUM.exec(text);
  if (num) {
    const result = accept(parseOneDateNumerica(num[1], num[2], num[3]));
    if (result) return result;
  }
  return null;
}

// Prioridade para resultado principal quando há múltiplos verbos decisórios
const RESULTADO_PRIORIDADE = {
  "Aprovado com Ressalvas": 1,
  "Aprovado": 2,
  "Autorizado": 3,
  "Recomendado": 4,
  "Ratificado": 5,
  "Determinado": 6,
  "Deferido": 7,
  "Indeferido": 8,
  "Parcialmente Deferido": 9,
  "Retirado de Pauta": 10,
};

function normalizeResultado(raw) {
  const upper = raw.toUpperCase().replace(/\s+/g, " ").trim();
  // Casamento por RADICAL para cobrir particípio, substantivo e pretérito
  // (DEFERIDO/DEFERIMENTO/DEFERIU). Ordem importa: INDEFER antes de DEFER, e
  // as formas mais específicas primeiro.
  if (upper.includes("PARCIALMENTE"))   return "Parcialmente Deferido";
  if (upper.includes("RETIRAD") || upper.startsWith("ARQUIV") || upper.startsWith("CANCEL") || upper.startsWith("PREJUDIC")) {
    return "Retirado de Pauta"; // arquivamento/cancelamento = sem decisão de mérito
  }
  if (upper.includes("INDEFER")) return "Indeferido";        // INDEFERIDO/INDEFERIMENTO/INDEFERIU
  if (upper.startsWith("ANUL") || upper.startsWith("REVOG")) return "Indeferido"; // anulação/revogação ~ indeferimento
  if (upper.includes("RESSALVAS")) return "Aprovado com Ressalvas";
  if (upper.includes("DEFER"))   return "Deferido";          // DEFERIDO/DEFERIMENTO/DEFERIU
  if (upper.startsWith("RATIFIC")) return "Ratificado";
  if (upper.startsWith("APROV") || upper.startsWith("HOMOLOG")) return "Aprovado"; // homologação = aprovação
  if (upper.startsWith("RECOMEND")) return "Recomendado";
  if (upper.startsWith("DETERMIN")) return "Determinado";
  if (upper.startsWith("AUTORIZ")) return "Autorizado";
  return null;
}

// ─── Tipo de retorno ───────────────────────────────────────────────────────
function extractNumeroDeliberacao(text) {
  const patterns = [
    /DELIBERAÇÃO\s*(?:ARTESP\s*)?N[º°o]?\s*([\d.]+)/iu,
    /DELIBERACAO\s*(?:ARTESP\s*)?N[º°o]?\s*([\d.]+)/iu,
    RE_DELIBERACAO,
  ];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

// ExtractedFields (interface TS removida no porte): objeto com os campos
//   numero_deliberacao, reuniao_ordinaria, numero_reuniao, tipo_reuniao,
//   data_reuniao, data_publicacao, interessado, processo, assunto, procedencia,
//   relator, resultado, decisoes_todas[], pauta_interna, resumo_pleito,
//   fundamento_decisao, nomes_votacao[], nomes_votacao_favor[],
//   nomes_votacao_contra[], nomes_votacao_abstencao[], nomes_votacao_ausente[],
//   signatarios[], diretores_detectados[], unanimidade_detectada, nomes_presentes[].

// ─── Extração principal ───────────────────────────────────────────────────
function extractFields(text) {
  const numero_deliberacao = extractNumeroDeliberacao(text);
  const reuniao_ordinaria  = firstMatch(text, RE_REUNIAO);
  const procedencia        = firstMatch(text, RE_PROCEDENCIA);

  // Estágio 1: regex globais
  let interessado = firstMatch(text, RE_INTERESSADO);
  let processo    = firstMatch(text, RE_PROCESSO);
  // Assunto: tenta "Assunto:" → "Ementa:" → "Tema:" → "Objeto:" (ANEEL e outras)
  let assunto =
    firstMatch(text, RE_ASSUNTO) ??
    firstMatch(text, /Ementa[:\s]+([^\n]{3,300})/gi) ??
    firstMatch(text, /Tema[:\s]+([^\n]{3,300})/gi) ??
    firstMatch(text, /Objeto[:\s]+([^\n]{3,300})/gi);
  const diretores_detectados = extractDiretorHeadings(text);
  // Relator rotulado tem prioridade; senão cai nos cabeçalhos de relatoria detectados.
  const relator =
    firstMatch(text, RE_RELATOR_LABEL) ??
    (diretores_detectados.length > 0 ? diretores_detectados.join(", ") : null);

  // Estágio 2: varredura linha a linha para campos ainda null
  if (!interessado || !processo || !assunto) {
    const labeled = extractLabeledFields(text);
    if (!interessado && labeled.has("interessado")) interessado = labeled.get("interessado");
    if (!processo    && labeled.has("processo"))    processo    = labeled.get("processo");
    if (!assunto     && labeled.has("assunto"))     assunto     = labeled.get("assunto");
  }

  // Trunca interessado no primeiro separador de cláusula após mínimo 5 chars
  // Ex: "Empresa XYZ Ltda., que solicita autorização..." → "Empresa XYZ Ltda."
  if (interessado && interessado.length > 5) {
    // Normaliza espaços ANTES de truncar: PDFs trazem espaços duplos no meio do
    // nome ("Rodovias  do  Tiete"), então NÃO usamos \s{2,} como separador.
    interessado = interessado.replace(/\s+/g, " ").trim();
    const sepMatch = interessado.match(/^(.{5,}?)(?:,\s*(?:que|a qual|cujo|cujos|cujas|por meio|através|representad)|;\s*|$)/);
    if (sepMatch && sepMatch[1].length < interessado.length) {
      // [,;] (não [,;.]) preserva o ponto de abreviações como "S.A."
      interessado = sepMatch[1].trim().replace(/[,;]\s*$/, "");
    }
  }

  // Data: prioriza cabeçalho ARTESP, depois extenso ANM, depois extenso genérico, depois numérico
  const data_reuniao =
    parseDataCabecalho(text) ??
    parseDataExtensoANM(text) ??
    parseDataExtenso(text) ??
    parseDataNumerica(text);

  // Data de publicação no DOU/DOE (opcional, distinta da reunião)
  const data_publicacao = parseDataPublicacao(text, data_reuniao);

  // Tipo de reunião
  const tipoMatch = RE_TIPO_REUNIAO.exec(text);
  let tipo_reuniao = null;
  if (tipoMatch) {
    const raw = tipoMatch[1].toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    tipo_reuniao = raw.startsWith("extraordin") ? "Extraordinaria" : "Ordinaria";
  }

  // Resultado: escopa a detecção ao DISPOSITIVO (após marcadores decisórios),
  // evitando que verbos incidentais da prosa ("a empresa aprova", "o relator
  // recomenda") sobreponham a decisão real (que invertia o resultado).
  const dispMatch = text.match(/(?:Em\s+face\s+do\s+exposto|Diante\s+do\s+exposto|Pelo\s+exposto|DECIDE\s+A\s+DIRETORIA|A\s+DIRETORIA(?:\s+DA\s+[\wÀ-ÿ]+)?\s+(?:DECIDE|DELIBEROU|RESOLVE)|Decide-se|RESOLVE)[\s\S]{0,800}/i);
  const resultadoScope = dispMatch ? dispMatch[0] : text;
  const resultadoRaw = allMatches(resultadoScope, RE_RESULTADO);
  const decisoesSet = new Set();
  for (const r of resultadoRaw) {
    // Sem dispositivo claro, descarta conjugações MINÚSCULAS de prosa
    // ("aprova"/"recomenda"/"deferimento"); aceita CAIXA ALTA / particípio / pretérito.
    if (!dispMatch && r === r.toLowerCase()) continue;
    const norm = normalizeResultado(r);
    if (norm) decisoesSet.add(norm);
  }
  const decisoes_todas = [...decisoesSet];

  // Resultado principal: por prioridade (APROVA > AUTORIZA > RECOMENDA > ...)
  let resultado = null;
  if (decisoes_todas.length > 0) {
    resultado = decisoes_todas.sort(
      (a, b) => (RESULTADO_PRIORIDADE[a] ?? 99) - (RESULTADO_PRIORIDADE[b] ?? 99)
    )[0];
  }

  // Fallback: "unanimidade de votos" → aprovação implícita
  if (!resultado) {
    RE_UNANIMIDADE.lastIndex = 0;
    if (RE_UNANIMIDADE.exec(text)) {
      resultado = "Aprovado por Unanimidade";
      decisoes_todas.push("Aprovado por Unanimidade");
    }
  }

  // Pauta interna: keywords administrativas ou ausência de interessado externo
  const PAUTA_INTERNA_KEYWORDS = [
    "pauta interna", "expediente interno", "assunto administrativo",
    "remuneração", "recursos humanos",
    "designação de empregado", "indicação para substituição",
    "cargo em comissão de comando", "empregado/servidor",
  ];
  const textLower = text.toLowerCase();
  const pauta_interna =
    !interessado ||
    PAUTA_INTERNA_KEYWORDS.some((kw) => textLower.includes(kw));

  // Resumo do pleito
  // Estratégia 1: seção com rótulo explícito (Resumo:, Objeto:, Ementa:)
  // Estratégia 2: parágrafo iniciado por marcador narrativo (Trata-se, Cuida-se, etc.)
  const RE_RESUMO_LABEL = /(?:Resumo[:\s]+|Objeto[:\s]+)([\s\S]{20,600}?)(?=\n\n|\f|$)/im;
  const RE_RESUMO_PRINCIPAL = /(?:Trata-se|Cuida-se|Versa\s+o\s+presente|A\s+presente\s+delibera[çc][aã]o|O\s+presente\s+(?:caso|processo|requerimento|pedido)|A\s+empresa\s+requer|O\s+requerente\s+solicita|Refere-se\s+ao?\s+requerimento)([\s\S]{30,800}?)(?=\n\n|\f|$)/im;

  let resumo_pleito = null;
  const resumoMatch = RE_RESUMO_LABEL.exec(text) ?? RE_RESUMO_PRINCIPAL.exec(text);
  if (resumoMatch) {
    const raw = resumoMatch[0].trim();
    resumo_pleito = raw.length >= 20 ? raw.slice(0, 800) : null;
  }
  // Fallback: usa o campo assunto como resumo curto
  if (!resumo_pleito && assunto && assunto.length >= 15) {
    resumo_pleito = assunto;
  }

  // Fundamento da decisão: marcadores expandidos para cobrir ARTESP e outras agências
  // [\s\S] limitado a 800 chars (greedy) para evitar backtracking excessivo
  const RE_FUNDAMENTO = /(?:Fundamento[:\s]+|Em face do exposto|Considerando\s+o\s+exposto|Diante\s+do\s+exposto|Pelo\s+exposto|Tendo\s+em\s+vista[^,\n]{0,30},\s*decide[:\s]+|DECIDE\s+A\s+DIRETORIA[:\s]+|A\s+DIRETORIA(?:\s+DA\s+\w+)?\s+DECIDE[:\s]+|DECIDE[:\s]+|Decide-se[:\s]+|RESOLVE[:\s]+)([\s\S]{20,800}?)(?:\n\n|\n[A-Z]{3}|$)/i;
  const fundamento_decisao = RE_FUNDAMENTO.exec(text)?.[1]?.trim() ?? null;

  // Número da reunião: tenta formato deliberação (1176ª), depois ata (ATA 1ª)
  const numero_reuniao = firstMatch(text, RE_NUMERO_REUNIAO) ?? firstMatch(text, RE_NUMERO_ATA);

  // ─── Bloco de assinatura: coleta signatários ──────────────────────────────
  // Suporta 3 formatos:
  //   A) Title-case + newline: "Nome Completo\nDiretor" (ARTESP)
  //   B) ALL-CAPS + newline: "NOME COMPLETO\nDiretor" (ARTESP)
  //   C) Dash: "Nome Completo - Diretor" (ANM)
  // Remove bloco de atestação eletrônica SEI para evitar duplicação de nomes
  const textSemSEI = text.replace(RE_BLOCO_SEI_ASSINATURA, "");

  const signatarios = [];

  // Padrão A: title-case + newline
  RE_ASSINATURA.lastIndex = 0;
  let sig;
  while ((sig = RE_ASSINATURA.exec(textSemSEI)) !== null) {
    const nome = sig[1].trim();
    if (nome.length > 4 && !signatarios.includes(nome)) signatarios.push(nome);
  }

  // Padrão F: dash (ANM) — "Nome - Diretor(a)"
  RE_ASSINATURA_DASH.lastIndex = 0;
  let sigDash;
  while ((sigDash = RE_ASSINATURA_DASH.exec(textSemSEI)) !== null) {
    const nome = sigDash[1].trim();
    if (nome.length > 4 && !signatarios.includes(nome)) signatarios.push(nome);
  }

  RE_ASSINATURA_CAPS.lastIndex = 0;
  let sigCaps;
  while ((sigCaps = RE_ASSINATURA_CAPS.exec(textSemSEI)) !== null) {
    const nome = sigCaps[1].trim();
    if (nome.length > 4 && !signatarios.includes(nome)) signatarios.push(nome);
  }

  // ─── Unanimidade ──────────────────────────────────────────────────────────
  RE_UNANIMIDADE.lastIndex = 0;
  const unanimidade_detectada = RE_UNANIMIDADE.test(text);

  // ─── Nomes de diretores: contexto + bloco de assinatura ─────────────────
  const nomes_votacao = [];
  const nomes_votacao_favor = [];
  const nomes_votacao_contra = [];
  const nomes_votacao_abstencao = [];
  const nomes_votacao_ausente = [];

  // Detecção direcional explícita ("Nome – Favorável/Contrário/Abstenção/Ausente").
  // SEMPRE roda, inclusive sob unanimidade: uma divergência tabular sobrepõe o default.
  RE_VOTO_DIRECAO.lastIndex = 0;
  let vd;
  while ((vd = RE_VOTO_DIRECAO.exec(text)) !== null) {
    const nome = vd[1].trim();
    const tipo = vd[2].toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    if (nome.length > 4) {
      if (!nomes_votacao.includes(nome)) nomes_votacao.push(nome);
      if (tipo.includes("ausente")) {
        if (!nomes_votacao_ausente.includes(nome)) nomes_votacao_ausente.push(nome);
      } else if (tipo.startsWith("absten")) {
        if (!nomes_votacao_abstencao.includes(nome)) nomes_votacao_abstencao.push(nome);
      } else if (tipo.startsWith("favor")) {
        if (!nomes_votacao_favor.includes(nome)) nomes_votacao_favor.push(nome);
      } else if (!nomes_votacao_contra.includes(nome)) {
        nomes_votacao_contra.push(nome);
      }
    }
  }

  // Adesão/divergência ao relator (padrão direcional dedicado).
  RE_VOTO_CONCORDANCIA.lastIndex = 0;
  let vc;
  while ((vc = RE_VOTO_CONCORDANCIA.exec(text)) !== null) {
    const nome = vc[1].trim();
    const verbo = vc[2].toLowerCase();
    if (nome.length <= 4) continue;
    if (!nomes_votacao.includes(nome)) nomes_votacao.push(nome);
    if (/^(?:divergi|discord)/.test(verbo)) {
      if (!nomes_votacao_contra.includes(nome)) nomes_votacao_contra.push(nome);
    } else if (!nomes_votacao_favor.includes(nome) && !nomes_votacao_contra.includes(nome)) {
      nomes_votacao_favor.push(nome);
    }
  }

  // Padrões A / B / C (frases narrativas — apenas nomes sem direção)
  for (const pattern of RE_VOTO_CONTEXTO) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(text)) !== null) {
      const nome = m[1].trim();
      if (nome.length > 4 && !nomes_votacao.includes(nome)) nomes_votacao.push(nome);
    }
  }

  // Adiciona signatários ao pool geral se ainda não encontrados
  for (const nome of signatarios) {
    if (!nomes_votacao.includes(nome)) nomes_votacao.push(nome);
  }

  const semDirecaoExplicita =
    nomes_votacao_contra.length === 0 &&
    nomes_votacao_abstencao.length === 0 &&
    nomes_votacao_ausente.length === 0;

  if (unanimidade_detectada && signatarios.length > 0) {
    // Unanimidade: signatários ainda não classificados → favor (idempotente; não
    // duplica nem sobrescreve divergências tabulares detectadas acima).
    const jaClassificado = new Set([
      ...nomes_votacao_favor, ...nomes_votacao_contra,
      ...nomes_votacao_abstencao, ...nomes_votacao_ausente,
    ]);
    for (const nome of signatarios) {
      if (!jaClassificado.has(nome)) nomes_votacao_favor.push(nome);
    }
  } else if (semDirecaoExplicita && nomes_votacao_favor.length === 0 && nomes_votacao.length > 0) {
    // Sem QUALQUER direção explícita → todos considerados a favor (comportamento anterior).
    nomes_votacao_favor.push(...nomes_votacao);
  }

  // ─── Voto dissidente / divergente / divergente ─────────────────────────────────────────
  // Move o diretor dissidente de _favor para _contra (se estava em favor)
  const markContra = (rawNome) => {
    const nome = rawNome.trim();
    if (nome.length <= 4) return;
    if (!nomes_votacao.includes(nome)) nomes_votacao.push(nome);
    const idxFavor = nomes_votacao_favor.indexOf(nome);
    if (idxFavor !== -1) nomes_votacao_favor.splice(idxFavor, 1);
    if (!nomes_votacao_contra.includes(nome)) nomes_votacao_contra.push(nome);
  };

  RE_VOTO_DISSIDENTE.lastIndex = 0;
  let diss;
  while ((diss = RE_VOTO_DISSIDENTE.exec(text)) !== null) markContra(diss[1]);

  // Forma verbal: "X votou contrariamente", "X divergiu/discordou".
  RE_VOTO_DISSIDENTE_VERBAL.lastIndex = 0;
  let dissV;
  while ((dissV = RE_VOTO_DISSIDENTE_VERBAL.exec(text)) !== null) markContra(dissV[1]);

  RE_VOTO_AUSENTE.lastIndex = 0;
  let aus;
  while ((aus = RE_VOTO_AUSENTE.exec(text)) !== null) {
    const nome = (aus[1] ?? aus[2] ?? "").trim();
    if (nome.length > 4) {
      if (!nomes_votacao.includes(nome)) nomes_votacao.push(nome);
      const idxFavor = nomes_votacao_favor.indexOf(nome);
      if (idxFavor !== -1) nomes_votacao_favor.splice(idxFavor, 1);
      if (!nomes_votacao_ausente.includes(nome)) nomes_votacao_ausente.push(nome);
    }
  }

  RE_AUSENTE_LABEL.lastIndex = 0;
  let ausLabel;
  while ((ausLabel = RE_AUSENTE_LABEL.exec(text)) !== null) {
    for (const nome of splitDirectorNames(ausLabel[1])) {
      if (!nomes_votacao.includes(nome)) nomes_votacao.push(nome);
      const idxFavor = nomes_votacao_favor.indexOf(nome);
      if (idxFavor !== -1) nomes_votacao_favor.splice(idxFavor, 1);
      if (!nomes_votacao_ausente.includes(nome)) nomes_votacao_ausente.push(nome);
    }
  }

  // Abstenção narrativa: "Fulano absteve-se" / "votou pela abstenção".
  RE_VOTO_ABSTENCAO.lastIndex = 0;
  let abs;
  while ((abs = RE_VOTO_ABSTENCAO.exec(text)) !== null) {
    const nome = abs[1].trim();
    if (nome.length > 4) {
      if (!nomes_votacao.includes(nome)) nomes_votacao.push(nome);
      const idxFavor = nomes_votacao_favor.indexOf(nome);
      if (idxFavor !== -1) nomes_votacao_favor.splice(idxFavor, 1);
      const idxContra = nomes_votacao_contra.indexOf(nome);
      if (idxContra !== -1) nomes_votacao_contra.splice(idxContra, 1);
      if (!nomes_votacao_abstencao.includes(nome)) nomes_votacao_abstencao.push(nome);
    }
  }

  // Remove palavra-função ("Diretor", "Presidente"…) que vaza como nome em alguns
  // blocos de assinatura → não vira voto nem candidato-lixo.
  const semRole = (arr) => arr.filter((n) => !isRoleWordOnly(n));

  const nomes_presentes = extractPresentes(text);

  return {
    numero_deliberacao,
    reuniao_ordinaria,
    numero_reuniao,
    tipo_reuniao,
    data_reuniao,
    data_publicacao,
    interessado,
    processo,
    assunto,
    procedencia,
    relator,
    resultado,
    decisoes_todas,
    pauta_interna,
    resumo_pleito,
    fundamento_decisao,
    nomes_votacao: semRole(nomes_votacao),
    nomes_votacao_favor: semRole(nomes_votacao_favor),
    nomes_votacao_contra: semRole(nomes_votacao_contra),
    nomes_votacao_abstencao: semRole(nomes_votacao_abstencao),
    nomes_votacao_ausente: semRole(nomes_votacao_ausente),
    signatarios: semRole(signatarios),
    diretores_detectados: semRole(diretores_detectados),
    unanimidade_detectada,
    nomes_presentes: semRole(nomes_presentes),
  };
}

// ─── Presentes declarados no documento ("Constituição:"/"Presentes:") ──────
// Padrão real das atas ARTESP: "Constituição: Presidência-PRE - Diretor-Presidente
// André Isper Rodrigues Barnabé, Diretoria 2 - DIR-DZ - Diretor Diego Albert Zanatto, …".
// Quem estava presente é o registro mais fiel de quem votou em unanimidade — melhor
// que o roster de mandatos (que pode estar vazio/errado).
const RE_PRESENTES_BLOCO = /(?:Constitui[cç][aã]o|Presentes?)\s*:\s*([\s\S]{0,700}?)(?:\n\s*\n|\.\s*\n|$)/i;

function extractPresentes(text) {
  const bloco = RE_PRESENTES_BLOCO.exec(text)?.[1];
  if (bloco) {
    const nomes = [];
    const re = new RegExp(`Diretor(?:a)?(?:[- ](?:Presidente|Geral))?\\s+(${NOME})`, "g");
    for (const match of bloco.matchAll(re)) {
      // O macro NOME aceita o conector "e" + palavra capitalizada — corta o rabo
      // institucional ("… Rudnik e Diretoria 4" → "… Rudnik").
      const nome = match[1].replace(/\s+e\s+(?:Diretoria|Presid[êe]ncia|Superintend[êe]ncia).*$/i, "").trim();
      if (nome && !nomes.includes(nome)) nomes.push(nome);
    }
    if (nomes.length) return nomes;
  }
  // Fallback ANM: as atas da ANM não têm bloco "Constituição:" — o roster está em
  // prosa no preâmbulo ("…presidida pelo Diretor-Geral, NOME, e contou com a presença
  // do Diretor Substituto NOME e do Diretor NOME…"). Sem ler isto, a ATA ANM ficava
  // sem roster e produzia 0 voto (dependia 100% do mandato). QA Etapa 19.
  return extractPresentesNarrativo(text);
}

// Zona do preâmbulo onde a ANM lista quem presidiu/compareceu (limita o escopo para
// não pescar "o Diretor relator X" dos itens lá embaixo).
const RE_ROSTER_ZONA = /(?:presidid[ao][\s\S]{0,40}?Diretor|contou\s+com\s+a\s+presen[cç]a|estiveram\s+presentes|compareceram|com\s+a\s+participa[cç][aã]o)[\s\S]{0,600}/i;
// Nome SEM o conector "e" isolado (o macro NOME global o inclui e mesclaria dois
// diretores adjacentes: "…Neves e do Diretor Caio…"). Aceita só "de/da/do/dos/das".
// {1,6} p/ não truncar nomes longos ("José Fernando de Mendonça Gomes Júnior" = 6 tokens).
const NOME_SEM_E = "[A-ZÁÉÍÓÚÂÊÔÃÕÇÀÜ][a-záéíóúâêôãõçàü]+(?:\\s+(?:d[aeo]s?|[A-ZÁÉÍÓÚÂÊÔÃÕÇÀÜ][a-záéíóúâêôãõçàü]+)){1,6}";
// Modificador de cargo tolera QUEBRA DE LINHA ([-\s] em vez de [- ]): no PDF da ANM
// vem "Diretor\nSubstituto Luiz…" — sem isto "Substituto" vazava para dentro do nome
// capturado ("Substituto Luiz Paniago Neves" casava só 0.62). QA Etapa 21.
const RE_ROSTER_DIRETOR = new RegExp(`Diretor(?:a)?(?:[-\\s](?:Geral|Presidente|Substitut[oa]))?\\s*,?\\s+(${NOME_SEM_E})`, "g");

function extractPresentesNarrativo(text) {
  const zona = RE_ROSTER_ZONA.exec(text)?.[0];
  if (!zona) return [];
  const nomes = [];
  for (const match of zona.matchAll(RE_ROSTER_DIRETOR)) {
    const nome = match[1]
      // Rede: remove palavra-função à esquerda que possa ter vazado (Substituto/Geral…).
      .replace(/^(?:substitut[oa]|geral|presidente|adjunt[oa])\s+/i, "")
      .replace(/\s+(?:na|no|em|ao)\s.*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
    if (nome && nome.split(/\s+/).length >= 2 && !isRoleWordOnly(nome) && !nomes.includes(nome)) nomes.push(nome);
  }
  return nomes;
}

// ─── Votos explícitos por item de ata ─────────────────────────────────────
// ItemVotes (interface TS removida no porte): { favor[], contra[], abstencao[], ausente[] }

const RE_VOTARAM_FAVOR = new RegExp(
  `Vot(?:aram|ou)\\s+(?:a\\s+)?favor(?:avelmente|[aá]ve(?:l|is))?(?:\\s+(?:os?|as?))?\\s+(?:Diretor(?:es|as)?\\s+|Conselheiro(?:s|as)?\\s+)?([^.\\n;]{4,180})`,
  "gi",
);
const RE_VOTARAM_CONTRA = new RegExp(
  `Vot(?:aram|ou)\\s+(?:contr[aá]ri(?:amente|os?|as?)?|contra)(?:\\s+(?:os?|as?))?\\s+(?:Diretor(?:es|as)?\\s+|Conselheiro(?:s|as)?\\s+)?([^.\\n;]{4,180})`,
  "gi",
);

/**
 * Extrai votos EXPLÍCITOS de um item de ata (favor/contra/abstenção/ausente).
 * Conservador de propósito: NÃO aplica default-favor nem pool de signatários
 * (que só fazem sentido no documento inteiro) — a inferência por mandato fica
 * downstream (vote-inference). Antes os votos por item eram sempre [], fazendo a
 * inferência inverter votos contrários reais.
 */
function extractItemVotes(text) {
  const favor = [];
  const contra = [];
  const abstencao = [];
  const ausente = [];
  const push = (arr, raw) => {
    const nome = raw.trim();
    if (nome.length > 4 && !arr.includes(nome)) arr.push(nome);
  };
  const moveToContra = (raw) => {
    const nome = raw.trim();
    if (nome.length <= 4) return;
    const i = favor.indexOf(nome);
    if (i !== -1) favor.splice(i, 1);
    if (!contra.includes(nome)) contra.push(nome);
  };

  // Tabular direcional "Nome – Favorável/Contrário/Abstenção/Ausente"
  RE_VOTO_DIRECAO.lastIndex = 0;
  let vd;
  while ((vd = RE_VOTO_DIRECAO.exec(text)) !== null) {
    const nome = vd[1].trim();
    const tipo = vd[2].toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    if (tipo.includes("ausente")) push(ausente, nome);
    else if (tipo.startsWith("absten")) push(abstencao, nome);
    else if (tipo.startsWith("favor")) push(favor, nome);
    else push(contra, nome);
  }

  // "Votaram a favor os Diretores X, Y e Z" / "Votou contra o Diretor W"
  RE_VOTARAM_FAVOR.lastIndex = 0;
  let vf;
  while ((vf = RE_VOTARAM_FAVOR.exec(text)) !== null) {
    for (const nome of splitDirectorNames(vf[1])) push(favor, nome);
  }
  RE_VOTARAM_CONTRA.lastIndex = 0;
  let vcc;
  while ((vcc = RE_VOTARAM_CONTRA.exec(text)) !== null) {
    for (const nome of splitDirectorNames(vcc[1])) moveToContra(nome);
  }

  // Dissidente/divergente/vencido (nominal e verbal) → contra
  for (const re of [RE_VOTO_DISSIDENTE, RE_VOTO_DISSIDENTE_VERBAL]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) moveToContra(m[1]);
  }

  // Adesão/divergência ao relator
  RE_VOTO_CONCORDANCIA.lastIndex = 0;
  let vc;
  while ((vc = RE_VOTO_CONCORDANCIA.exec(text)) !== null) {
    if (/^(?:divergi|discord)/.test(vc[2].toLowerCase())) moveToContra(vc[1]);
    else push(favor, vc[1]);
  }

  // Ausência narrativa (dois grupos de captura)
  RE_VOTO_AUSENTE.lastIndex = 0;
  let au;
  while ((au = RE_VOTO_AUSENTE.exec(text)) !== null) push(ausente, au[1] ?? au[2] ?? "");

  // Abstenção narrativa (move de favor/contra para abstenção)
  RE_VOTO_ABSTENCAO.lastIndex = 0;
  let ab;
  while ((ab = RE_VOTO_ABSTENCAO.exec(text)) !== null) {
    const nome = ab[1].trim();
    if (nome.length <= 4) continue;
    const i = favor.indexOf(nome);
    if (i !== -1) favor.splice(i, 1);
    const j = contra.indexOf(nome);
    if (j !== -1) contra.splice(j, 1);
    if (!abstencao.includes(nome)) abstencao.push(nome);
  }

  const semRole = (arr) => arr.filter((n) => !isRoleWordOnly(n));
  return { favor: semRole(favor), contra: semRole(contra), abstencao: semRole(abstencao), ausente: semRole(ausente) };
}

// ─── Confiança de extração (ponderada) ───────────────────────────────────
// Pesos refletem a importância de cada campo para identificar a deliberação.
// Soma dos pesos = 1.0 quando todos os campos estão presentes.
function calcConfidence(fields) {
  const weights = [
    [fields.numero_deliberacao !== null, 0.20], // campo identificador central
    [fields.data_reuniao       !== null, 0.16], // data sempre presente em deliberações
    [fields.resultado          !== null, 0.16], // decisão final
    [fields.interessado        !== null, 0.12], // quem fez o requerimento
    [fields.assunto            !== null, 0.10], // tema da deliberação
    [fields.processo           !== null, 0.10], // número do processo SEI
    [fields.resumo_pleito      !== null, 0.04], // resumo do pleito
    [fields.fundamento_decisao !== null, 0.02], // fundamento jurídico
    [fields.signatarios.length > 0,     0.06], // diretores no bloco de assinatura
    [fields.reuniao_ordinaria !== null,  0.04], // reunião identificada
  ];
  return weights.reduce((sum, [present, weight]) => sum + (present ? weight : 0), 0);
}

module.exports = {
  extractFields,
  extractPresentes,
  extractPresentesNarrativo,
  extractItemVotes,
  calcConfidence,
};
