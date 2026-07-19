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
const safeRun = async (q) => { try { const { data } = await q; return data || []; } catch { return []; } };

// Metadados extras p/ o cartao do grafo (estilo Sherlocker): situacao cadastral
// e CNPJ da empresa. Alimenta o badge "Inativo" e o doc no cartao. Pessoa nao
// expoe CPF (LGPD) — so o papel, que ja vai no subtitle.
function nodeMeta(kind, row) {
  if (kind === "company") return { situacao: row.registration_status || null, cnpj: row.cnpj || null };
  return {};
}

// Expansao BFS de vinculo societario a partir de um no. Percorre relationships
// 'socio'/'owns' (person->company e company->company) ate `depth` niveis, revelando
// a rede indireta (holdings, socios de socios, "laranjas"). Retorna {nodes, edges}.
async function expandSocio(supabase, startKind, startId, depth, limit) {
  const visited = new Set();
  const edges = [];
  const edgeSeen = new Set();
  const needByKind = {}; // kind -> Set(ids) para resolver rotulos depois
  const note = (kind, id) => { (needByKind[kind] = needByKind[kind] || new Set()).add(id); };

  let frontier = [{ kind: startKind, id: startId, d: 0 }];
  note(startKind, startId);

  while (frontier.length && visited.size < limit) {
    const next = [];
    for (const cur of frontier) {
      const key = k(cur.kind, cur.id);
      if (visited.has(key)) continue;
      visited.add(key);
      if (cur.d >= depth) continue;

      const sel = "from_kind, from_id, to_kind, to_id, relationship, confidence_score, metadata";
      const [outRels, inRels] = await Promise.all([
        safeRun(supabase.from("relationships").select(sel)
          .eq("from_kind", cur.kind).eq("from_id", cur.id).in("relationship", ["socio", "owns"]).limit(limit)),
        safeRun(supabase.from("relationships").select(sel)
          .eq("to_kind", cur.kind).eq("to_id", cur.id).in("relationship", ["socio", "owns"]).limit(limit))
      ]);

      for (const r of [...outRels, ...inRels]) {
        const edgeKey = `${r.from_kind}:${r.from_id}->${r.to_kind}:${r.to_id}:${r.relationship}`;
        if (!edgeSeen.has(edgeKey)) {
          edgeSeen.add(edgeKey);
          edges.push({ from: k(r.from_kind, r.from_id), to: k(r.to_kind, r.to_id),
            relationship: r.relationship, weight: r.confidence_score ?? null, meta: r.metadata || {} });
        }
        // Enfileira o vizinho (a outra ponta da aresta).
        const neigh = (r.from_kind === cur.kind && r.from_id === cur.id)
          ? { kind: r.to_kind, id: r.to_id } : { kind: r.from_kind, id: r.from_id };
        note(neigh.kind, neigh.id);
        if (!visited.has(k(neigh.kind, neigh.id))) next.push({ ...neigh, d: cur.d + 1 });
      }
    }
    frontier = next;
  }

  // Resolve rotulos das entidades reais (companies/people/...).
  const labels = {};
  for (const [kind, cfg] of Object.entries(KIND_TABLE)) {
    const ids = [...(needByKind[kind] || [])];
    if (!ids.length) continue;
    const rows = await safeRun(supabase.from(cfg.table).select("*").in("id", ids));
    for (const row of rows) {
      labels[k(kind, row.id)] = { id: k(kind, row.id), type: kind,
        title: row[cfg.label] || kind, subtitle: row[cfg.sub] || "", meta: nodeMeta(kind, row) };
    }
  }
  const nodes = [...visited].filter((id) => labels[id]).map((id) => labels[id]);
  const finalEdges = edges.filter((e) => labels[e.from] && labels[e.to]);
  return {
    ok: true, nodes, edges: finalEdges,
    meta: { mode: "socio", depth, root: k(startKind, startId),
      truncated: visited.size >= limit,
      relationship_types: [...new Set(finalEdges.map((e) => e.relationship))].sort() },
    fetchedAt: new Date().toISOString()
  };
}

