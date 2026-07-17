// Coletor CONSERVADOR de deliberacoes a partir dos atos do DOU ja ingeridos.
// Sem IA (regex). Popula a tabela `deliberations` (hoje vazia) SO com atos que
// tem um numero de Deliberacao EXPLICITO ("Deliberacao nº X") — cobre menos, mas
// nao gera ruido (ao contrario de tentar inferir de "pauta"/"resolucao" soltos).
//
// Uso: node scripts/load-deliberacoes.js [--limit N] [--dry-run]
require("dotenv").config();
const { getSupabase } = require("../lib/supabase");

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }

// Alta confianca: "Deliberacao nº 123", "DELIBERAÇÃO N. 45/2026".
const DELIB_RE = /delibera[çc][ãa]o\s*n?[ºo°.]*\s*([\d][\d.\/-]{0,20})/i;
const PROC_RE = /processo\s*(?:administrativo\s*)?n?[ºo°.]*\s*([\d][\d.\/-]{5,25})/i;

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const limit = Math.max(1, Number(arg("--limit")) || 500);
  const supabase = getSupabase();

  // So atos cujo TITULO menciona deliberacao (foco alto; evita varrer tudo).
  const { data: docs, error } = await supabase.from("documents")
    .select("id, title, extracted_text, agency_id, published_at")
    .eq("source_name", "DOU").ilike("title", "%delibera%")
    .order("published_at", { ascending: false }).limit(limit);
  if (error) { console.error("Erro ao listar:", error.message); process.exit(1); }
  console.log(`Atos com "delibera" no titulo: ${docs?.length || 0}`);

  let inserted = 0, skipped = 0, noNumber = 0;
  for (const d of docs || []) {
    if (!d.agency_id) { skipped++; continue; } // agency_id e NOT NULL na tabela
    const hay = `${d.title || ""} ${d.extracted_text || ""}`;
    const dm = (d.title || "").match(DELIB_RE) || hay.match(DELIB_RE);
    if (!dm) { noNumber++; continue; } // conservador: exige numero de deliberacao
    const pm = hay.match(PROC_RE);
    // dedupe por document_id (um ato -> uma deliberacao).
    const { data: exists } = await supabase.from("deliberations").select("id").eq("document_id", d.id).maybeSingle();
    if (exists) { skipped++; continue; }
    if (dryRun) { inserted++; continue; }
    const { error: insErr } = await supabase.from("deliberations").insert({
      agency_id: d.agency_id, document_id: d.id,
      deliberation_number: dm[1].replace(/[.\-\/]+$/, ""), process_number: pm ? pm[1] : null,
      title: (d.title || "").slice(0, 300), confidence_score: 0.6,
      evidence: { source: "regex", matched: dm[0] }
    });
    if (insErr) { console.error(`  x ${d.id}: ${insErr.message}`); continue; }
    inserted++;
  }
  console.log(`\n=== load:deliberacoes ===`);
  console.log(`Inseridas: ${inserted} | sem número (puladas): ${noNumber} | já existiam/sem agência: ${skipped}${dryRun ? " (dry-run)" : ""}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
