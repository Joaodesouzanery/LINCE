// M20 — Popula `people` com deputados federais e senadores EM EXERCICIO.
// Parlamentar = people + role('deputado'|'senador') + external_ids (SEM agency_id;
// sector='regulatory' protege as queries regulatorias). Assim o parlamentar herda
// patrimonio TSE / filiacao (match por nome) e vira autor CLICAVEL de proposicao.
// SEM IA. Fontes: Dados Abertos da Camara e do Senado (gratis, sem chave).
//
// Uso: node scripts/load-parlamentares.js [--dry-run] [--only camara|senado]
//
// Roda no GitHub Actions (o Vercel Hobby ja esta no limite de crons/funcoes).
require("dotenv").config();
const { getSupabase } = require("../lib/supabase");
const { upsertPerson } = require("../lib/people");
const { fetchDeputados, fetchDeputadoDetalhe, fetchSenadores } = require("../lib/legislativo");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Filiacao partidaria (dedupe por person_id + party + link_type='filiacao').
async function ensureFiliacao(supabase, personId, party, casa) {
  if (!party) return;
  const { data: exists } = await supabase.from("party_links").select("id")
    .eq("person_id", personId).eq("party", party).eq("link_type", "filiacao").limit(1);
  if (exists && exists.length) return;
  await supabase.from("party_links").insert({
    person_id: personId, party, link_type: "filiacao",
    source_name: casa, source: "legislativo_api", confidence_score: 1
  });
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const onlyIdx = process.argv.indexOf("--only");
  const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;
  const supabase = getSupabase();

  let deputados = 0, senadores = 0, failed = 0, detailSkipped = 0;
  let rosterTruncated = false; // paginacao/lista incompleta -> roster parcial (grave)

  if (only !== "senado") {
    const dep = await fetchDeputados();
    if (!dep.ok) { rosterTruncated = true; console.error(`Camara /deputados INCOMPLETO (paginacao falhou): ${dep.error || "?"} — roster parcial de ${dep.items.length}.`); }
    if (!dep.items.length) console.error("Camara /deputados sem itens:", dep.error || "");
    console.log(`Camara: ${dep.items.length} deputados`);
    for (let i = 0; i < dep.items.length; i++) {
      const d = dep.items[i];
      // Detalhe traz o nome CIVIL (melhor p/ casar patrimonio TSE). Retry 1x; se ainda
      // falhar, PULA (nao grava nome parlamentar errado de forma permanente — o match
      // por external_id retornaria a linha p/ sempre) — o proximo run retenta.
      let det = await fetchDeputadoDetalhe(d.camaraId);
      if (!det.ok) { await sleep(300); det = await fetchDeputadoDetalhe(d.camaraId); }
      if (!det.ok || !det.nomeCivil) {
        detailSkipped++;
        console.error(`  ! dep ${d.camaraId} sem detalhe (${det.error || "sem nomeCivil"}) — pulado, retenta no proximo run.`);
        await sleep(120); continue;
      }
      const fullName = det.nomeCivil, partido = det.partido || d.partido, uf = det.uf || d.uf;
      if (dryRun) { console.log(`  [dry] dep ${d.camaraId} ${fullName} (${partido || "?"}/${uf || "?"})`); await sleep(60); continue; }
      try {
        const p = await upsertPerson(supabase, { full_name: fullName, role: "deputado", external_ids: { camara: d.camaraId }, uf, strictExternal: true });
        await ensureFiliacao(supabase, p.id, partido, "Camara");
        deputados++;
      } catch (e) { failed++; console.error(`  x dep ${d.camaraId}: ${e.message}`); }
      if (i && i % 50 === 0) console.log(`  ...${i}/${dep.items.length}`);
      await sleep(120); // gentileza com a API
    }
  }

  if (only !== "camara") {
    const sen = await fetchSenadores();
    if (!sen.ok) { rosterTruncated = true; console.error(`Senado /senador/lista/atual FALHOU: ${sen.error || "?"}.`); }
    if (!sen.items.length) console.error("Senado /senador/lista/atual sem itens:", sen.error || "");
    console.log(`Senado: ${sen.items.length} senadores`);
    for (const s of sen.items) {
      if (dryRun) { console.log(`  [dry] sen ${s.senadoId} ${s.nome} (${s.partido || "?"}/${s.uf || "?"})`); continue; }
      try {
        const p = await upsertPerson(supabase, { full_name: s.nome, role: "senador", external_ids: { senado: s.senadoId }, uf: s.uf, strictExternal: true });
        await ensureFiliacao(supabase, p.id, s.partido, "Senado");
        senadores++;
      } catch (e) { failed++; console.error(`  x sen ${s.senadoId}: ${e.message}`); }
    }
  }

  console.log(`\n=== Parlamentares concluido ===`);
  console.log(`Deputados: ${deputados} | Senadores: ${senadores} | detalhes pulados: ${detailSkipped} | falhas: ${failed}`);
  if (dryRun) console.log("(dry-run: nada gravado)");
  // Roster TRUNCADO (paginacao/lista incompleta) ou vazio -> exit 1: o camaraMap do
  // backfill ficaria parcial e autores sumiriam SILENCIOSAMENTE. Detalhes pulados
  // (retentados) NAO derrubam o job. O proximo run agendado completa.
  if (!dryRun && (deputados + senadores === 0 || rosterTruncated)) {
    console.error("FALHA: roster truncado ou vazio — nao confiar no resultado; rode de novo.");
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