// Panorama NACIONAL agregado: 1 super-no por agencia (com contagens) + as
// empresas que contratam com >=2 agencias (fornecedores transversais — sinal de
// concentracao). Cabe na tela sem virar "teia" de milhares de nos; clicar num
// no leva a navegacao por entidade (expand). Nao sofre o teto de 800 do
// panoramico bruto (agrega tudo server-side).
async function aggregateGraph(supabase) {
  const agencies = await safeRun(supabase.from("agencies").select("id, acronym, name").eq("sector", "regulatory"));
  const validAg = new Set(agencies.map((a) => a.id)); // so agencias reguladoras viram no

  // Contratos (paginado). NAO engolir erro: se uma pagina falha, sinalizar
  // `partial` (senao um agregado vazio por erro de rede vira "concentracao zero").
  const contracts = [];
  let partial = false;
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from("contracts")
      .select("agency_id, supplier_company_id, supplier_name").order("id", { ascending: true }).range(from, from + PAGE - 1);
    if (error) { console.error(`[graph:aggregate] contracts: ${error.message}`); partial = true; break; }
    const rows = data || [];
    contracts.push(...rows);
    if (rows.length < PAGE) break;
  }
  const contractCount = {};
  const compAgencies = new Map(); // company_id -> Set(agency_id) — SO reguladoras
  const compName = new Map();
  for (const c of contracts) {
    if (!c.agency_id || !validAg.has(c.agency_id)) continue; // ignora agencia nao-reguladora
    contractCount[c.agency_id] = (contractCount[c.agency_id] || 0) + 1;
    if (c.supplier_company_id) {
      if (!compAgencies.has(c.supplier_company_id)) compAgencies.set(c.supplier_company_id, new Set());
      compAgencies.get(c.supplier_company_id).add(c.agency_id);
      if (c.supplier_name) compName.set(c.supplier_company_id, c.supplier_name);
    }
  }

  // Dirigentes por agencia (head-count, barato).
  const mandCount = {};
  await Promise.all(agencies.map(async (a) => {
    try {
      const { count } = await supabase.from("mandates").select("id", { count: "exact", head: true }).eq("agency_id", a.id);
      mandCount[a.id] = count || 0;
    } catch { mandCount[a.id] = 0; }
  }));

  const nodes = agencies.map((a) => ({
    id: k("agency", a.id), type: "agency", title: a.acronym || a.name,
    subtitle: `${contractCount[a.id] || 0} contratos · ${mandCount[a.id] || 0} dirigentes`,
    weight: contractCount[a.id] || 0
  }));

  // Cadastro (CNPJ/situacao) dos fornecedores transversais: alimenta o cartao com
  // badge de situacao E o helper "CNPJs de teste" do front (fornecedores reais na base).
  const crossIds = [...compAgencies.keys()].filter((id) => compAgencies.get(id).size >= 2);
  const compById = new Map();
  // Chunka o .in(): crossIds pode ter centenas de fornecedores -> um unico .in()
  // estoura o tamanho da URL do PostgREST (GET id=in.(...) -> risco de 414).
  const CHUNK = 150;
  for (let i = 0; i < crossIds.length; i += CHUNK) {
    const rows = await safeRun(supabase.from("companies").select("id, cnpj, legal_name, registration_status").in("id", crossIds.slice(i, i + CHUNK)));
    for (const r of rows) compById.set(r.id, r);
  }

  const edges = [];
  const usedComp = [];
  for (const [compId, agSet] of compAgencies) {
    if (agSet.size < 2) continue; // so fornecedores transversais
    const cid = k("company", compId);
    const comp = compById.get(compId);
    usedComp.push({ id: cid, type: "company", title: comp?.legal_name || compName.get(compId) || "Empresa",
      subtitle: `${agSet.size} agências`, weight: agSet.size,
      cnpj: comp?.cnpj || null, meta: nodeMeta("company", comp || {}) });
    for (const agId of agSet) edges.push({ from: cid, to: k("agency", agId), relationship: "reported", weight: 1, meta: {} });
  }

  return {
    ok: true, nodes: [...nodes, ...usedComp], edges,
    meta: { mode: "aggregate", agencies: agencies.length, cross_agency_suppliers: usedComp.length,
      partial, relationship_types: usedComp.length ? ["reported"] : [] },
    fetchedAt: new Date().toISOString()
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=600");
  try {
    const supabase = getSupabase();
    const limit = Math.min(Number(req.query.limit) || 300, 1000);
    const nodeParam = req.query.node ? String(req.query.node) : null;
    let nKind = null, nId = null;
    if (nodeParam) [nKind, nId] = nodeParam.split(":");

    // Modo expansao societaria (BFS multi-nivel) a partir de um no.
    if ((req.query.expand === "socio") && nKind && nId) {
      const depth = Math.min(Math.max(Number(req.query.depth) || 2, 1), 5);
      return res.status(200).json(await expandSocio(supabase, nKind, nId, depth, limit));
    }

    // Modo panorama NACIONAL agregado (super-nos por agencia).
    if (req.query.mode === "aggregate") {
      return res.status(200).json(await aggregateGraph(supabase));
    }

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
          title: row[cfg.label] || kind, subtitle: row[cfg.sub] || "", meta: nodeMeta(kind, row)
        };
      }
    }

    // Filtro por agencia (sigla): mantem o subgrafo da agencia + seus vizinhos diretos.
    let agencyKey = null;
    if (req.query.agency) {
      const acronym = String(req.query.agency).toUpperCase();
      agencyKey = Object.values(labels).find((n) => n.type === "agency" && (n.subtitle || "").toUpperCase() === acronym)?.id || null;
    }
    // BFS por N hops a partir da agencia (antes so 1 hop -> nao alcancava os
    // socios do fornecedor). ?hops=2 (default) abre agencia->fornecedor->socios;
    // teto 4. Cada hop expande SO a fronteira anterior (nao inunda num passo).
    let allowed = null;
    if (agencyKey) {
      const hops = Math.min(Math.max(Number(req.query.hops) || 2, 1), 4);
      allowed = new Set([agencyKey]);
      let frontier = new Set([agencyKey]);
      for (let h = 0; h < hops && frontier.size; h++) {
        const nextF = new Set();
        for (const e of edges) {
          if (frontier.has(e.from) && !allowed.has(e.to)) { allowed.add(e.to); nextF.add(e.to); }
          if (frontier.has(e.to) && !allowed.has(e.from)) { allowed.add(e.from); nextF.add(e.from); }
        }
        frontier = nextF;
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
