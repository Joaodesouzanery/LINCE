// Motor de Inteligencia Nacional: score de risco por setor/agencia,
// radar de normas dos proximos 30/60/90 dias, e resumo executivo diario.
// GET /api/intelligence?type=radar|score|daily
const { getSupabase } = require("../lib/supabase");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=3600");
  const type = String(req.query.type || "radar");
  try {
    const supabase = getSupabase();

    if (type === "daily") {
      // Resumo executivo: atos das ultimas 24h por agencia
      const since = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const { data: docs } = await supabase
        .from("documents")
        .select("title, document_type, published_at, metadata, agencies(acronym)")
        .eq("source_name", "DOU")
        .gte("published_at", since)
        .order("published_at", { ascending: false })
        .limit(50);

      const byAgency = {};
      for (const d of docs || []) {
        const ac = d.agencies?.acronym || d.metadata?.agency_acronym || "?";
        if (!byAgency[ac]) byAgency[ac] = { normas: 0, pessoal: 0, contratos: 0, destaques: [] };
        if (d.document_type === "norma") byAgency[ac].normas++;
        else if (d.document_type === "ato_pessoal") byAgency[ac].pessoal++;
        else if (d.document_type === "contrato") byAgency[ac].contratos++;
        if (d.metadata?.ai_summary) byAgency[ac].destaques.push(d.metadata.ai_summary);
      }
      return res.status(200).json({ ok: true, type: "daily", date: since, by_agency: byAgency });
    }

    if (type === "score") {
      // Score de risco por agencia: volume de atos + alertas + mandatos prestes a vencer
      const { data: agencies } = await supabase.from("agencies").select("id, acronym, name").eq("sector", "regulatory");
      const scores = [];
      for (const ag of agencies || []) {
        const [docs, alerts, mandates] = await Promise.all([
          supabase.from("documents").select("id", { count: "exact" }).eq("agency_id", ag.id).eq("source_name", "DOU"),
          supabase.from("alerts").select("severity", { count: "exact" }).eq("target_id", ag.id).is("acknowledged_at", null),
          supabase.from("mandates").select("ended_at").eq("agency_id", ag.id).is("ended_at", null)
        ]);
        const docCount = docs.count || 0;
        const alertCount = alerts.count || 0;
        const activeDirectors = (mandates.data || []).length;
        // Score 0-100: mais atos + mais alertas nao reconhecidos = risco mais alto
        const score = Math.min(100, Math.round((alertCount * 30) + (docCount / 10)));
        scores.push({ agency: ag.acronym, name: ag.name, score, docs: docCount, open_alerts: alertCount, active_directors: activeDirectors });
      }
      scores.sort((a, b) => b.score - a.score);
      return res.status(200).json({ ok: true, type: "score", scores });
    }

    // Radar 30/60/90: atos mais recentes agrupados por periodo
    if (type === "radar") {
      const now = new Date();
      const d30 = new Date(now); d30.setDate(d30.getDate() + 30);
      const d60 = new Date(now); d60.setDate(d60.getDate() + 60);
      const d90 = new Date(now); d90.setDate(d90.getDate() + 90);

      // Documentos recentes cujos contratos ou mandatos vencem nos proximos 90 dias
      const { data: contracts } = await supabase
        .from("contracts")
        .select("object, supplier_name, ends_at, agencies(acronym)")
        .lte("ends_at", d90.toISOString().slice(0, 10))
        .gte("ends_at", now.toISOString().slice(0, 10))
        .order("ends_at");

      const radar = { "30d": [], "60d": [], "90d": [] };
      for (const c of contracts || []) {
        const end = new Date(c.ends_at);
        const entry = {
          type: "contrato",
          agency: c.agencies?.acronym,
          label: (c.object || "").slice(0, 80),
          supplier: c.supplier_name,
          date: c.ends_at
        };
        if (end <= d30) radar["30d"].push(entry);
        else if (end <= d60) radar["60d"].push(entry);
        else radar["90d"].push(entry);
      }
      return res.status(200).json({ ok: true, type: "radar", radar });
    }

    return res.status(400).json({ ok: false, error: "type invalido. Use: radar, score, daily" });
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message });
  }
};
