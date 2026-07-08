// M5 + M8 + M12 unificados. GET /api/rss-feeds?type=consultas|agenda|proposicoes
// type=consultas   -> consultas e audiencias publicas abertas
// type=agenda      -> pautas e reunioes de Diretoria Colegiada
// type=proposicoes -> radar legislativo Camara/Senado (?q=<tema>&casa=both)
// Filtros opcionais (consultas/agenda): ?sector=energia|saude|... ou ?agency=SIGLA.
// Consolidado aqui (nao em api/legislativo.js) para respeitar o limite de 12
// funcoes serverless do plano Hobby da Vercel.
const { getSupabase } = require("../lib/supabase");
const { searchProposicoes } = require("../lib/legislativo");

const CONSULTAS_KW = ["consulta publica", "audiencia publica", "tomada de subsidio", "air", "analise de impacto"];
const AGENDA_KW    = ["reuniao", "pauta", "deliberacao", "diretoria colegiada", "sessao", "julgamento", "resolucao"];

// Radar setorial: recorte tematico das agencias reguladoras (todas tem
// sector='regulatory' no banco; este mapa da o setor economico p/ o filtro).
const SECTOR_THEMES = {
  energia: ["ANEEL", "ANP", "ANM"],
  telecom: ["ANATEL", "ANCINE"],
  saude: ["ANVISA", "ANS"],
  transporte: ["ANTT", "ANTAQ", "ANAC", "ARTESP"],
  saneamento: ["ANA"]
};

function xmlText(v) {
  return String(v||"").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,"$1")
    .replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"')
    .replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
}
function pick(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`,"i"));
  return xmlText(m?.[1]||"");
}
// Extrai o href de um <link .../> Atom (o texto de <link> costuma ser vazio).
function pickLink(block) {
  const direct = pick(block, "link");
  if (direct) return direct;
  const m = block.match(/<link[^>]*href="([^"]+)"/i);
  return m ? m[1] : "";
}
// Suporta RSS (<item>) e Atom (<entry>) — o gov.br mistura os dois formatos.
async function fetchRss(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000),
      headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" } });
    if (!res.ok) return [];
    const xml = await res.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(m => ({
      title: pick(m[1], "title"), link: pickLink(m[1]),
      date: pick(m[1], "pubDate"), summary: pick(m[1], "description").slice(0, 300)
    }));
    if (items.length) return items;
    // Fallback Atom.
    return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map(m => ({
      title: pick(m[1], "title"), link: pickLink(m[1]),
      date: pick(m[1], "updated") || pick(m[1], "published"),
      summary: (pick(m[1], "summary") || pick(m[1], "content")).slice(0, 300)
    }));
  } catch { return []; }
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=7200");
  const type = String(req.query.type || "consultas");

  // Radar legislativo (M12): Camara/Senado via APIs abertas. Nao usa Supabase.
  if (type === "proposicoes") {
    res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=7200");
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
    return res.status(200).json({ ...result, type, fetchedAt: new Date().toISOString() });
  }

  const keywords = type === "agenda" ? AGENDA_KW : CONSULTAS_KW;
  const sector = req.query.sector ? String(req.query.sector).toLowerCase() : null;
  const agencyFilter = req.query.agency ? String(req.query.agency).toUpperCase() : null;
  try {
    const supabase = getSupabase();
    const { data: allAgencies } = await supabase.from("agencies").select("acronym,name,collection_rules").eq("sector","regulatory");
    // Aplica recorte setorial / por agencia (radar setorial estilo Arko).
    const sectorSet = sector && SECTOR_THEMES[sector] ? new Set(SECTOR_THEMES[sector]) : null;
    const agencies = (allAgencies || []).filter((ag) =>
      (!sectorSet || sectorSet.has(ag.acronym)) && (!agencyFilter || ag.acronym === agencyFilter));
    const results = [];
    await Promise.all((agencies||[]).map(async ag => {
      const rss = ag.collection_rules?.rss;
      if (!rss) return;
      const items = await fetchRss(rss);
      items.filter(i => keywords.some(kw => `${i.title} ${i.summary}`.toLowerCase().includes(kw)))
           .forEach(c => results.push({ agency: ag.acronym, agency_name: ag.name, ...c }));
    }));
    results.sort((a,b) => new Date(b.date||0)-new Date(a.date||0));

    // Fallback DOU: se o RSS das agencias nao retornou nada (feeds gov.br
    // frequentemente quebrados), busca consultas/pautas nos atos do DOU ja
    // ingeridos. Garante que a aba nunca fique vazia com dado confiavel.
    if (!results.length) {
      const acronyms = new Set(agencies.map((a) => a.acronym));
      const dou = await douFallback(supabase, type, acronyms.size ? acronyms : null);
      if (dou.length) {
        return res.status(200).json({ ok:true, type, sector: sector || null, sectors: Object.keys(SECTOR_THEMES),
          source:"DOU (fallback)", fetchedAt:new Date().toISOString(), items:dou });
      }
    }

    return res.status(200).json({ ok:true, type, sector: sector || null, sectors: Object.keys(SECTOR_THEMES),
      source:"RSS Agencias", fetchedAt:new Date().toISOString(), items:results });
  } catch(error) {
    return res.status(502).json({ ok:false, error:error.message });
  }
};

// Termos sem acento (ilike e sensivel a acento): casam titulos do DOU com ou
// sem acentuacao. Ex.: "reuni" -> "reuniao"/"reunião"; "audi" -> "audiencia".
const DOU_CONSULTAS = ["consulta p", "audi", "tomada de subs", "analise de impacto"];
const DOU_AGENDA    = ["pauta", "reuni", "delibera", "sess", "resolu"];

async function douFallback(supabase, type, acronymSet) {
  const patterns = type === "agenda" ? DOU_AGENDA : DOU_CONSULTAS;
  const orExpr = patterns.map((p) => `title.ilike.%${p}%`).join(",");
  const { data } = await supabase
    .from("documents")
    .select("title, published_at, source_url, metadata, agencies(acronym, name)")
    .eq("source_name", "DOU")
    .or(orExpr)
    .order("published_at", { ascending: false })
    .limit(60);
  const items = [];
  for (const d of data || []) {
    const acronym = d.agencies?.acronym || d.metadata?.agency_acronym || null;
    if (acronymSet && acronym && !acronymSet.has(acronym)) continue;
    if (acronymSet && !acronym) continue; // sem agencia identificada e ha filtro -> pula
    items.push({
      agency: acronym || "DOU", agency_name: d.agencies?.name || "Diario Oficial",
      title: d.title, link: d.source_url,
      date: d.published_at, summary: (d.metadata?.ai_summary || "").slice(0, 300)
    });
  }
  return items.slice(0, 40);
}
