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

    const [mandates, parties, votes, relsFrom, relsTo] = await Promise.all([
      supabase.from("mandates").select("*, agencies(acronym, name)").eq("person_id", person.id),
      supabase.from("party_links").select("*").eq("person_id", person.id),
      supabase.from("votes").select("*").eq("voter_person_id", person.id),
      supabase.from("relationships").select("*").eq("from_id", person.id).eq("from_kind", "person"),
      supabase.from("relationships").select("*").eq("to_id", person.id).eq("to_kind", "person")
    ]);

    // Enriquecimento ao vivo (SIAPE) - opcional, depende de chave.
    const siape = await findServidoresByName(person.full_name).catch(() => ({ ok: false }));

    // Score de independencia simples: origem publica reduz risco; vinculo
    // partidario/empresarial aumenta. (0 = independente, 100 = capturado)
    const partyWeight = (parties.data || []).length * 25;
    const dissent = (votes.data || []).filter((v) => v.is_dissent).length;
    const capture_score = Math.min(100, partyWeight + (relsTo.data || []).length * 10);

    return res.status(200).json({
      ok: true,
      person,
      mandates: mandates.data || [],
      party_links: parties.data || [],
      votes: votes.data || [],
      relationships: [...(relsFrom.data || []), ...(relsTo.data || [])],
      siape: siape.ok ? siape.items : [],
      intelligence: {
        capture_score,
        dissent_votes: dissent,
        active_mandate: (mandates.data || []).some((m) => !m.ended_at)
      }
    });
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message });
  }
};
