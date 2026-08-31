// Feed do Monitor DOU para o front.
// GET /api/dou-feed?days=1|3|7|15|30|60|90   (janela relativa; default 1 = hoje)
// GET /api/dou-feed?date=YYYY-MM-DD          (data unica; tem precedencia sobre days)
// GET /api/dou-feed?agency=ANEEL             (sigla)
// GET /api/dou-feed?limit=N                  (cap 500)
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

    // Janela relativa. Whitelist: valor fora da lista cai no default em vez de virar
    // NaN silencioso. Datas em America/Sao_Paulo — published_at e DATE, e usar UTC
    // faria "Hoje" voltar vazio entre 21h e meia-noite de Brasilia.
    const DIAS_VALIDOS = [1, 3, 7, 15, 30, 60, 90];
    const emSP = (d) => new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit"
    }).format(d);
    const pedido = Number(req.query.days);
    const days = DIAS_VALIDOS.includes(pedido) ? pedido : 1;

    // Teto unico de 500. O antigo era 100 fixo, o que truncava ate o proprio "Hoje"
    // (um dia util publica ~250 atos de agencia) — a tela mostrava 100 e o usuario
    // nao tinha como saber. Com 500, "Hoje" cabe inteiro e janelas longas truncam
    // de forma declarada, que e o comportamento honesto: a lista e uma tela, nao um
    // relatorio. Quem precisa da contagem completa usa a Visao Geral.
    const TETO = 500;
    const pedidoLimite = Number(req.query.limit);
    const limite = Number.isFinite(pedidoLimite) && pedidoLimite > 0
      ? Math.min(pedidoLimite, TETO)
      : TETO;

    let query = supabase
      .from("documents")
      .select("id, title, document_type, published_at, source_url, metadata, agencies(acronym, name)")
      .eq("source_name", "DOU")
      // published_at e DATE (sem hora) -> empates intradia. Desempata por
      // collected_at (timestamp de ingestao): mais recente primeiro, ordem estavel.
      .order("published_at", { ascending: false })
      .order("collected_at", { ascending: false })
      .limit(limite);

    if (agencyId) query = query.eq("agency_id", agencyId);

    // `date` explicito tem precedencia: quem escolheu um dia especifico quer aquele dia.
    let de = null, ate = null;
    if (req.query.date) {
      query = query.eq("published_at", String(req.query.date));
      de = ate = String(req.query.date);
    } else {
      ate = emSP(new Date());
      de = emSP(new Date(Date.now() - (days - 1) * 86400000));
      query = query.gte("published_at", de).lte("published_at", ate);
    }

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

    // truncated honesto: a lista bateu no teto, entao ha mais atos do que o exibido.
    // Vai acompanhado da janela e do limite para o front poder dizer o que nao mediu.
    const truncated = (data || []).length >= limite;
    return res.status(200).json({
      ok: true, source: "DOU", fetchedAt: new Date().toISOString(),
      periodo: { days: req.query.date ? null : days, de, ate },
      limite, truncated, total: items.length, items
    });
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message, source: "DOU" });
  }
};
