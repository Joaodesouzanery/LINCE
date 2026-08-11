// Feed do Monitor DOU para o front. GET /api/dou-feed?date=YYYY-MM-DD&agency=ANEEL
const { getSupabase } = require("../lib/supabase");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=900");
  try {
    const supabase = getSupabase();

    // F-INT1: o filtro de agencia entra NA QUERY (antes filtrava em JS DEPOIS do
    // limit(100) — agencia de menor volume devolvia vazio mesmo com atos na base).
    let agencyId = null;
    if (req.query.agency) {
      const acr = String(req.query.agency).toUpperCase();
      const { data: ag, error: agErr } = await supabase.from("agencies").select("id").eq("acronym", acr).maybeSingle();
      if (agErr) throw agErr; // falha de leitura != sigla inexistente
      if (!ag) return res.status(200).json({ ok: true, source: "DOU", fetchedAt: new Date().toISOString(), truncated: false, items: [] });
      agencyId = ag.id;
    }

    let query = supabase
      .from("documents")
      .select("id, title, document_type, published_at, source_url, metadata, agencies(acronym, name)")
      .eq("source_name", "DOU")
      // published_at e DATE (sem hora) -> empates intradia. Desempata por
      // collected_at (timestamp de ingestao): mais recente primeiro, ordem estavel.
      .order("published_at", { ascending: false })
      .order("collected_at", { ascending: false })
      .limit(100);

    if (agencyId) query = query.eq("agency_id", agencyId);
    if (req.query.date) query = query.eq("published_at", String(req.query.date));

    const { data, error } = await query;
    if (error) throw error;

    const items = (data || []).map((d) => ({
      id: d.id,
      title: d.title,
      type: d.document_type,
      date: d.published_at,
      link: d.source_url,
      agency: d.agencies?.acronym || d.metadata?.agency_acronym || null,
      summary: d.metadata?.ai_summary || null,
      entities: d.metadata?.ai_entities || [],
      // Proveniencia para o front: IA (resumo gerado) x regex (so extracao).
      origin: d.metadata?.ai_summary ? "ia" : "regex",
      confidence: d.metadata?.ai_confidence ?? null
    }));

    const truncated = (data || []).length >= 100;
    return res.status(200).json({ ok: true, source: "DOU", fetchedAt: new Date().toISOString(), truncated, items });
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message, source: "DOU" });
  }
};
