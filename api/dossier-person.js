// M3 - Dossie de uma pessoa (diretor). Agrega mandatos, vinculos partidarios,
// votos, relacionamentos e enriquecimento do Portal da Transparencia (SIAPE).
// GET /api/dossier-person?id=<uuid>  ou  ?name=<nome>
const { getSupabase } = require("../lib/supabase");
const { findServidoresByName, screeningByName, screeningByCnpj } = require("../lib/transparencia");
const { normalizeName, onlyDigits } = require("../lib/text");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=900");
  try {
    const supabase = getSupabase();
    const id = req.query.id ? String(req.query.id) : null;
    const name = req.query.name ? String(req.query.name) : null;
    const q = req.query.q ? String(req.query.q).trim() : null;
    const list = req.query.list ? String(req.query.list) : null;
    const agency = req.query.agency ? String(req.query.agency).toUpperCase() : null;
    const companyId = req.query.company ? String(req.query.company) : null;
    const cnpj = req.query.cnpj ? onlyDigits(req.query.cnpj) : null;

    // Modo EMPRESA: ?company=<id> ou ?cnpj=<x> -> dossie da empresa (contratos
    // ingeridos + QSA/socios + deliberacoes que a afetam + sancoes).
    if (companyId || cnpj) {
      let company;
      if (companyId) ({ data: company } = await supabase.from("companies").select("*").eq("id", companyId).maybeSingle());
      else ({ data: company } = await supabase.from("companies").select("*").eq("cnpj", cnpj).maybeSingle());
      if (!company) return res.status(404).json({ ok: false, error: "Empresa nao encontrada." });

      const [contractsRes, socioRes, delibsAfeta] = await Promise.all([
        supabase.from("contracts").select("*, agencies(acronym, name)").eq("supplier_company_id", company.id).order("signed_at", { ascending: false }),
        supabase.from("relationships").select("*").eq("to_id", company.id).eq("to_kind", "company").eq("relationship", "socio"),
        supabase.from("deliberations").select("id, deliberation_number, title, theme, result, agency_id, data_reuniao, rapporteur_person_id").eq("affected_company_id", company.id).order("data_reuniao", { ascending: false })
      ]);
      const contracts = contractsRes.data || [];
      const totalValue = contracts.reduce((s, c) => s + (Number(c.value) || 0), 0);
      const agencies = [...new Set(contracts.map((c) => c.agencies?.acronym).filter(Boolean))];

      // Resolve o nome/tipo dos socios (person ou company do outro lado da aresta).
      const rels = socioRes.data || [];
      const pIds = rels.filter((r) => r.from_kind === "person").map((r) => r.from_id);
      const cIds = rels.filter((r) => r.from_kind === "company").map((r) => r.from_id);
      const [pp, cc] = await Promise.all([
        pIds.length ? supabase.from("people").select("id, full_name").in("id", pIds) : Promise.resolve({ data: [] }),
        cIds.length ? supabase.from("companies").select("id, cnpj, legal_name").in("id", cIds) : Promise.resolve({ data: [] })
      ]);
      const pById = new Map((pp.data || []).map((x) => [x.id, x.full_name]));
      const cById = new Map((cc.data || []).map((x) => [x.id, x]));
      const socios = rels.map((r) => ({
        kind: r.from_kind, id: r.from_id,
        nome: r.from_kind === "person" ? (pById.get(r.from_id) || r.from_id) : (cById.get(r.from_id)?.legal_name || r.from_id),
        cnpj: r.from_kind === "company" ? (cById.get(r.from_id)?.cnpj || null) : null,
        role: r.metadata?.role || null
      }));

      const screening = company.cnpj ? await screeningByCnpj(company.cnpj).catch(() => ({ ok: false })) : { ok: false, status: "sem_cnpj" };
      return res.status(200).json({
        ok: true, mode: "company", company,
        contracts, contracts_summary: { count: contracts.length, total_value: totalValue, agencies },
        socios, deliberations_afeta: delibsAfeta.data || [],
        screening: screening.ok ? { flags: screening.flags, sources: screening.sources } : { available: false, reason: screening.status || "indisponivel" },
        intelligence: {
          contracts_count: contracts.length, contracts_total: totalValue, agencies_served: agencies.length,
          socios_count: socios.length, deliberations_afeta: (delibsAfeta.data || []).length,
          is_inactive: !!(company.registration_status && !/ativ/i.test(company.registration_status)),
          has_sanctions: screening.ok ? !!screening.flags.has_sanctions : false
        }
      });
    }

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

    const [mandates, parties, votes, relsFrom, relsTo, assetsRes, delibsRel] = await Promise.all([
      supabase.from("mandates").select("*, agencies(acronym, name)").eq("person_id", person.id),
      supabase.from("party_links").select("*").eq("person_id", person.id),
      supabase.from("votes").select("*, deliberations(deliberation_number, title, theme, result, agency_id, data_reuniao)").eq("voter_person_id", person.id),
      supabase.from("relationships").select("*").eq("from_id", person.id).eq("from_kind", "person"),
      supabase.from("relationships").select("*").eq("to_id", person.id).eq("to_kind", "person"),
      supabase.from("assets").select("*").eq("person_id", person.id).order("reference_year", { ascending: false }),
      // Deliberacoes RELATADAS por esta pessoa (rapporteur) — vinculo forte com o mérito.
      supabase.from("deliberations").select("id, deliberation_number, title, theme, result, agency_id, data_reuniao").eq("rapporteur_person_id", person.id)
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

    // Enriquecimento ao vivo (Portal da Transparencia) - opcional, depende de chave.
    // SIAPE (servidor) + screening PEP/sancoes (CEIS/CNEP/CEPIM/CEAF) pelo nome.
    const [siape, screening] = await Promise.all([
      findServidoresByName(person.full_name).catch(() => ({ ok: false })),
      screeningByName(person.full_name).catch(() => ({ ok: false }))
    ]);
    const flags = screening.ok ? screening.flags : null;

    // Score de independencia simples: origem publica reduz risco; vinculo
    // partidario/empresarial aumenta. (0 = independente, 100 = capturado)
    const partyWeight = (parties.data || []).length * 25;
    const dissent = (votes.data || []).filter((v) => v.is_dissent).length;
    const capture_score = Math.min(100, partyWeight + (relsTo.data || []).length * 10 + (flags?.has_sanctions ? 20 : 0));

    const payload = {
      ok: true,
      person,
      mandates: mandates.data || [],
      party_links: parties.data || [],
      votes: votes.data || [],
      deliberations_relatadas: delibsRel.data || [],
      relationships: [...(relsFrom.data || []), ...(relsTo.data || [])],
      corporate_network,
      assets,
      siape: siape.ok ? siape.items : [],
      screening: screening.ok
        ? { flags, sources: screening.sources }
        : { available: false, reason: screening.status || "indisponivel" },
      intelligence: {
        capture_score,
        dissent_votes: dissent,
        votes_total: (votes.data || []).length,
        deliberations_relatadas: (delibsRel.data || []).length,
        active_mandate: (mandates.data || []).some((m) => !m.ended_at),
        corporate_ties: corporate_network.count,
        corporate_inactive: corporate_network.inactive_count,
        is_pep: !!flags?.is_pep,
        has_sanctions: !!flags?.has_sanctions
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
