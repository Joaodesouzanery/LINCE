// M27 (Eventos F-EVT4) — passo de LOTE do "Score de Patrocinador". Duas funcoes:
//
//   --screen <run_id>    Reverifica o SHORTLIST de um run no Portal da Transparencia
//                        (CEIS/CNEP) e marca `bloqueado` quem tem sancao ativa. O
//                        screening externo e gated (PORTAL_TRANSPARENCIA_API_KEY) e
//                        lento/rate-limited -> nao roda no request; roda aqui.
//
//   --rescore <run_id>   Cria um RUN NOVO (rescore_of=<run_id>) e re-pontua sobre a
//                        EVIDENCIA-SNAPSHOT gravada, com a rubrica ATIVA — isolando o
//                        efeito da rubrica do crescimento de contracts/donations.
//
// A pontuacao normal e inline no endpoint evt_sponsor_run (self-service). Este script
// e o complemento gated/reprodutivel. Uso:
//   node scripts/score-sponsors.js --screen <run_id> [--dry-run]
//   node scripts/score-sponsors.js --rescore <run_id> [--dry-run]
// Roda do ambiente com rede (Vercel Hobby ja no limite de crons/funcoes).
require("dotenv").config();
const { getSupabase } = require("../lib/supabase");
const { screeningByCnpj } = require("../lib/transparencia");
const { scoreFromSnapshot } = require("../lib/sponsor-score");
const { onlyDigits } = require("../lib/text");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function argVal(flag) { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : null; }

async function screenRun(supabase, runId, dryRun) {
  if (process.env.PORTAL_TRANSPARENCIA_API_KEY == null) {
    console.error("Sem PORTAL_TRANSPARENCIA_API_KEY — screening externo indisponivel.");
    process.exit(1);
  }
  const { data: scores, error } = await supabase.from("evt_sponsor_scores")
    .select("id, nome, cnpj").eq("run_id", runId).eq("bloqueado", false);
  if (error) { console.error(error.message); process.exit(1); }
  const alvos = (scores || []).filter((s) => onlyDigits(s.cnpj).length === 14);
  console.log(`Run ${runId}: ${alvos.length} empresas com CNPJ p/ screening.`);
  let bloqueados = 0, verificados = 0, falhas = 0;
  const nowIso = new Date().toISOString();
  for (const s of alvos) {
    const sc = await screeningByCnpj(onlyDigits(s.cnpj)).catch((e) => ({ ok: false, error: e.message }));
    // ok e sempre true; so confia se ALGUMA fonte respondeu (senao rate-limit/erro silencioso).
    const anyOk = !!(sc && sc.sources && Object.values(sc.sources).some((x) => x && x.ok));
    if (!anyOk) { falhas++; console.warn(`  ? ${s.nome}: screening sem resposta de fonte (rate-limit?)`); await sleep(800); continue; }
    verificados++;
    const has = !!(sc.flags && sc.flags.has_sanctions);
    const screening = { verified: true, has_sanctions: has, checked_at: nowIso };
    if (has) {
      bloqueados++;
      console.log(`  BLOQUEIO ${s.nome} — sancao ativa (CEIS/CNEP).`);
      if (!dryRun) await supabase.from("evt_sponsor_scores").update({ bloqueado: true, screening }).eq("id", s.id);
    } else if (!dryRun) {
      await supabase.from("evt_sponsor_scores").update({ screening }).eq("id", s.id);
    }
    await sleep(400); // respeita rate-limit do Portal
  }
  console.log(`Screening: ${verificados} verificados, ${bloqueados} bloqueados, ${falhas} falhas.${dryRun ? " (dry-run)" : ""}`);
}

async function rescoreRun(supabase, runId, dryRun) {
  const { data: oldRun, error: rErr } = await supabase.from("evt_sponsor_runs").select("*").eq("id", runId).maybeSingle();
  if (rErr || !oldRun) { console.error(`Run ${runId} nao encontrado.`); process.exit(1); }
  const { data: rub } = await supabase.from("evt_sponsor_rubrics").select("*").eq("active", true).maybeSingle();
  const { data: ev } = await supabase.from("evt_eventos").select("data_evento, metadata").eq("id", oldRun.evento_id).maybeSingle();
  const cotas = (ev && ev.metadata && ev.metadata.cotas) || [];
  const { data: oldScores, error: sErr } = await supabase.from("evt_sponsor_scores").select("*").eq("run_id", runId);
  if (sErr) { console.error(sErr.message); process.exit(1); }
  console.log(`Re-score de ${oldScores.length} empresas com a rubrica v${rub && rub.version} (sobre snapshot).`);

  const ctx = {
    weights: rub && rub.weights, tiers: rub && rub.tiers, cotaBands: rub && rub.cota_bands,
    sectorCnae: (rub && rub.sector_cnae && oldRun.setor && rub.sector_cnae[oldRun.setor]) || [],
    cotas, dataEvento: ev && ev.data_evento
  };
  const rescored = oldScores.map((row) => ({ row, s: scoreFromSnapshot(row, ctx) })).filter((x) => x.s.tier != null);

  if (dryRun) {
    for (const { row, s } of rescored.slice(0, 20)) console.log(`  ${s.nome}: ${row.total} (t${row.tier}) -> ${s.total} (t${s.tier})`);
    console.log(`Re-score (dry-run): ${rescored.length} empresas ficariam no shortlist.`);
    return;
  }
  const { data: newRun, error: nErr } = await supabase.from("evt_sponsor_runs").insert({
    evento_id: oldRun.evento_id, status: "running", orgaos: oldRun.orgaos, setor: oldRun.setor,
    rubric_version: (rub && rub.version) || null, rescore_of: runId
  }).select().maybeSingle();
  if (nErr) { console.error(nErr.message); process.exit(1); }
  const rows = rescored.map(({ row, s }) => ({
    evento_id: oldRun.evento_id, run_id: newRun.id, company_id: s.company_id, cnpj: s.cnpj, empresa_key: s.empresa_key, nome: s.nome,
    total: s.total, tier: s.tier, subscores: s.subscores, evidence: s.evidence, as_of: row.as_of, capped: s.capped,
    cota_sugerida: s.cota_sugerida, timing: s.timing, rubric_version: (rub && rub.version) || null,
    bloqueado: row.bloqueado, screening: row.screening
  }));
  if (rows.length) { const { error } = await supabase.from("evt_sponsor_scores").insert(rows); if (error) { console.error(error.message); process.exit(1); } }
  const { error: dErr } = await supabase.from("evt_sponsor_runs").update({ status: "done", n_candidates: oldRun.n_candidates, n_scored: rows.length, finished_at: new Date().toISOString() }).eq("id", newRun.id);
  if (dErr) { console.error(`Falha ao concluir run ${newRun.id} (fica preso em 'running', shortlist invisivel na UI): ${dErr.message}`); process.exit(1); }
  console.log(`Re-score OK: run novo ${newRun.id} com ${rows.length} empresas.`);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const supabase = getSupabase();
  const screenId = argVal("--screen");
  const rescoreId = argVal("--rescore");
  if (screenId) return screenRun(supabase, screenId, dryRun);
  if (rescoreId) return rescoreRun(supabase, rescoreId, dryRun);
  console.error("Uso: node scripts/score-sponsors.js --screen <run_id> | --rescore <run_id> [--dry-run]");
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
