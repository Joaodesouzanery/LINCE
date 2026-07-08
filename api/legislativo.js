// M12 - Radar legislativo (Camara/Senado). Hub multiplexado por ?type=.
//   /api/legislativo?type=proposicoes&q=<tema>&casa=both&ano=2026&tipo=PL&limit=20
// APIs abertas e gratuitas; sem chave. Cache de borda longo (dados mudam devagar).
const { searchProposicoes } = require("../lib/legislativo");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=7200");

  const type = String(req.query.type || "proposicoes");

  if (type === "proposicoes") {
    const q = req.query.q ? String(req.query.q) : "";
    if (!q && !req.query.ano) {
      return res.status(400).json({ ok: false, error: "Informe ?q=<tema> (ou ?ano=)." });
    }
    const result = await searchProposicoes({
      q,
      ano: req.query.ano ? Number(req.query.ano) : undefined,
      tipo: req.query.tipo ? String(req.query.tipo) : undefined,
      casa: req.query.casa ? String(req.query.casa) : "both",
      limit: Math.min(Number(req.query.limit) || 20, 100)
    });
    return res.status(200).json({ ...result, fetchedAt: new Date().toISOString() });
  }

  return res.status(400).json({ ok: false, error: `type desconhecido: ${type}` });
};
