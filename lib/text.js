// Utilitarios de normalizacao para entity resolution (ligar pessoa/empresa
// entre fontes diferentes mesmo com grafias distintas).

function stripAccents(value) {
  return String(value || "").normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// Nome canonico: sem acento, maiusculo, espacos colapsados, sem pontuacao.
function normalizeName(value) {
  return stripAccents(value)
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Chave de deduplicacao tolerante a ordem das palavras e a conectivos:
// "SILVA, RICARDO" e "RICARDO SILVA" -> mesma chave "RICARDO SILVA".
// Reduz duplicatas do mesmo dirigente vindas de fontes diferentes (DOU/Receita/TSE).
const NAME_STOPWORDS = new Set(["DA", "DE", "DO", "DAS", "DOS", "E", "DA.", "JR", "JUNIOR", "FILHO", "NETO"]);
function normalizeNameKey(value) {
  const tokens = normalizeName(value)
    .split(" ")
    .filter((t) => t.length >= 2 && !NAME_STOPWORDS.has(t));
  return tokens.sort().join(" ");
}

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

module.exports = { stripAccents, normalizeName, normalizeNameKey, onlyDigits };
