// M5 + M8 unificados. GET /api/rss-feeds?type=consultas|agenda
// type=consultas  -> consultas e audiencias publicas abertas
// type=agenda     -> pautas e reunioes de Diretoria Colegiada
const { getSupabase } = require("../lib/supabase");

const CONSULTAS_KW = ["consulta publica", "audiencia publica", "tomada de subsidio", "air", "analise de impacto"];
const AGENDA_KW    = ["reuniao", "pauta", "deliberacao", "diretoria colegiada", "sessao", "julgamento", "resolucao"];

function xmlText(v) {
  return String(v||"").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,"$1")
    .replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"')
    .replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
}
function pick(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`,"i"));
  return xmlText(m?.[1]||"");
}
async function fetchRss(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const xml = await res.text();
    return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(m=>({
      title: pick(m[1],"title"), link: pick(m[1],"link"),
      date: pick(m[1],"pubDate"), summary: pick(m[1],"description").slice(0,300)
    }));
  } catch { return []; }
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=7200");
  const type = String(req.query.type || "consultas");
  const keywords = type === "agenda" ? AGENDA_KW : CONSULTAS_KW;
  try {
    const supabase = getSupabase();
    const { data: agencies } = await supabase.from("agencies").select("acronym,name,collection_rules").eq("sector","regulatory");
    const results = [];
    await Promise.all((agencies||[]).map(async ag => {
      const rss = ag.collection_rules?.rss;
      if (!rss) return;
      const items = await fetchRss(rss);
      items.filter(i => keywords.some(kw => `${i.title} ${i.summary}`.toLowerCase().includes(kw)))
           .forEach(c => results.push({ agency: ag.acronym, agency_name: ag.name, ...c }));
    }));
    results.sort((a,b) => new Date(b.date||0)-new Date(a.date||0));
    return res.status(200).json({ ok:true, type, source:"RSS Agencias", fetchedAt:new Date().toISOString(), items:results });
  } catch(error) {
    return res.status(502).json({ ok:false, error:error.message });
  }
};
