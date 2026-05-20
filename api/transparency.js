function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

module.exports = async function handler(req, res) {
  const apiKey = process.env.PORTAL_TRANSPARENCIA_API_KEY;
  if (!apiKey) {
    return res.status(501).json({
      ok: false,
      status: "requires_key",
      error: "PORTAL_TRANSPARENCIA_API_KEY nao configurada na Vercel. Fonte preparada, mas nao conectada."
    });
  }

  const cnpj = onlyDigits(req.query.cnpj);
  if (cnpj.length !== 14) return res.status(400).json({ ok: false, error: "CNPJ invalido." });

  try {
    const url = `https://api.portaldatransparencia.gov.br/api-de-dados/contratos?cnpjFornecedor=${cnpj}&pagina=1`;
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "chave-api-dados": apiKey
      }
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      return res.status(response.status).json({ ok: false, error: "Portal da Transparencia falhou.", data });
    }
    return res.status(200).json({
      ok: true,
      source: "Portal da Transparencia",
      items: (Array.isArray(data) ? data : []).slice(0, 10).map((entry) => ({
        title: entry.objeto || entry.numero || "Contrato publico",
        description: entry.orgaoSuperior?.nome || entry.orgao?.nome || "Registro retornado pela API",
        raw: entry
      }))
    });
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message });
  }
};
