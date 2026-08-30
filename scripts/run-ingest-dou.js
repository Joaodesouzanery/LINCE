// Roda a ingestao do DOU localmente e persiste no Supabase.
// Uso: node scripts/run-ingest-dou.js [YYYY-MM-DD] [--sem-ia]
require("dotenv").config();
const { getSupabase } = require("../lib/supabase");
const { collectDou } = require("../lib/dou");
const { analyzeAto } = require("../lib/anthropic");
const { loadActiveMonitors, flushMonitorAlerts } = require("../lib/ingest");
const { persistDou } = require("../lib/dou-persist");

// Este e o CLI do dia (npm run ingest:dou): IA ligada por padrao, ao contrario
// da rota HTTP (60s de teto) e do backfill (que reingere muitos dias).
// --sem-ia desliga quando so interessa o acervo.

async function main() {
  // Data em America/Sao_Paulo: toISOString() e UTC e depois das 21h de Brasilia
  // pediria a edicao de amanha.
  const hojeBR = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
  const date = process.argv.slice(2).find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || hojeBR;
  const supabase = getSupabase();

  const { data: agencies } = await supabase
    .from("agencies")
    .select("id, acronym, name")
    .eq("sector", "regulatory");

  console.log(`Coletando DOU de ${date} para ${agencies?.length || 0} agencias...`);
  const records = await collectDou(date, agencies || []);
  console.log(`Atos encontrados: ${records.length}`);

  let inserted = 0, skipped = 0, directors = 0;
  const monitors = await loadActiveMonitors(supabase);
  const monitorAlerts = [];
  const monitorHits = new Map();
  if (monitors.length) console.log(`Monitores ativos: ${monitors.length}`);

  // Persistencia em lote (lib/dou-persist.js): dedupe numa consulta por bloco de
  // 50 em vez de um SELECT por ato, insert em blocos e themes no proprio payload.
  const r = await persistDou(supabase, records, {
    analisar: process.argv.includes("--sem-ia") ? null : analyzeAto,
    comPessoas: true,
    monitores: monitors
  });
  inserted = r.inserted;
  skipped = r.skipped;
  directors = r.directors;
  monitorAlerts.push(...r.monitorAlerts);
  for (const [id, n] of r.monitorHits) monitorHits.set(id, n);
  if (r.alerts) console.log(`  alertas de ato de pessoal: ${r.alerts}`);
  for (const h of r.monitorAlerts) console.log(`    monitor hit: ${h.title}`);

  await flushMonitorAlerts(supabase, monitorAlerts, monitorHits);

  console.log(`\nConcluido: ${inserted} inseridos, ${skipped} ja existiam, ${directors} diretores criados, ${monitorAlerts.length} alertas de monitor.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
