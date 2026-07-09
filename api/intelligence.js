// Motor de Inteligencia Nacional: score de risco por setor/agencia,
// radar de normas dos proximos 30/60/90 dias, resumo executivo diario,
// monitores de vigilancia (CRUD) e resumo executivo de dossie por IA.
// GET /api/intelligence?type=radar|score|daily|monitors|monitor_alerts|holdings
// POST /api/intelligence?type=monitor_save|monitor_toggle|monitor_delete|exec_summary
const { getSupabase } = require("../lib/supabase");
const { normalizeName, onlyDigits } = require("../lib/text");

// Mutacoes e listas de monitor aceitam POST (body JSON) ou GET (querystring).
function params(req) {
  return req.method === "POST" && req.body && typeof req.body === "object" ? req.body : req.query;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=3600");
  const type = String(req.query.type || "radar");

  // Diagnostico: verifica env vars sem expor valores
  if (type === "health") {
    return res.status(200).json({
      ok: true,
      supabase_url: !!process.env.SUPABASE_URL,
      service_key: !!process.env.SUPABASE_SERVICE_KEY,
      inlabs_email: !!process.env.INLABS_EMAIL,
      inlabs_senha: !!process.env.INLABS_SENHA,
      anthropic_key: !!process.env.ANTHROPIC_API_KEY,
      node_version: process.version,
      env: process.env.NODE_ENV || "production"
    });
  }

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
        origin: d.metadata?.ai_summary ? "ia" : "regex",
        link: d.source_url
      }));
      return res.status(200).json({ ok: true, type: "recent", truncated: (docs || []).length >= limit, items });
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
      return res.status(200).json({ ok: true, type: "daily", date: since, truncated: (docs || []).length >= 50, by_agency: byAgency });
    }

    if (type === "score") {
      // Score de risco por agencia. A versao antiga somava VOLUME cru sem janela
      // nem normalizacao -> todas saturavam em 100 (inutil). Agora: atividade
      // recente (90d) + alertas ponderados por severidade, NORMALIZADO entre as
      // agencias (min-max) para diferenciar de fato. docs = total (so display).
      const { data: agencies } = await supabase.from("agencies").select("id, acronym, name").eq("sector", "regulatory");
      const since90 = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
      const SEV_WEIGHT = { high: 3, medium: 2, info: 1, low: 1 };
      const rows = [];
      for (const ag of agencies || []) {
        const [docsTotal, docs90, alerts, mandates] = await Promise.all([
          supabase.from("documents").select("id", { count: "exact", head: true }).eq("agency_id", ag.id).eq("source_name", "DOU"),
          supabase.from("documents").select("id", { count: "exact", head: true }).eq("agency_id", ag.id).eq("source_name", "DOU").gte("published_at", since90),
          supabase.from("alerts").select("severity").eq("target_id", ag.id).is("acknowledged_at", null),
          supabase.from("mandates").select("ended_at").eq("agency_id", ag.id).is("ended_at", null)
        ]);
        const openAlerts = alerts.data || [];
        const weightedAlerts = openAlerts.reduce((s, a) => s + (SEV_WEIGHT[a.severity] || 1), 0);
        // Sinal bruto: atividade recente + peso de alertas (alertas pesam mais).
        const raw = (docs90.count || 0) + weightedAlerts * 15;
        rows.push({
          agency: ag.acronym, name: ag.name,
          docs: docsTotal.count || 0, docs_90d: docs90.count || 0,
          open_alerts: openAlerts.length, weighted_alerts: weightedAlerts,
          active_directors: (mandates.data || []).length, raw
        });
      }
      // Normaliza o sinal bruto para 0-100 entre as agencias (min-max).
      const raws = rows.map((r) => r.raw);
      const min = Math.min(...raws, 0), max = Math.max(...raws, 1);
      const span = max - min || 1;
      const scores = rows
        .map((r) => ({ ...r, score: Math.round(100 * (r.raw - min) / span) }))
        .sort((a, b) => b.score - a.score);
      return res.status(200).json({ ok: true, type: "score", window_days: 90, scores });
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
        .select("person_id, agency_id, role, started_at, ended_at, people(full_name), agencies(acronym)");

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
          name: m.people?.full_name || "?",
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

    if (type === "agency_stats") {
      const acronym = String(req.query.agency || "").toUpperCase();
      if (!acronym) return res.status(400).json({ ok: false, error: "Informe ?agency=SIGLA" });
      const { data: ag } = await supabase.from("agencies").select("id, acronym, name").eq("acronym", acronym).maybeSingle();
      if (!ag) return res.status(404).json({ ok: false, error: "Agência não encontrada" });
      const now = new Date();
      const since30 = new Date(now - 30 * 86400000).toISOString().slice(0, 10);
      const since8w = new Date(now - 56 * 86400000).toISOString().slice(0, 10);
      const [docsTotal, docs30d, alertsRes, mandatesRes, weeklyRes] = await Promise.all([
        supabase.from("documents").select("id", { count: "exact", head: true }).eq("agency_id", ag.id),
        supabase.from("documents").select("id", { count: "exact", head: true }).eq("agency_id", ag.id).gte("published_at", since30),
        supabase.from("alerts").select("id, alert_type, severity, title, body, created_at").eq("target_id", ag.id).is("acknowledged_at", null).order("created_at", { ascending: false }).limit(5),
        supabase.from("mandates").select("id", { count: "exact", head: true }).eq("agency_id", ag.id).is("ended_at", null),
        supabase.from("documents").select("published_at").eq("agency_id", ag.id).gte("published_at", since8w).order("published_at")
      ]);
      const weekBuckets = {};
      for (const d of weeklyRes.data || []) {
        const dt = new Date(d.published_at + "T12:00:00Z");
        dt.setUTCDate(dt.getUTCDate() - dt.getUTCDay());
        const k = dt.toISOString().slice(0, 10);
        weekBuckets[k] = (weekBuckets[k] || 0) + 1;
      }
      const weekly_series = Object.entries(weekBuckets)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([week, total]) => ({ week, total }))
        .slice(-8);
      const baseline_avg = weekly_series.length
        ? Math.round(weekly_series.reduce((s, w) => s + w.total, 0) / weekly_series.length)
        : 0;
      return res.status(200).json({
        ok: true, type: "agency_stats",
        agency: ag.acronym, agency_name: ag.name,
        total_docs: docsTotal.count || 0, docs_30d: docs30d.count || 0,
        open_alerts: alertsRes.data?.length || 0, active_directors: mandatesRes.count || 0,
        weekly_series, baseline_avg, alerts: alertsRes.data || []
      });
    }

    if (type === "dismiss_alert") {
      // Mutacao: nunca deixar o CDN cachear a resposta.
      res.setHeader("Cache-Control", "no-store");
      const id = String(req.query.id || "").trim();
      if (!id) return res.status(400).json({ ok: false, error: "Informe ?id=<uuid>" });
      const { error: upErr } = await supabase.from("alerts").update({ acknowledged_at: new Date().toISOString() }).eq("id", id);
      if (upErr) return res.status(500).json({ ok: false, error: upErr.message });
      return res.status(200).json({ ok: true });
    }

    // ── Monitores de vigilância (estilo Arko Alerta) ────────────────────────
    if (type === "monitors") {
      res.setHeader("Cache-Control", "no-store");
      const { data, error } = await supabase.from("monitors").select("*").order("created_at", { ascending: false });
      if (error) return res.status(500).json({ ok: false, error: error.message });
      return res.status(200).json({ ok: true, items: data || [] });
    }

    if (type === "monitor_save") {
      res.setHeader("Cache-Control", "no-store");
      const p = params(req);
      const kind = String(p.kind || "").trim();
      const label = String(p.label || "").trim();
      const pattern = String(p.pattern || "").trim();
      if (!["keyword", "person", "company", "agency"].includes(kind)) {
        return res.status(400).json({ ok: false, error: "kind invalido. Use: keyword, person, company, agency" });
      }
      const normalized = normalizeName(pattern);
      if (normalized.length < 3) {
        return res.status(400).json({ ok: false, error: "Padrao muito curto (min. 3 caracteres uteis)." });
      }
      const row = {
        kind,
        label: label || pattern,
        pattern,
        normalized_pattern: normalized,
        severity: ["info", "medium", "high"].includes(p.severity) ? p.severity : "medium",
        updated_at: new Date().toISOString()
      };
      const digits = onlyDigits(p.cpf_cnpj);
      if (digits.length === 11 || digits.length === 14) row.cpf_cnpj = digits;
      // kind=agency: resolve a sigla para agency_id (match por UUID no cron).
      if (kind === "agency") {
        const { data: ag } = await supabase.from("agencies").select("id, acronym").eq("acronym", normalized.replace(/\s+/g, "")).maybeSingle();
        if (!ag) return res.status(400).json({ ok: false, error: `Agencia "${pattern}" nao encontrada. Use a sigla (ex.: ANEEL).` });
        row.agency_id = ag.id;
      }
      let result;
      if (p.id) {
        result = await supabase.from("monitors").update(row).eq("id", p.id).select().maybeSingle();
      } else {
        result = await supabase.from("monitors").insert(row).select().maybeSingle();
      }
      if (result.error) return res.status(500).json({ ok: false, error: result.error.message });
      if (!result.data) return res.status(404).json({ ok: false, error: "Monitor nao encontrado." });
      return res.status(200).json({ ok: true, monitor: result.data });
    }

    if (type === "monitor_toggle") {
      res.setHeader("Cache-Control", "no-store");
      const p = params(req);
      const id = String(p.id || "").trim();
      if (!id) return res.status(400).json({ ok: false, error: "Informe id" });
      const { data: cur } = await supabase.from("monitors").select("active").eq("id", id).maybeSingle();
      if (!cur) return res.status(404).json({ ok: false, error: "Monitor nao encontrado." });
      const active = typeof p.active === "boolean" ? p.active : String(p.active || "") === "true" ? true : String(p.active || "") === "false" ? false : !cur.active;
      const { error: upErr } = await supabase.from("monitors").update({ active, updated_at: new Date().toISOString() }).eq("id", id);
      if (upErr) return res.status(500).json({ ok: false, error: upErr.message });
      return res.status(200).json({ ok: true, active });
    }

    if (type === "monitor_delete") {
      res.setHeader("Cache-Control", "no-store");
      const p = params(req);
      const id = String(p.id || "").trim();
      if (!id) return res.status(400).json({ ok: false, error: "Informe id" });
      const { error: delErr } = await supabase.from("monitors").delete().eq("id", id);
      if (delErr) return res.status(500).json({ ok: false, error: delErr.message });
      return res.status(200).json({ ok: true });
    }

    if (type === "monitor_alerts") {
      res.setHeader("Cache-Control", "no-store");
      const limit = Math.min(Number(req.query.limit) || 30, 100);
      const { data, error } = await supabase
        .from("alerts")
        .select("id, alert_type, severity, title, body, created_at, metadata, acknowledged_at")
        .eq("alert_type", "monitor")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) return res.status(500).json({ ok: false, error: error.message });
      return res.status(200).json({ ok: true, items: data || [] });
    }

    // Participacoes societarias locais de uma empresa (base receita_socio).
    if (type === "holdings") {
      const cnpj = onlyDigits(req.query.cnpj);
      if (cnpj.length !== 14) return res.status(400).json({ ok: false, error: "CNPJ invalido." });
      const { data: company } = await supabase.from("companies").select("id, cnpj, legal_name").eq("cnpj", cnpj).maybeSingle();
      if (!company) return res.status(200).json({ ok: true, items: [], note: "Empresa fora da base local. Rode load:receita-socio." });
      const { data: rels } = await supabase
        .from("relationships")
        .select("from_id, relationship, metadata, created_at")
        .eq("to_kind", "company").eq("to_id", company.id).eq("relationship", "socio");
      const personIds = [...new Set((rels || []).map((r) => r.from_id))];
      let people = [];
      if (personIds.length) {
        const { data: ppl } = await supabase.from("people").select("id, full_name, role").in("id", personIds);
        people = ppl || [];
      }
      const byId = Object.fromEntries(people.map((p) => [p.id, p]));
      const items = (rels || []).map((r) => ({
        person_id: r.from_id,
        name: byId[r.from_id]?.full_name || "?",
        role: r.metadata?.role || byId[r.from_id]?.role || "Sócio",
        source: "Receita Federal (dump SOCIO)"
      }));
      return res.status(200).json({ ok: true, company: company.legal_name, items });
    }

    // Score de risco politico de uma pessoa (inteligencia politica estilo Arko).
    // Componentes rastreaveis: filiacao/doacao partidaria, porta giratoria
    // (dirigente + socio), rede societaria e empresas inaptas. ?id=<uuid pessoa>.
    if (type === "political_risk") {
      const id = String(req.query.id || "").trim();
      if (!id) return res.status(400).json({ ok: false, error: "Informe ?id=<uuid da pessoa>" });
      const { data: person } = await supabase.from("people").select("id, full_name, role").eq("id", id).maybeSingle();
      if (!person) return res.status(404).json({ ok: false, error: "Pessoa nao encontrada." });

      const [partyRes, mandatesRes, socioRes] = await Promise.all([
        supabase.from("party_links").select("party, link_type, amount, reference_year").eq("person_id", id),
        supabase.from("mandates").select("agency_id, role, ended_at").eq("person_id", id),
        // relationships e polimorfica (to_id sem FK) -> NAO da para usar embed
        // companies(...). Busca so os ids/metadata e resolve as empresas depois.
        supabase.from("relationships")
          .select("to_id, metadata")
          .eq("from_kind", "person").eq("from_id", id)
          .eq("to_kind", "company").eq("relationship", "socio")
      ]);

      const parties = partyRes.data || [];
      const mandates = mandatesRes.data || [];
      const socioRels = socioRes.data || [];
      // 2a query: resolve empresas por id (padrao de api/dossier-person.js).
      let companiesById = {};
      if (socioRels.length) {
        const ids = [...new Set(socioRels.map((r) => r.to_id))];
        const { data: comps } = await supabase
          .from("companies").select("id, cnpj, legal_name, registration_status").in("id", ids);
        companiesById = Object.fromEntries((comps || []).map((c) => [c.id, c]));
      }
      const socio = socioRels.map((r) => ({ ...r, companies: companiesById[r.to_id] || null }));
      const activeMandate = mandates.some((m) => !m.ended_at);
      const inactiveCompanies = socio.filter(
        (r) => r.companies?.registration_status && !/ativ/i.test(r.companies.registration_status)
      ).length;

      // Componentes 0-100 (transparentes: o front pode exibir o detalhamento).
      const components = {
        partidario: Math.min(30, parties.length * 15),
        porta_giratoria: activeMandate && socio.length ? 25 : 0,
        rede_societaria: Math.min(25, socio.length * 5),
        empresas_inaptas: Math.min(20, inactiveCompanies * 10)
      };
      const score = Math.min(100, Object.values(components).reduce((a, b) => a + b, 0));
      const band = score >= 70 ? "alto" : score >= 40 ? "medio" : "baixo";

      return res.status(200).json({
        ok: true, type: "political_risk",
        person: { id: person.id, name: person.full_name, role: person.role },
        score, band, components,
        signals: {
          parties: parties.map((p) => ({ party: p.party, type: p.link_type, amount: p.amount, year: p.reference_year })),
          active_mandate: activeMandate,
          mandate_count: mandates.length,
          companies: socio.map((r) => ({
            cnpj: r.companies?.cnpj, legal_name: r.companies?.legal_name,
            status: r.companies?.registration_status, role: r.metadata?.role
          })),
          inactive_companies: inactiveCompanies
        }
      });
    }

    // Radar de Risco & Oportunidade (estilo Arko + Sherlocker). Sintetiza 4
    // angulos a partir do que ja existe: (1) porta giratoria/captura, (2)
    // contratos a vencer, (3) consultas abertas, (4) proposicoes legislativas.
    if (type === "radar_intel") {
      res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=1800");
      const today = new Date().toISOString().slice(0, 10);
      const in90 = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
      const since45 = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);

      // RISCO — porta giratoria: diretor ativo que tambem e socio de empresa(s).
      async function computeRisks() {
        const { data: activeMandates } = await supabase
          .from("mandates")
          .select("person_id, role, agency_id, people(full_name), agencies(acronym)")
          .is("ended_at", null).limit(2000);
        const dirIds = [...new Set((activeMandates || []).map((m) => m.person_id).filter(Boolean))];
        if (!dirIds.length) return [];
        const { data: socioRels } = await supabase
          .from("relationships").select("from_id, to_id, metadata")
          .eq("from_kind", "person").eq("to_kind", "company").eq("relationship", "socio")
          .in("from_id", dirIds).limit(4000);
        const compIds = [...new Set((socioRels || []).map((r) => r.to_id))];
        let compById = {};
        if (compIds.length) {
          const { data: comps } = await supabase.from("companies")
            .select("id, cnpj, legal_name, registration_status").in("id", compIds);
          compById = Object.fromEntries((comps || []).map((c) => [c.id, c]));
        }
        const byPerson = {};
        for (const r of socioRels || []) {
          const c = compById[r.to_id]; if (!c) continue;
          (byPerson[r.from_id] = byPerson[r.from_id] || []).push({ ...c, socio_role: r.metadata?.role });
        }
        const seen = new Set(), out = [];
        for (const m of activeMandates || []) {
          const comps = byPerson[m.person_id];
          if (!comps || seen.has(m.person_id)) continue;
          seen.add(m.person_id);
          const inaptas = comps.filter((c) => c.registration_status && !/ativ/i.test(c.registration_status)).length;
          out.push({
            kind: "porta_giratoria", person_id: m.person_id, name: m.people?.full_name || "?",
            agency: m.agencies?.acronym || null, role: m.role || null,
            companies: comps.length, inaptas, severity: inaptas ? "high" : "medium"
          });
        }
        return out.sort((a, b) => (b.inaptas - a.inaptas) || (b.companies - a.companies)).slice(0, 30);
      }

      // OPORTUNIDADE — contratos a vencer nos proximos 90 dias.
      async function computeContracts() {
        const { data } = await supabase.from("contracts")
          .select("object, supplier_name, ends_at, value, agencies(acronym)")
          .gte("ends_at", today).lte("ends_at", in90).order("ends_at").limit(40);
        return (data || []).map((c) => ({
          kind: "contrato_vencendo", label: (c.object || "Contrato").slice(0, 140),
          supplier: c.supplier_name || null, agency: c.agencies?.acronym || null,
          ends_at: c.ends_at, value: c.value || null
        }));
      }

      // OPORTUNIDADE — consultas/audiencias publicas abertas (dos atos do DOU).
      async function computeConsultas() {
        const { data } = await supabase.from("documents")
          .select("title, published_at, source_url, agencies(acronym)")
          .eq("source_name", "DOU").gte("published_at", since45)
          .or("title.ilike.%consulta p%,title.ilike.%audi%,title.ilike.%tomada de subs%")
          .order("published_at", { ascending: false }).limit(25);
        return (data || []).map((d) => ({
          kind: "consulta_aberta", label: d.title, agency: d.agencies?.acronym || null,
          date: d.published_at, link: d.source_url
        }));
      }

      // LEGISLATIVO — proposicoes recentes (Camara/Senado). Degrada se a API cair.
      async function computeLegislative() {
        try {
          const { searchProposicoes } = require("../lib/legislativo");
          const year = new Date().getFullYear();
          const r = await searchProposicoes({ ano: year, limit: 8 });
          return (r.items || []).map((p) => ({
            kind: "proposicao", titulo: p.titulo, casa: p.casa,
            ementa: (p.ementa || "").slice(0, 200), url: p.url
          }));
        } catch { return []; }
      }

      const [risksP, contractsP, consultasP, legisP] = await Promise.allSettled([
        computeRisks(), computeContracts(), computeConsultas(), computeLegislative()
      ]);
      const val = (p) => (p.status === "fulfilled" ? p.value : []);
      const risks = val(risksP);
      const opportunities = [...val(contractsP), ...val(consultasP)];
      const legislative = val(legisP);

      return res.status(200).json({
        ok: true, type: "radar_intel",
        counts: { risks: risks.length, opportunities: opportunities.length, legislative: legislative.length },
        risks, opportunities, legislative,
        fetchedAt: new Date().toISOString()
      });
    }

    // Resumo executivo IA do dossie de EMPRESA (o front envia o dossie compacto
    // ja montado em state; o de pessoa usa /api/dossier-person?id=&ai=1).
    if (type === "exec_summary") {
      res.setHeader("Cache-Control", "no-store");
      if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST com o dossie no body." });
      const { summarizeDossier } = require("../lib/anthropic");
      const dossier = req.body && typeof req.body === "object" ? req.body : null;
      if (!dossier) return res.status(400).json({ ok: false, error: "Body JSON ausente." });
      const ai = await summarizeDossier(dossier);
      return res.status(200).json({ ok: true, ...ai });
    }

    if (type === "search") {
      const q = String(req.query.q || "").trim();
      if (!q) return res.status(400).json({ ok: false, error: "Informe ?q=termo" });
      const agency = req.query.agency ? String(req.query.agency).toUpperCase() : null;
      const limit = Math.min(Number(req.query.limit) || 30, 100);
      const term = `%${q.replace(/\s+/g, "%")}%`;
      let query = supabase
        .from("documents")
        .select("id, title, document_type, published_at, source_url, metadata, agencies(acronym)")
        .ilike("extracted_text", term)
        .eq("source_name", "DOU")
        .order("published_at", { ascending: false })
        .limit(limit);
      const { data: docs } = await query;
      let items = (docs || []).map((d) => ({
        id: d.id,
        title: d.title,
        type: d.document_type,
        date: d.published_at,
        agency: d.agencies?.acronym || d.metadata?.agency_acronym || "?",
        link: d.source_url
      }));
      if (agency) items = items.filter((i) => i.agency === agency);
      return res.status(200).json({ ok: true, type: "search", q, total: items.length, items });
    }

    if (type === "alerts") {
      const limit = Math.min(Number(req.query.limit) || 20, 100);
      const { data: alerts } = await supabase
        .from("alerts")
        .select("id, alert_type, severity, title, body, created_at, metadata")
        .is("acknowledged_at", null)
        .order("created_at", { ascending: false })
        .limit(limit);
      return res.status(200).json({ ok: true, type: "alerts", items: alerts || [] });
    }

    return res.status(400).json({ ok: false, error: "type invalido. Use: radar, radar_intel, score, daily, trend, recent, giratoria, political_risk, search, alerts, agency_stats, dismiss_alert, monitors, monitor_save, monitor_toggle, monitor_delete, monitor_alerts, holdings, exec_summary" });
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message });
  }
};
