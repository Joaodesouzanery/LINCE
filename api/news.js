function xmlText(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function pick(block, tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return xmlText(match?.[1] || "");
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");

  const query = String(req.query.q || "").trim();
  if (!query) {
    return res.status(400).json({ ok: false, error: "Informe um termo para buscar noticias." });
  }

  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=pt-BR&gl=BR&ceid=BR:pt-419`;

  try {
    const response = await fetch(url, {
      headers: { accept: "application/rss+xml, application/xml, text/xml" }
    });
    const xml = await response.text();
    if (!response.ok) {
      return res.status(response.status).json({ ok: false, error: "Google News RSS nao retornou dados." });
    }
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, 8).map((match) => {
      const block = match[1];
      return {
        title: pick(block, "title"),
        link: pick(block, "link"),
        date: pick(block, "pubDate"),
        source: pick(block, "source") || "Google News",
        summary: pick(block, "description").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
      };
    });

    return res.status(200).json({ ok: true, source: "Google News RSS", fetchedAt: new Date().toISOString(), items });
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message, source: "Google News RSS" });
  }
};
