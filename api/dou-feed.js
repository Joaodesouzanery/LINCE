// Feed do Monitor DOU para o front. GET /api/dou-feed?date=YYYY-MM-DD&agency=ANEEL
const { getSupabase } = require("../lib/supabase");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=900");
  try {
    const supabase = getSupabase();
    let query = supabase
      .from("documents")
      .select("id, title, document_type, published_at, source_url, metadata, agencies(acronym, name)")
      .eq("source_name", "DOU")
      .order("published_at", { ascending: false })
      .limit(100);

    if (req.query.date) query = query.eq("published_at", String(req.query.date));

    const { data, error } = await query;
    if (error) throw error;

    let items = (data || []).map((d) => ({
      id: d.id,
      title: d.title,
      type: d.document_type,
      date: d.published_at,
      link: d.source_url,
      agency: d.agencies?.acronym || d.metadata?.agency_acronym || null,
      summary: d.metadata?.ai_summary || null,
      entities: d.metadata?.ai_entities || []
    }));

    if (req.query.agency) {
      const acr = String(req.query.agency).toUpperCase();
      items = items.filter((i) => i.agency === acr);
    }

    return res.status(200).json({ ok: true, source: "DOU", fetchedAt: new Date().toISOString(), items });
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message, source: "DOU" });
  }
};
