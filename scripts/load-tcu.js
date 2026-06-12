// M9 - Carrega jurisprudencia do TCU (dados abertos CSV) no Supabase.
// Baixe o CSV em https://sites.tcu.gov.br/dados-abertos/jurisprudencia/
// Uso: node scripts/load-tcu.js caminho/para/jurisprudencia-selecionada.csv
const fs = require("fs");
const { getSupabase } = require("../lib/supabase");
const { parseCsv } = require("../lib/csv");

async function main() {
  const path = process.argv[2];
  if (!path) { console.error("Informe o caminho do CSV do TCU."); process.exit(1); }
  const supabase = getSupabase();
  const text = fs.readFileSync(path, "utf8");
  const rows = parseCsv(text);
  console.log(`Linhas no CSV: ${rows.length}`);

  let inserted = 0;
  const batch = [];
  for (const r of rows) {
    // Nomes de coluna variam por dataset; ajuste conforme o arquivo.
    const external_id = r.KEY || r.NUMACORDAO || r["NUMERO ACORDAO"] || null;
    if (!external_id) continue;
    batch.push({
      court: "TCU",
      external_id: `TCU-${external_id}`,
      process_number: r.NUMACORDAO || r["NUMERO ACORDAO"] || null,
      title: (r.ENUNCIADO || r.TITULO || "Acordao TCU").slice(0, 500),
      summary: r.ENUNCIADO || r.EXCERTO || null,
      decided_at: r.DATASESSAO || r.DATA || null,
      url: r.URL || null,
      metadata: r
    });
    if (batch.length >= 500) {
      const { error } = await supabase.from("jurisprudence").upsert(batch, { onConflict: "external_id" });
      if (error) throw error;
      inserted += batch.length; batch.length = 0;
      console.log(`Inseridos: ${inserted}`);
    }
  }
  if (batch.length) {
    const { error } = await supabase.from("jurisprudence").upsert(batch, { onConflict: "external_id" });
    if (error) throw error;
    inserted += batch.length;
  }
  console.log(`OK: ${inserted} registros de jurisprudencia carregados.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
