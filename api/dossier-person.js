// M3 - Dossie de uma pessoa (diretor). Agrega mandatos, vinculos partidarios,
// votos, relacionamentos e enriquecimento do Portal da Transparencia (SIAPE).
// GET /api/dossier-person?id=<uuid>  ou  ?name=<nome>
const { getSupabase } = require("../lib/supabase");
const { findServidoresByName } = require("../lib/transparencia");
const { normalizeName } = require("../lib/text");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=900");
  try {
    const supabase = getSupabase();
    const id = req.query.id ? String(req.query.id) : null;
    const name = req.query.name ? String(req.query.name) : null;
    const q = req.query.q ? String(req.query.q).trim() : null;
    const list = req.query.list ? String(req.query.list) : null;
    const agency = req.query.agency ? String(req.query.agency).toUpperCase() : null;

    // Modo busca incremental: ?q=<termo> -> lista de pessoas que casam (ilike).
    if (q) {
      const term = `%${q.replace(/\s+/g, "%")}%`;
      const { data } = await supabase
        .from("people")
        .select("id, full_name, role, agency_id, agencies(acronym)")
        .or(`normalized_name.ilike.${`%${normalizeName(q).replace(/\s+/g, "%")}%`},full_name.ilike.${term}`)
        .limit(30);
      const people = (data || []).map((p) => ({
        id: p.id, full_name: p.full_name, role: p.role || "dirigente",
        agency: p.agencies?.acronym || null
      }));
      return res.status(200).json({ ok: true, mode: "search", people });
    }

    // Modo lista: ?list=1[&agency=ANEEL] -> diretores agrupaveis por agencia.
    if (list) {
      let query = supabase
        .from("people")
        .select("id, full_name, role, agency_id, agencies(acronym, name)")
        .order("full_name", { ascending: true })
        .limit(500);
      const { data } = await query;
      let people = (data || []).map((p) => ({
        id: p.id, full_name: p.full_name, role: p.role || "dirigente",
        agency: p.agencies?.acronym || null, agency_name: p.agencies?.name || null
      }));
      if (agency) people = people.filter((p) => p.agency === agency);
      return res.status(200).json({ ok: true, mode: "list", people });
    }

    if (!id && !name) return res.status(400).json({ ok: false, error: "Informe id, name, q ou list." });

    let person;
    if (id) {
      ({ data: person } = await supabase.from("people").select("*").eq("id", id).maybeSingle());
    } else {
      // Tenta match exato; se falhar, cai para ilike (melhor match parcial).
      ({ data: person } = await supabase
        .from("people")
        .select("*")
        .eq("normalized_name", normalizeName(name))
        .maybeSingle());
      if (!person) {
        const term = `%${normalizeName(name).replace(/\s+/g, "%")}%`;
        const { data: matches } = await supabase
          .from("people")
          .select("*")
          .ilike("normalized_name", term)
          .limit(1);
        person = (matches || [])[0] || null;
      }
    }
    if (!person) return res.status(404).json({ ok: false, error: "Pessoa nao encontrada." });

    const [mandates, parties, votes, relsFrom, relsTo, assetsRes] = await Promise.all([
      supabase.from("mandates").select("*, agencies(acronym, name)").eq("person_id", person.id),
      supabase.from("party_links").select("*").eq("person_id", person.id),
      supabase.from("votes").select("*").eq("voter_person_id", person.id),
      supabase.from("relationships").select("*").eq("from_id", person.id).eq("from_kind", "person"),
      supabase.from("relationships").select("*").eq("to_id", person.id).eq("to_kind", "person"),
      supabase.from("assets").select("*").eq("person_id", person.id).order("reference_year", { ascending: false })
    ]);

    // Patrimonio declarado (TSE): agregado por ano + ressalva de homonimo.
    const assetItems = assetsRes.data || [];
    const totalByYear = {};
    for (const a of assetItems) {
      const y = a.reference_year || 0;
      totalByYear[y] = (totalByYear[y] || 0) + (Number(a.value) || 0);
    }
    const assets = {
      items: assetItems,
      total_by_year: totalByYear,
      weak_match: assetItems.some((a) => a.match_method === "name")
    };

    // Rede societaria (M11): empresas em que a pessoa figura como socio (vinculo
    // 'socio' vindo do QSA/Receita). Resolve o nome real da empresa e sinaliza
    // empresas com situacao cadastral nao-ativa (sinal de risco / laranja).
    const socioRels = (relsFrom.data || []).filter((r) => r.relationship === "socio" && r.to_kind === "company");
    let corporate_network = { companies: [], count: 0, inactive_count: 0 };
    if (socioRels.length) {
      const companyIds = [...new Set(socioRels.map((r) => r.to_id))];
      const { data: comps } = await supabase
        .from("companies")
        .select("id, cnpj, legal_name, trade_name, registration_status, cnae")
        .in("id", companyIds);
      const byId = new Map((comps || []).map((c) => [c.id, c]));
      const companies = socioRels.map((r) => {
        const c = byId.get(r.to_id) || {};
        return {
          company_id: r.to_id, cnpj: c.cnpj || null,
          legal_name: c.legal_name || null, trade_name: c.trade_name || null,
          registration_status: c.registration_status || null, cnae: c.cnae || null,
          role: r.metadata?.role || null, data_entrada: r.metadata?.data_entrada || null
        };
      });
      const inactive_count = companies.filter(
        (c) => c.registration_status && !/ativ/i.test(c.registration_status)
      ).length;
      corporate_network = { companies, count: companies.length, inactive_count };
    }

    // Enriquecimento ao vivo (SIAPE) - opcional, depende de chave.
    const siape = await findServidoresByName(person.full_name).catch(() => ({ ok: false }));

    // Score de independencia simples: origem publica reduz risco; vinculo
    // partidario/empresarial aumenta. (0 = independente, 100 = capturado)
    const partyWeight = (parties.data || []).length * 25;
    const dissent = (votes.data || []).filter((v) => v.is_dissent).length;
    const capture_score = Math.min(100, partyWeight + (relsTo.data || []).length * 10);

    const payload = {
      ok: true,
      person,
      mandates: mandates.data || [],
      party_links: parties.data || [],
      votes: votes.data || [],
      relationships: [...(relsFrom.data || []), ...(relsTo.data || [])],
      corporate_network,
      assets,
      siape: siape.ok ? siape.items : [],
      intelligence: {
        capture_score,
        dissent_votes: dissent,
        active_mandate: (mandates.data || []).some((m) => !m.ended_at),
        corporate_ties: corporate_network.count,
        corporate_inactive: corporate_network.inactive_count
      }
    };

    // ?ai=1: resumo executivo por IA (caro de gerar -> cache mais longo; o CDN
    // separa por querystring, entao ?id=X e ?id=X&ai=1 tem caches independentes).
    if (req.query.ai) {
      const { summarizeDossier } = require("../lib/anthropic");
      res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
      payload.ai = await summarizeDossier(payload);
    }

    return res.status(200).json(payload);
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message });
  }
};
