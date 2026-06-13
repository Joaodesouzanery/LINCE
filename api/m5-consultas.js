// M5 - Consultas e audiencias publicas abertas nas agencias.
// Busca nos feeds RSS das agencias filtrando por palavras-chave de consulta.
// GET /api/m5-consultas  (lista consultas abertas em todas as agencias)
const { getSupabase } = require("../lib/supabase");

const KEYWORDS = ["consulta publica", "audiencia publica", "tomada de subsidio", "air", "analise de impacto"];

function xmlText(v) {
  return String(v || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function pick(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return xmlText(m?.[1] || "");
}

async function fetchRss(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const xml = await res.text();
    return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((m) => ({
      title: pick(m[1], "title"),
      link: pick(m[1], "link"),
      date: pick(m[1], "pubDate"),
      summary: pick(m[1], "description").slice(0, 300)
    }));
  } catch { return []; }
}

function isConsulta(item) {
  const hay = `${item.title} ${item.summary}`.toLowerCase();
  return KEYWORDS.some((kw) => hay.includes(kw));
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=7200");
  try {
    const supabase = getSupabase();
    const { data: agencies } = await supabase
      .from("agencies")
      .select("acronym, name, collection_rules")
      .eq("sector", "regulatory");

    const results = [];
    await Promise.all((agencies || []).map(async (ag) => {
      const rss = ag.collection_rules?.rss;
      if (!rss) return;
      const items = await fetchRss(rss);
      const consultas = items.filter(isConsulta);
      consultas.forEach((c) => results.push({ agency: ag.acronym, agency_name: ag.name, ...c }));
    }));

    results.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    return res.status(200).json({ ok: true, source: "RSS Agencias", fetchedAt: new Date().toISOString(), items: results });
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message });
  }
};
