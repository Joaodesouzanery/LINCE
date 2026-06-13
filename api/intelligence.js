// Motor de Inteligencia Nacional: score de risco por setor/agencia,
// radar de normas dos proximos 30/60/90 dias, e resumo executivo diario.
// GET /api/intelligence?type=radar|score|daily
const { getSupabase } = require("../lib/supabase");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=3600");
  const type = String(req.query.type || "radar");
  try {
    const supabase = getSupabase();

    if (type === "trend") {
      // Serie temporal de atos para o grafico de tendencia (ultimos N dias).
      const days = Math.min(Number(req.query.days) || 30, 90);
      const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      const { data: docs } = await supabase
        .from("documents")
        .select("published_at, document_type")
        .eq("source_name", "DOU")
        .gte("published_at", since)
        .order("published_at", { ascending: true })
        .limit(5000);
      const buckets = {};
      for (const d of docs || []) {
        const k = d.published_at;
        if (!buckets[k]) buckets[k] = { date: k, norma: 0, ato_pessoal: 0, contrato: 0, total: 0 };
        const t = d.document_type === "norma" || d.document_type === "ato_pessoal" || d.document_type === "contrato" ? d.document_type : "norma";
        buckets[k][t]++; buckets[k].total++;
      }
      const series = Object.values(buckets).sort((a, b) => a.date.localeCompare(b.date));
      const total = (docs || []).length;
      return res.status(200).json({ ok: true, type: "trend", days, total, series });
    }

    if (type === "recent") {
      // Atos mais recentes para a tabela do dashboard.
      const limit = Math.min(Number(req.query.limit) || 20, 100);
      const { data: docs } = await supabase
        .from("documents")
        .select("id, title, document_type, published_at, source_url, metadata, agencies(acronym)")
        .eq("source_name", "DOU")
        .order("published_at", { ascending: false })
        .limit(limit);
      const items = (docs || []).map((d) => ({
        id: d.id,
        title: d.title,
        type: d.document_type,
        date: d.published_at,
        agency: d.agencies?.acronym || d.metadata?.agency_acronym || "?",
        summary: d.metadata?.ai_summary || null,
        confidence: d.metadata?.ai_confidence ?? null,
        link: d.source_url
      }));
      return res.status(200).json({ ok: true, type: "recent", items });
    }

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

    if (type === "giratoria") {
      // Porta giratoria: diretores (mandatos em agencias) que tambem sao socios
      // de empresas com contratos ou relacoes com agencias reguladoras.
      const { data: mandates } = await supabase
        .from("mandates")
        .select("person_id, agency_id, role, started_at, ended_at, people(name), agencies(acronym)");

      const personIds = [...new Set((mandates || []).map((m) => m.person_id))];
      if (personIds.length === 0) return res.status(200).json({ ok: true, type: "giratoria", cases: [] });

      // Busca relacoes de socio dessas pessoas com empresas
      const { data: socioRels } = await supabase
        .from("relationships")
        .select("from_id, to_id, metadata, companies(cnpj, legal_name)")
        .eq("from_kind", "person")
        .eq("to_kind", "company")
        .eq("relationship", "socio")
        .in("from_id", personIds);

      // Busca filiacao partidaria
      const { data: partyLinks } = await supabase
        .from("party_links")
        .select("person_id, party, joined_at, status")
        .in("person_id", personIds);

      const partyByPerson = {};
      for (const pl of partyLinks || []) {
        if (!partyByPerson[pl.person_id]) partyByPerson[pl.person_id] = [];
        partyByPerson[pl.person_id].push(pl);
      }

      const socioByPerson = {};
      for (const r of socioRels || []) {
        if (!socioByPerson[r.from_id]) socioByPerson[r.from_id] = [];
        socioByPerson[r.from_id].push({ company: r.companies?.legal_name, cnpj: r.companies?.cnpj, role: r.metadata?.role });
      }

      // Monta casos de porta giratoria (diretor + vinculo empresarial)
      const seen = new Set();
      const cases = [];
      for (const m of mandates || []) {
        if (!socioByPerson[m.person_id] && !partyByPerson[m.person_id]) continue;
        const key = m.person_id;
        if (seen.has(key)) continue;
        seen.add(key);
        cases.push({
          person_id: m.person_id,
          name: m.people?.name || "?",
          agency: m.agencies?.acronym,
          role: m.role,
          mandate_from: m.started_at,
          mandate_to: m.ended_at,
          companies: socioByPerson[m.person_id] || [],
          parties: (partyByPerson[m.person_id] || []).map((pl) => pl.party)
        });
      }
      cases.sort((a, b) => b.companies.length - a.companies.length);
      return res.status(200).json({ ok: true, type: "giratoria", total: cases.length, cases });
    }

    return res.status(400).json({ ok: false, error: "type invalido. Use: radar, score, daily, trend, recent, giratoria" });
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message });
  }
};
