/**
 * name-matcher.js
 * Port de worker/app/pipeline/name_matcher.py (via IRIS name-matcher.ts)
 * Fuzzy matching de nomes de diretores sem dependência externa.
 */

// ─── Similaridade de strings (Jaro-Winkler simplificado) ─────────────────
// Implementação sem biblioteca — substitui rapidfuzz/token_sort_ratio
function tokenSortRatio(a, b) {
  const tokensA = a
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/\s+/)
    .sort()
    .join(" ");
  const tokensB = b
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/\s+/)
    .sort()
    .join(" ");

  return levenshteinSimilarity(tokensA, tokensB);
}

// Nome A é uma abreviação ESTRITA de B (mesmo diretor grafado com menos sobrenomes):
// todos os tokens de A (sem acento, sem conectores) aparecem em B, A é MENOR que B, e
// primeiro+último token coincidem. Ex.: "Felipe Queiroz" ⊂ "Felipe Fernandes Queiroz".
// Conservador de propósito — só funde duplicata óbvia, não pessoas distintas.
function isStrictAbbreviation(shortName, longName) {
  const norm = (s) =>
    s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/\s+/).filter(Boolean);
  const conectores = new Set(["de", "da", "do", "das", "dos", "e"]);
  const strip = (t) => t.filter((x) => !conectores.has(x));
  const a = strip(norm(shortName));
  const b = strip(norm(longName));
  if (a.length < 2 || b.length < 2 || a.length >= b.length) return false;
  if (a[0] !== b[0]) return false; // primeiro nome tem de bater
  const setB = new Set(b);
  if (!a.every((t) => setB.has(t))) return false; // A ⊆ B
  // Prefixo ("Severino Medeiros" ⊂ "Severino Medeiros Ramos Neto") OU mesmo último
  // sobrenome ("Felipe Queiroz" ⊂ "Felipe Fernandes Queiroz").
  const ehPrefixo = a.every((t, i) => t === b[i]);
  const mesmoUltimo = a[a.length - 1] === b[b.length - 1];
  return ehPrefixo || mesmoUltimo;
}

function levenshteinSimilarity(a, b) {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] =
          1 + Math.min(matrix[i - 1][j], matrix[i][j - 1], matrix[i - 1][j - 1]);
      }
    }
  }

  const distance = matrix[a.length][b.length];
  return 1 - distance / Math.max(a.length, b.length);
}

// ─── Tipos ────────────────────────────────────────────────────────────────
// (interfaces DiretorRecord, MatchResult e EmpresaRecord removidas — JS não tem tipos)
// DiretorRecord: { id, nome, nome_variantes[] }
// MatchResult:   { diretorId, score, needsReview, isNew }
// EmpresaRecord: { id, nome_normalizado, nome_variantes[] }

// ─── Matching ─────────────────────────────────────────────────────────────
const MATCH_THRESHOLD = 0.85; // equivalente ao 85 do rapidfuzz

/**
 * Gera formas parciais de um nome completo (prefixo de tokens + primeiro+último +
 * primeiro+CADA sobrenome), para casar citações abreviadas com o nome completo do
 * diretor. "Alex Antonio de Azevedo Cruz" precisa casar "Alex Azevedo" (forma real
 * usada nas atas da ANTT — sem essa variante o match caía a ~0,60 e virava candidato).
 * Evita formas de 1 token (ambíguas demais).
 */
function deriveNomeVariantes(nome) {
  const tokens = nome.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 3) return [];
  const conectores = new Set(["de", "da", "do", "das", "dos", "e"]);
  const variantes = new Set();
  variantes.add(`${tokens[0]} ${tokens[1]}`);                 // primeiros dois
  variantes.add(`${tokens[0]} ${tokens[tokens.length - 1]}`); // primeiro + último
  variantes.add(tokens.slice(0, 3).join(" "));                // primeiros três
  // primeiro + cada sobrenome intermediário ("Alex Azevedo", "Alex Antonio"…)
  for (const sobrenome of tokens.slice(1)) {
    if (!conectores.has(sobrenome.toLowerCase())) variantes.add(`${tokens[0]} ${sobrenome}`);
  }
  // Variante "sem patronímico do meio": remove cada par (conector + palavra seguinte),
  // ex.: "José Fernando de Mendonça Gomes Júnior" → "José Fernando Gomes Júnior".
  // Casa o nome OFICIAL COMPLETO (seed) com a citação abreviada usada nos documentos —
  // sem isso o par ficava em 0.68 (faixa candidato) e criava um diretor DUPLICADO.
  const semPatronimico = [];
  for (let i = 0; i < tokens.length; i++) {
    if (conectores.has(tokens[i].toLowerCase()) && i + 1 < tokens.length) { i++; continue; }
    semPatronimico.push(tokens[i]);
  }
  if (semPatronimico.length >= 2 && semPatronimico.length < tokens.length) {
    variantes.add(semPatronimico.join(" "));
  }
  variantes.delete(nome);
  return [...variantes];
}

