// Logica compartilhada de pos-processamento de atos do DOU:
// cria diretores (people), mandatos (mandates) e conexoes (relationships)
// a partir dos atos de pessoal (Secao 2), combinando regex + entidades de IA.
const { extractPeopleFromAto } = require("./dou");
const { upsertPerson } = require("./people");

// Processa um ato de pessoal ja gravado em `documents`.
// doc = { id, agency_id, agency_acronym, published_at, title, text, aiEntities }
// Retorna { people, mandates, relationships } (contagens).
async function processPeopleFromDoc(supabase, doc) {
  // 1) Pessoas via regex (sempre disponivel, conf 0.6)
  const regexPeople = extractPeopleFromAto(doc.text).map((p) => ({ ...p, confidence: 0.6 }));
  // 2) Pessoas via IA (quando houver, conf 0.9) - merge por nome
  const aiPeople = (doc.aiEntities || [])
    .filter((e) => e.kind === "person" && e.name)
    .map((e) => ({ name: e.name, role: e.role || "Dirigente", action: "nomeacao", confidence: 0.9 }));

  const byName = new Map();
  for (const p of [...regexPeople, ...aiPeople]) {
    const key = p.name.toUpperCase();
    const prev = byName.get(key);
    if (!prev || p.confidence > prev.confidence) byName.set(key, p);
  }

  let people = 0, mandates = 0, rels = 0;
  const relsToInsert = [];

  for (const p of byName.values()) {
    const person = await upsertPerson(supabase, {
      full_name: p.name,
      role: p.role,
      agency_id: doc.agency_id
    });
    people++;

    // Mandato (idempotente por person+agency+ato)
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
        role: p.role,
        started_at: p.action === "nomeacao" ? doc.published_at : null,
        ended_at: p.action === "exoneracao" ? doc.published_at : null,
        appointment_act: doc.title,
        source_document_id: doc.id,
        confidence_score: p.confidence
      });
      mandates++;
    }

    // Dedup: nao recria a conexao agency->person para o mesmo ato.
    const { data: relExists } = await supabase
      .from("relationships")
      .select("id")
      .eq("from_id", doc.agency_id)
      .eq("to_id", person.id)
      .eq("source_document_id", doc.id)
      .eq("relationship", "employs")
      .maybeSingle();
    if (!relExists) {
      relsToInsert.push({
        from_kind: "agency",
        from_id: doc.agency_id,
        to_kind: "person",
        to_id: person.id,
        relationship: "employs",
        source_document_id: doc.id,
        confidence_score: p.confidence,
        metadata: { action: p.action, role: p.role }
      });
    }
  }

  if (relsToInsert.length) {
    await supabase.from("relationships").insert(relsToInsert);
    rels = relsToInsert.length;
  }

  return { people, mandates, relationships: rels };
}

module.exports = { processPeopleFromDoc };
