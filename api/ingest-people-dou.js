// M3 - Extrai pessoas (diretores nomeados/exonerados) a partir dos atos de
// pessoal do DOU ja ingeridos (Secao 2), usando as entidades extraidas pela IA.
// Cria/atualiza people, mandates e relationships (agency employs person).
// GET /api/ingest-people-dou?date=YYYY-MM-DD  (default: todos sem processar)
const { getSupabase } = require("../lib/supabase");
const { upsertPerson } = require("../lib/people");

module.exports = async function handler(req, res) {
  try {
    const supabase = getSupabase();

    let query = supabase
      .from("documents")
      .select("id, title, agency_id, published_at, metadata")
      .eq("source_name", "DOU")
      .eq("document_type", "ato_pessoal")
      .order("published_at", { ascending: false })
      .limit(200);
    if (req.query.date) query = query.eq("published_at", String(req.query.date));

    const { data: docs, error } = await query;
    if (error) throw error;

    let people = 0;
    let mandates = 0;
    const rels = [];

    for (const doc of docs || []) {
      const entities = doc.metadata?.ai_entities || [];
      const persons = entities.filter((e) => e.kind === "person" && e.name);
      for (const p of persons) {
        const person = await upsertPerson(supabase, {
          full_name: p.name,
          role: p.role || "Dirigente",
          agency_id: doc.agency_id
        });
        people++;

        // Registra mandato (idempotente por person+agency+ato).
        const { data: existing } = await supabase
          .from("mandates")
          .select("id")
          .eq("person_id", person.id)
          .eq("agency_id", doc.agency_id)
          .eq("appointment_act", doc.title)
          .maybeSingle();
        if (!existing) {
          await supabase.from("mandates").insert({
            person_id: person.id,
            agency_id: doc.agency_id,
            role: p.role || "Dirigente",
            started_at: doc.published_at,
            appointment_act: doc.title,
            source_document_id: doc.id,
            confidence_score: doc.metadata?.ai_confidence || 0
          });
          mandates++;
        }

        rels.push({
          from_kind: "agency",
          from_id: doc.agency_id,
          to_kind: "person",
          to_id: person.id,
          relationship: "employs",
          source_document_id: doc.id,
          confidence_score: doc.metadata?.ai_confidence || 0
        });
      }
    }

    if (rels.length) await supabase.from("relationships").insert(rels);

    return res.status(200).json({ ok: true, docs: docs?.length || 0, people, mandates, relationships: rels.length });
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message });
  }
};
