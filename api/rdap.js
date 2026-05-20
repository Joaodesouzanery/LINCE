function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=604800");

  const cnpj = onlyDigits(req.query.cnpj);
  if (cnpj.length !== 14) {
    return res.status(400).json({ ok: false, error: "CNPJ invalido para consulta RDAP." });
  }

  try {
    const response = await fetch(`https://rdap.registro.br/entity/${cnpj}`, {
      headers: { accept: "application/rdap+json, application/json" }
    });
    if (response.status === 404) {
      return res.status(200).json({
        ok: true,
        source: "Registro.br RDAP",
        fetchedAt: new Date().toISOString(),
        data: null,
        items: []
      });
    }
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        error: data?.description?.join(" ") || data?.errorCode || "RDAP nao retornou dados.",
        source: "Registro.br RDAP"
      });
    }
    return res.status(200).json({ ok: true, source: "Registro.br RDAP", fetchedAt: new Date().toISOString(), data });
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message, source: "Registro.br RDAP" });
  }
};
