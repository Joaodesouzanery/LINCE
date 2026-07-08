const { persistCnpj } = require("../lib/qsa");

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=604800");

  const cnpj = onlyDigits(req.query.cnpj);
  if (cnpj.length !== 14) {
    return res.status(400).json({ ok: false, error: "CNPJ invalido. Informe 14 digitos." });
  }

  try {
    const response = await fetch(`https://publica.cnpj.ws/cnpj/${cnpj}`, {
      headers: { accept: "application/json" }
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        error: data?.detalhes || data?.titulo || data?.message || "CNPJ.ws nao retornou dados.",
        source: "CNPJ.ws"
      });
    }

    // ?persist=1 grava o QSA no grafo (companies + relationships 'socio').
    // Degradacao graciosa: falha ao persistir nao quebra a consulta.
    let persisted = null;
    if (req.query.persist === "1" || req.query.persist === "true") {
      persisted = await persistCnpj(data).catch((e) => ({ ok: false, error: e.message }));
    }

    return res.status(200).json({
      ok: true, source: "CNPJ.ws", fetchedAt: new Date().toISOString(), data, persisted
    });
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message, source: "CNPJ.ws" });
  }
};
