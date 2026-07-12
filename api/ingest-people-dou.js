// M3 - Backfill de diretores a partir dos atos de pessoal do DOU JA ingeridos.
// Usa regex (lib/dou) + entidades de IA (se houver) para criar people, mandates
// e relationships. Util para processar os atos antigos sem reingerir o DOU.
// GET /api/ingest-people-dou?date=YYYY-MM-DD  (default: todos os atos de pessoal)
const { getSupabase } = require("../lib/supabase");
const { processPeopleFromDoc } = require("../lib/ingest");
const { timingSafeEqualStr } = require("../lib/timing");

// Mesmo gate do ingest-dou: exige Bearer CRON_SECRET quando configurado.
// A Vercel injeta esse header automaticamente nos crons quando CRON_SECRET
// existe. Sem secret setado -> libera (uso single-user), o middleware Basic
// Auth cobre o resto do deploy.
function authorized(req) {
  const secret = process.env.CRON_SECRET;
  // Fail-closed em PRODUCAO: sem CRON_SECRET, nega. Preview/dev libera.
  if (!secret) return process.env.VERCEL_ENV !== "production";
  return timingSafeEqualStr(req.headers.authorization, `Bearer ${secret}`);
}

module.exports = async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: "Nao autorizado." });
  try {
    const supabase = getSupabase();

    let query = supabase
      .from("documents")
      .select("id, title, agency_id, published_at, extracted_text, metadata")
      .eq("source_name", "DOU")
      .eq("document_type", "ato_pessoal")
      .order("published_at", { ascending: false })
      .limit(500);
    if (req.query.date) query = query.eq("published_at", String(req.query.date));

    const { data: docs, error } = await query;
    if (error) throw error;

    let people = 0, mandates = 0, rels = 0;
    for (const doc of docs || []) {
      const r = await processPeopleFromDoc(supabase, {
        id: doc.id,
        agency_id: doc.agency_id,
        agency_acronym: doc.metadata?.agency_acronym,
        published_at: doc.published_at,
        title: doc.title,
        text: doc.extracted_text,
        aiEntities: doc.metadata?.ai_entities
      });
      people += r.people; mandates += r.mandates; rels += r.relationships;
    }

    return res.status(200).json({ ok: true, docs: docs?.length || 0, people, mandates, relationships: rels });
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message });
  }
};
