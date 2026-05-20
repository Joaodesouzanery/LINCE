module.exports = async function handler(req, res) {
  const apiKey = process.env.DATAJUD_API_KEY;
  if (!apiKey) {
    return res.status(501).json({
      ok: false,
      status: "requires_key",
      error: "DATAJUD_API_KEY nao configurada na Vercel. Fonte preparada, mas nao conectada."
    });
  }

  const q = String(req.query.q || "").trim();
  const tribunal = String(req.query.tribunal || "tjsp").toLowerCase();
  if (!q) return res.status(400).json({ ok: false, error: "Informe termo de busca." });

  try {
    const response = await fetch(`https://api-publica.datajud.cnj.jus.br/api_publica_${tribunal}/_search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `APIKey ${apiKey}`
      },
      body: JSON.stringify({
        size: 10,
        query: { match: { "partes.nome": q } }
      })
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      return res.status(response.status).json({ ok: false, error: "DataJud falhou.", data });
    }
    const hits = data?.hits?.hits || [];
    return res.status(200).json({
      ok: true,
      source: "CNJ DataJud",
      items: hits.map((hit) => ({
        title: hit._source?.numeroProcesso || hit._id,
        description: hit._source?.classe?.nome || hit._source?.classeProcessual?.nome || "Processo retornado pelo DataJud",
        raw: hit._source
      }))
    });
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message });
  }
};
