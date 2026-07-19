// M20.2 — Votacao nominal legislativa ("como vota"): das proposicoes JA acompanhadas
// (Camara), grava legislative_votacoes + legislative_votes (voto CRU + orientacao de
// bancada p/ fidelidade). O voto e traduzido p/ o shape IRIS na LEITURA (lib/vote-data),
// nunca aqui. Match deputado -> person por external_ids.camara. SEM IA.
//
// Uso: node scripts/load-votacoes-leg.js [--dry-run]
// Roda no GitHub Actions (workflow legislativo).
require("dotenv").config();
const { getSupabase } = require("../lib/supabase");
const { fetchVotacoesDaProposicao, fetchVotosNominais, fetchOrientacoes } = require("../lib/legislativo");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGE = 1000;

async function paginate(supabase, table, select, tweak) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from(table).select(select).range(from, from + PAGE - 1);
    if (tweak) q = tweak(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const supabase = getSupabase();

  // So proposicoes da Camara (a API do Senado de votacao nominal e outra — fase 2.1).
  const props = await paginate(supabase, "proposicoes", "id", (q) => q.like("id", "camara:%").order("id"));
  console.log(`Proposicoes Camara: ${props.length}`);

  // camaraId -> person_id (parlamentares; strictExternal garante role deputado/senador).
  const parls = await paginate(supabase, "people", "id, external_ids", (q) => q.in("role", ["deputado", "senador"]));
  const camaraMap = new Map();
  for (const p of parls) { const cid = p.external_ids && p.external_ids.camara; if (cid) camaraMap.set(String(cid), p.id); }
  console.log(`Deputados indexados por id: ${camaraMap.size}`);

  let votacoes = 0, votos = 0, comVotacao = 0, apiFailed = 0, failed = 0;

  for (let i = 0; i < props.length; i++) {
    const prop = props[i];
    if (i && i % 25 === 0) console.log(`  ${i}/${props.length}... (votacoes gravadas: ${votacoes})`);
    const camId = prop.id.slice("camara:".length);

    const vlist = await fetchVotacoesDaProposicao(camId);
    if (!vlist.ok) { apiFailed++; console.error(`  ! votacoes ${prop.id}: ${vlist.error}`); await sleep(150); continue; }
    if (!vlist.items.length) { await sleep(120); continue; }
    comVotacao++;

    for (const v of vlist.items) {
      const votId = `camara-vot:${v.votacaoId}`;
      const [votosRes, orientRes] = await Promise.all([fetchVotosNominais(v.votacaoId), fetchOrientacoes(v.votacaoId)]);
      if (!votosRes.ok) { apiFailed++; console.error(`  ! votos ${votId}: ${votosRes.error}`); continue; }
      if (!votosRes.items.length) continue; // votacao simbolica (sem voto nominal)
      // Orientacao ausente NAO e silenciosa (senao a fidelidade fica errada sem aviso).
      if (!orientRes.ok) { apiFailed++; console.error(`  ! orientacoes ${votId}: ${orientRes.error}`); }
      const orient = orientRes.ok ? orientRes.map : {};

      const voteRows = votosRes.items.map((vt) => ({
        votacao_id: votId,
        person_id: vt.camaraId ? (camaraMap.get(String(vt.camaraId)) || null) : null,
        parlamentar_nome: vt.nome,
        external_person_id: vt.camaraId,
        voto: vt.voto,
        orientacao: vt.partido ? (orient[String(vt.partido).toUpperCase()] || null) : null,
        partido: vt.partido,
        uf: vt.uf
      }));

      if (dryRun) { console.log(`  [dry] ${votId} ${voteRows.length} votos — ${(v.descricao || "").slice(0, 50)}`); votacoes++; votos += voteRows.length; continue; }

      const { error: ve } = await supabase.from("legislative_votacoes").upsert({
        id: votId, proposicao_id: prop.id, casa: "Camara",
        descricao: v.descricao, data_votacao: v.data, resultado: v.resultado, sigla_orgao: v.siglaOrgao
      }, { onConflict: "id" });
      if (ve) { failed++; console.error(`  x votacao ${votId}: ${ve.message}`); continue; }
      // Idempotente e ATOMICO: upsert por (votacao_id, external_person_id) — sem a
      // janela de perda do delete-then-insert. O placar e imutavel, entao o upsert
      // apenas confirma/atualiza cada linha.
      const { error: vle } = await supabase.from("legislative_votes")
        .upsert(voteRows, { onConflict: "votacao_id,external_person_id" });
      if (vle) { failed++; console.error(`  x votos ${votId}: ${vle.message}`); continue; }
      votacoes++; votos += voteRows.length;
      await sleep(80); // rate limit tb DENTRO da proposicao (2 calls por votacao)
    }
    await sleep(120); // rate limit entre proposicoes
  }

  console.log(`\n=== Votacoes legislativas concluido ===`);
  console.log(`Proposicoes com votacao: ${comVotacao} | votacoes: ${votacoes} | votos: ${votos} | falhas API: ${apiFailed} | falhas DB: ${failed}`);
  if (dryRun) console.log("(dry-run: nada gravado)");
}

main().catch((e) => { console.error(e); process.exit(1); });
