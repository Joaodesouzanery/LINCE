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

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

module.exports = { stripAccents, normalizeName, onlyDigits };
