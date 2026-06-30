// M7 - Grafo nacional de conexoes. Le relationships + entidades do Supabase e
// DERIVA vinculos das tabelas mandates, party_links, deliberations e votes,
// para que o grafo mostre TODAS as conexoes que existem nos dados (nao so a
// tabela relationships). Filtros: ?agency=ANEEL&limit=300 / ?node=person:<uuid>.
const { getSupabase } = require("../lib/supabase");

const KIND_TABLE = {
  agency: { table: "agencies", label: "name", sub: "acronym" },
  person: { table: "people", label: "full_name", sub: "role" },
  company: { table: "companies", label: "legal_name", sub: "cnpj" },
  deliberation: { table: "deliberations", label: "title", sub: "theme" }
};

const k = (kind, id) => `${kind}:${id}`;

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=600");
  try {
    const supabase = getSupabase();
    const limit = Math.min(Number(req.query.limit) || 300, 1000);
    const nodeParam = req.query.node ? String(req.query.node) : null;
    let nKind = null, nId = null;
    if (nodeParam) [nKind, nId] = nodeParam.split(":");

    // Acumuladores comuns: arestas + ids necessarios por tipo + nos sinteticos (party).
    const edges = [];
    const need = { agency: new Set(), person: new Set(), company: new Set(), deliberation: new Set() };
    const synthetic = {}; // id -> node (ex.: party:PT)
    const noteNeed = (kind, id) => { if (need[kind]) need[kind].add(id); };
    const pushEdge = (fromKind, fromId, toKind, toId, relationship, weight, meta) => {
      noteNeed(fromKind, fromId); noteNeed(toKind, toId);
      edges.push({ from: k(fromKind, fromId), to: k(toKind, toId), relationship, weight: weight ?? null, meta: meta || {} });
    };
    // Le com tolerancia a falha: tabela ausente/vazia nao quebra o grafo.
    const safe = async (q) => { try { const { data } = await q; return data || []; } catch { return []; } };

    // 1) Tabela relationships (employs, reported, socio, owns, ...).
    let relRows;
    if (nodeParam) {
      const sel = "from_kind, from_id, to_kind, to_id, relationship, confidence_score, metadata";
      const [a, b] = await Promise.all([
        safe(supabase.from("relationships").select(sel).eq("from_kind", nKind).eq("from_id", nId).limit(limit)),
        safe(supabase.from("relationships").select(sel).eq("to_kind", nKind).eq("to_id", nId).limit(limit))
      ]);
      relRows = [...a, ...b];
    } else {
      relRows = await safe(supabase.from("relationships")
        .select("from_kind, from_id, to_kind, to_id, relationship, confidence_score, metadata").limit(limit));
    }
    const relTruncated = relRows.length >= limit;
    for (const r of relRows) {
      if (!need[r.from_kind] || !need[r.to_kind]) continue;
      pushEdge(r.from_kind, r.from_id, r.to_kind, r.to_id, r.relationship, r.confidence_score, r.metadata);
    }

    // Helper p/ filtrar tabelas derivadas quando ha expansao de no.
    const personFilter = (q) => (nKind === "person" ? q.eq("person_id", nId) : q);
    const agencyFilter = (q) => (nKind === "agency" ? q.eq("agency_id", nId) : q);

    // 2) Mandatos -> pessoa --mandato--> agencia.
    const mandates = await safe(personFilter(agencyFilter(
      supabase.from("mandates").select("person_id, agency_id, role, started_at, ended_at, confidence_score").limit(limit)
    )));
    for (const m of mandates) {
      if (!m.person_id || !m.agency_id) continue;
      pushEdge("person", m.person_id, "agency", m.agency_id, "mandato", m.confidence_score ?? 0.9,
        { role: m.role, started_at: m.started_at, ended_at: m.ended_at });
    }

    // 3) Filiacao partidaria -> pessoa --filiacao/doacao--> partido (no sintetico).
    const parties = await safe(personFilter(
      supabase.from("party_links").select("person_id, party, link_type, reference_year, amount").limit(limit)
    ));
    for (const p of parties) {
      if (!p.person_id || !p.party) continue;
      const partyId = String(p.party).toUpperCase().trim();
      const pid = k("party", partyId);
      synthetic[pid] = { id: pid, type: "party", title: partyId, subtitle: "Partido" };
      need.person.add(p.person_id);
      edges.push({ from: k("person", p.person_id), to: pid, relationship: p.link_type || "filiacao",
        weight: 0.95, meta: { reference_year: p.reference_year, amount: p.amount } });
    }

    // 4) Deliberacoes -> agencia--delibera-->deliberacao; relator--relatou-->deliberacao;
    //    deliberacao--afeta-->empresa.
    const delibs = await safe(agencyFilter(
      supabase.from("deliberations")
        .select("id, agency_id, affected_company_id, rapporteur_person_id, title").limit(limit)
    ));
    for (const d of delibs) {
      if (d.agency_id) pushEdge("agency", d.agency_id, "deliberation", d.id, "delibera", 0.9, {});
      if (d.rapporteur_person_id) pushEdge("person", d.rapporteur_person_id, "deliberation", d.id, "relatou", 0.9, {});
      if (d.affected_company_id) pushEdge("deliberation", d.id, "company", d.affected_company_id, "afeta", 0.9, {});
    }

    // 5) Votos -> votante--votou-->deliberacao.
    const voteFilter = (q) => (nKind === "person" ? q.eq("voter_person_id", nId) : q);
    const votes = await safe(voteFilter(
      supabase.from("votes").select("deliberation_id, voter_person_id, vote_direction, is_dissent").limit(limit)
    ));
    for (const v of votes) {
      if (!v.voter_person_id || !v.deliberation_id) continue;
      pushEdge("person", v.voter_person_id, "deliberation", v.deliberation_id, "votou", 0.9,
        { vote: v.vote_direction, dissent: v.is_dissent });
    }

    // Resolve rotulos das entidades reais.
    const labels = { ...synthetic };
    for (const [kind, cfg] of Object.entries(KIND_TABLE)) {
      const ids = [...need[kind]];
      if (!ids.length) continue;
      const data = await safe(supabase.from(cfg.table).select("*").in("id", ids));
      for (const row of data) {
        labels[k(kind, row.id)] = {
          id: k(kind, row.id), type: kind,
          title: row[cfg.label] || kind, subtitle: row[cfg.sub] || ""
        };
      }
    }

    // Filtro por agencia (sigla): mantem o subgrafo da agencia + seus vizinhos diretos.
    let agencyKey = null;
    if (req.query.agency) {
      const acronym = String(req.query.agency).toUpperCase();
      agencyKey = Object.values(labels).find((n) => n.type === "agency" && (n.subtitle || "").toUpperCase() === acronym)?.id || null;
    }
    let allowed = null;
    if (agencyKey) {
      allowed = new Set([agencyKey]);
      for (const e of edges) {
        if (e.from === agencyKey) allowed.add(e.to);
        if (e.to === agencyKey) allowed.add(e.from);
      }
    }

    // Monta arestas finais (so entre nos com rotulo resolvido / dentro do filtro).
    const finalEdges = [];
    const used = new Set();
    for (const e of edges) {
      if (!labels[e.from] || !labels[e.to]) continue;
      if (allowed && !(allowed.has(e.from) && allowed.has(e.to))) continue;
      finalEdges.push(e);
      used.add(e.from); used.add(e.to);
    }
    const nodes = [...used].map((id) => labels[id]);

    // Contagem honesta para o front sinalizar truncamento.
    const { count: totalRel } = await supabase
      .from("relationships").select("id", { count: "exact", head: true }).then((r) => r).catch(() => ({ count: null }));

    return res.status(200).json({
      ok: true,
      nodes,
      edges: finalEdges,
      meta: {
        limit,
        truncated: relTruncated,
        total_relationships: totalRel ?? null,
        relationship_types: [...new Set(finalEdges.map((e) => e.relationship))].sort()
      },
      fetchedAt: new Date().toISOString()
    });
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message });
  }
};
