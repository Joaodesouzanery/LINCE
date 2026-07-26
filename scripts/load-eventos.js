// M22 (NOMOS F4) — Popula legislative_eventos + evento_pauta (agenda da Camara).
// Janela -7d a +30d: eventos recentes + proximos, com os itens de PAUTA que
// referenciam proposicao (o elo com o painel). SEM IA, fonte gratis (Dados Abertos).
//
// Re-sync da pauta por evento com UPSERT + delete-stale (preserva created_at, que e o
// cursor "entrou na pauta" do digest — delete+insert resetaria e spammaria o alerta).
//
// Uso: node scripts/load-eventos.js [--dry-run] [--dias-passado N] [--dias-futuro N]
// Roda no GitHub Actions (workflow paineis.yml), antes do digest.
require("dotenv").config();
const { getSupabase } = require("../lib/supabase");
const { fetchEventos, fetchPautaEvento } = require("../lib/legislativo");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ymd = (d) => d.toISOString().slice(0, 10);
function argNum(name, def) { const i = process.argv.indexOf(name); return i >= 0 ? Number(process.argv[i + 1]) : def; }

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const diasPassado = argNum("--dias-passado", 7), diasFuturo = argNum("--dias-futuro", 30);
  const supabase = getSupabase();

  const hoje = Date.now();
  const dataInicio = ymd(new Date(hoje - diasPassado * 864e5));
  const dataFim = ymd(new Date(hoje + diasFuturo * 864e5));
  const ev = await fetchEventos({ dataInicio, dataFim });
  if (!ev.ok && !ev.items.length) { console.error(`Camara /eventos falhou: ${ev.error || "?"}`); process.exit(1); }
  console.log(`Eventos (${dataInicio} a ${dataFim}): ${ev.items.length}${ev.error ? " (parcial: " + ev.error + ")" : ""}`);

  let eventos = 0, pautaItens = 0, comProp = 0, apiFailed = 0, dbFailed = 0;
  for (let i = 0; i < ev.items.length; i++) {
    const e = ev.items[i];
    if (!e.externalId) continue;
    const id = `camara-ev:${e.externalId}`;

    let pauta = await fetchPautaEvento(e.externalId);
    if (!pauta.ok) { await sleep(250); pauta = await fetchPautaEvento(e.externalId); }
    if (!pauta.ok) apiFailed++;

    if (dryRun) {
      console.log(`  [dry] ${String(e.dataInicio).slice(0, 10)} ${e.tipo} (${e.orgaoSigla || "?"}) -> ${pauta.ok ? pauta.items.length : "?"} item(ns) de pauta`);
      await sleep(60); continue;
    }

    const up = await supabase.from("legislative_eventos").upsert({
      id, casa: "Camara", data_inicio: e.dataInicio, data_fim: e.dataFim,
      situacao: e.situacao, tipo: e.tipo, descricao: e.descricao,
      orgao_sigla: e.orgaoSigla, orgao_nome: e.orgaoNome, local: e.local, url: e.url
    }, { onConflict: "id" });
    if (up.error) { dbFailed++; console.error(`  x evento ${id}: ${up.error.message}`); await sleep(80); continue; }
    eventos++;

    if (pauta.ok) {
      // Dedup por proposicao_id (unique = (evento_id, proposicao_id)).
      const seen = new Set(); const rows = [];
      for (const it of pauta.items) {
        if (seen.has(it.proposicaoId)) continue; seen.add(it.proposicaoId);
        rows.push({ evento_id: id, proposicao_id: it.proposicaoId, ordem: it.ordem, topico: it.topico, titulo: it.titulo, situacao_item: it.situacaoItem, regime: it.regime });
      }
      const { data: existing, error: exErr } = await supabase.from("evento_pauta").select("id, proposicao_id").eq("evento_id", id);
      if (exErr) { dbFailed++; console.error(`  x read pauta ${id}: ${exErr.message}`); await sleep(80); continue; }
      if (rows.length) {
        const upP = await supabase.from("evento_pauta").upsert(rows, { onConflict: "evento_id,proposicao_id" });
        if (upP.error) { dbFailed++; console.error(`  x upsert pauta ${id}: ${upP.error.message}`); await sleep(80); continue; }
        pautaItens += rows.length; comProp++;
      }
      const fresh = new Set(rows.map((r) => r.proposicao_id));
      const stale = (existing || []).filter((x) => !fresh.has(x.proposicao_id)).map((x) => x.id);
      if (stale.length) {
        const del = await supabase.from("evento_pauta").delete().in("id", stale);
        if (del.error) { dbFailed++; console.error(`  x del-stale pauta ${id}: ${del.error.message}`); }
      }
    }
    if (i && i % 25 === 0) console.log(`  ...${i}/${ev.items.length}`);
    await sleep(90);
  }

  console.log(`\n=== load:eventos concluido ===`);
  console.log(`Eventos: ${eventos} | com pauta+proposicao: ${comProp} | itens de pauta: ${pautaItens} | API falhou: ${apiFailed} | DB falhou: ${dbFailed}${dryRun ? " (dry-run)" : ""}`);
  // Falha TOTAL de gravacao (ex.: M22 nao aplicada / sem permissao) NAO pode ficar
  // verde no workflow: se vieram eventos mas nada foi gravado, sai com erro.
  if (!dryRun && ev.items.length && eventos === 0 && dbFailed > 0) {
    console.error("FALHA: nenhum evento gravado apesar de eventos retornados — M22 aplicada? permissao da service key?");
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
