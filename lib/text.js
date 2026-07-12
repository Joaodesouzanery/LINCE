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

// Valida um CNPJ pelos digitos verificadores (evita consultar CNPJ errado que
// retornaria vazio silenciosamente, ex.: seed de agencia com CNPJ invalido).
function isValidCnpj(value) {
  const c = onlyDigits(value);
  if (c.length !== 14 || /^(\d)\1{13}$/.test(c)) return false;
  const dv = (len, weights) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(c[i]) * weights[i];
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = dv(12, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = dv(13, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return d1 === Number(c[12]) && d2 === Number(c[13]);
}

module.exports = { stripAccents, normalizeName, normalizeNameKey, onlyDigits, isValidCnpj };