function findBestMatch(rawName, diretores) {
  if (!rawName || rawName.trim().length < 3) {
    return { diretorId: null, score: 0, needsReview: true, isNew: true };
  }

  let bestScore = 0;
  let bestId = null;

  for (const dir of diretores) {
    // Compara com nome principal, variantes cadastradas e formas derivadas.
    const candidates = [dir.nome, ...dir.nome_variantes, ...deriveNomeVariantes(dir.nome)];
    for (const cand of candidates) {
      const score = tokenSortRatio(rawName, cand);
      if (score > bestScore) {
        bestScore = score;
        bestId = dir.id;
      }
    }
  }

  if (bestScore >= MATCH_THRESHOLD) {
    return { diretorId: bestId, score: bestScore, needsReview: false, isNew: false };
  }

  // Score alto mas abaixo do limiar — precisa revisão manual
  if (bestScore >= 0.6) {
    return { diretorId: bestId, score: bestScore, needsReview: true, isNew: false };
  }

  // Não encontrou — é um novo diretor
  return { diretorId: null, score: bestScore, needsReview: true, isNew: true };
}

// ─── Validação de nome de pessoa ──────────────────────────────────────────
// Palavras-função que NÃO são nome de pessoa (evita candidatos-lixo tipo "Diretor").
const ROLE_WORDS = new Set([
  "diretor", "diretora", "diretorgeral", "diretorpresidente", "diretorsubstituto",
  "diretorasubstituta", "presidente", "vicepresidente", "conselheiro", "conselheira",
  "relator", "relatora", "secretario", "secretaria", "procurador", "procuradora",
  "superintendente", "substituto", "substituta", "geral", "interino", "interina",
  "suplente", "membro", "representante", "coordenador", "coordenadora", "assessor",
]);
const NAME_CONNECTORS = new Set(["de", "da", "do", "das", "dos", "e"]);

function nameTokens(raw) {
  return (raw ?? "")
    .replace(/[.\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((t) => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]/g, ""))
    .filter(Boolean);
}

/** true se o texto é APENAS palavra(s)-função/conector (ex.: "Diretor", "Diretor-Geral"). */
function isRoleWordOnly(raw) {
  const tokens = nameTokens(raw);
  const nonConnector = tokens.filter((t) => !NAME_CONNECTORS.has(t));
  if (nonConnector.length === 0) return true;
  return nonConnector.every((t) => ROLE_WORDS.has(t));
}

/**
 * Heurística: o texto parece um NOME DE PESSOA — ≥2 tokens de conteúdo (nome +
 * sobrenome), ≥5 chars, e não é só palavra-função. Gate para criar candidato de diretor.
 */
function isLikelyPersonName(raw) {
  const cleaned = (raw ?? "").replace(/[.\-]/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length < 5) return false;
  const tokens = nameTokens(raw);
  const content = tokens.filter((t) => !NAME_CONNECTORS.has(t) && !ROLE_WORDS.has(t) && t.length >= 2);
  return content.length >= 2;
}

// ─── Normalização de nome ─────────────────────────────────────────────────
function normalizeName(name) {
  return name
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

// ─── Matching de empresas (interessado) ────────────────────────────────────
// EmpresaRecord: { id, nome_normalizado, nome_variantes[] }

/**
 * Chave canônica de uma razão social: remove acentos, caixa, pontuação e sufixos
 * societários (S.A., LTDA, EIRELI...) para colapsar variantes da mesma empresa.
 */
function canonicalizeEmpresa(nome) {
  return nome
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.,/\\()'"]+/g, " ")
    .replace(/\b(s\s*\/?\s*a|sa|ltda|eireli|epp|mei|me|cia|companhia|concessionaria|holding|participacoes|empreendimentos)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Igual a findBestMatch, mas comparando chaves canônicas de razão social. */
function findBestEmpresaMatch(rawName, empresas) {
  const target = canonicalizeEmpresa(rawName);
  if (!target || target.length < 3) {
    return { diretorId: null, score: 0, needsReview: true, isNew: true };
  }
  let bestScore = 0;
  let bestId = null;
  for (const emp of empresas) {
    const candidates = [emp.nome_normalizado, ...emp.nome_variantes.map(canonicalizeEmpresa)];
    for (const c of candidates) {
      const score = tokenSortRatio(target, c);
      if (score > bestScore) { bestScore = score; bestId = emp.id; }
    }
  }
  if (bestScore >= MATCH_THRESHOLD) return { diretorId: bestId, score: bestScore, needsReview: false, isNew: false };
  if (bestScore >= 0.6) return { diretorId: bestId, score: bestScore, needsReview: true, isNew: false };
  return { diretorId: null, score: bestScore, needsReview: true, isNew: true };
}

module.exports = {
  tokenSortRatio,
  isStrictAbbreviation,
  deriveNomeVariantes,
  findBestMatch,
  isRoleWordOnly,
  isLikelyPersonName,
  normalizeName,
  canonicalizeEmpresa,
  findBestEmpresaMatch,
};
