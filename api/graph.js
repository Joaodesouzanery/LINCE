// M7 - Grafo nacional de conexoes. Le relationships + entidades do Supabase e
// devolve nodes/edges para o front. Filtros opcionais: ?agency=ANEEL&limit=300
const { getSupabase } = require("../lib/supabase");

const KIND_TABLE = {
  agency: { table: "agencies", label: "name", sub: "acronym" },
  person: { table: "people", label: "full_name", sub: "role" },
  company: { table: "companies", label: "legal_name", sub: "cnpj" }
};

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=600");
  try {
    const supabase = getSupabase();
    const limit = Math.min(Number(req.query.limit) || 300, 1000);

    const { data: rels, error } = await supabase
      .from("relationships")
      .select("from_kind, from_id, to_kind, to_id, relationship, confidence_score, metadata")
      .limit(limit);
    if (error) throw error;

    // Coleta os ids necessarios por tipo.
    const need = { agency: new Set(), person: new Set(), company: new Set() };
    for (const r of rels || []) {
      if (need[r.from_kind]) need[r.from_kind].add(r.from_id);
      if (need[r.to_kind]) need[r.to_kind].add(r.to_id);
    }

    // Resolve rotulos das entidades.
    const labels = {};
    for (const [kind, cfg] of Object.entries(KIND_TABLE)) {
      const ids = [...need[kind]];
      if (!ids.length) continue;
      const { data } = await supabase.from(cfg.table).select("*").in("id", ids);
      for (const row of data || []) {
        labels[`${kind}:${row.id}`] = {
          id: `${kind}:${row.id}`,
          type: kind,
          title: row[cfg.label] || kind,
          subtitle: row[cfg.sub] || ""
        };
      }
    }

    // Filtro por agencia (sigla): mantem so o subgrafo conectado a ela.
    let acronym = req.query.agency ? String(req.query.agency).toUpperCase() : null;
    let agencyKey = null;
    if (acronym) {
      agencyKey = Object.values(labels).find((n) => n.type === "agency" && n.subtitle === acronym)?.id || null;
    }

    const edges = [];
    const used = new Set();
    for (const r of rels || []) {
      const from = `${r.from_kind}:${r.from_id}`;
      const to = `${r.to_kind}:${r.to_id}`;
      if (!labels[from] || !labels[to]) continue;
      if (agencyKey && from !== agencyKey && to !== agencyKey) continue;
      edges.push({ from, to, relationship: r.relationship, weight: r.confidence_score, meta: r.metadata });
      used.add(from); used.add(to);
    }

    const nodes = [...used].map((k) => labels[k]);
    return res.status(200).json({ ok: true, nodes, edges, fetchedAt: new Date().toISOString() });
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message });
  }
};
