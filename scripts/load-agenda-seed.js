// Carrega a Agenda Regulatoria curada (data/agenda-*.seed.json) em regulatory_agenda.
//
// POR QUE SEED E NAO SCRAPER: a agenda muda 1x por bienio. Um parser que roda a cada
// dois anos e mais caro de manter do que 27 linhas de JSON conferidas na fonte. E o
// dado NAO e coletavel de forma confiavel: os temas itemizados vivem num painel Power
// BI que carrega via JS, e o DOU nao publica a lista (varri 1.908 atos em 5 dias: zero).
//
// A fonte primaria do texto e o ANMlegis (texto compilado da Res. 191/2024 com as
// alteracoes da Res. 227/2025), de onde os titulos foram extraidos verbatim.
//
// PROVENIENCIA: cada tema gravado carrega, em metadata, o ato, o DOU, a URL da fonte,
// quem curou, quando, e ate quando a curadoria vale (review_due). Sem isso, em oito
// meses ninguem sabe se a agenda ainda esta vigente -- e o coracao comercial do
// produto passa a ser um arquivo que alguem digitou.
//
// Uso: node scripts/load-agenda-seed.js [--arquivo=data/agenda-anm.seed.json] [--dry-run]
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { getSupabase } = require("../lib/supabase");

const arg = (n, p) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : p;
};
const dryRun = process.argv.includes("--dry-run");

async function main() {
  const arquivo = path.resolve(arg("arquivo", "data/agenda-anm.seed.json"));
  if (!fs.existsSync(arquivo)) {
    console.error(`Arquivo nao encontrado: ${arquivo}`);
    console.error("Uso: node scripts/load-agenda-seed.js [--arquivo=...] [--dry-run]");
    process.exit(1);
  }
  const seed = JSON.parse(fs.readFileSync(arquivo, "utf8"));
  const m = seed._meta || {};
  const supabase = getSupabase();

  // Confere a aritmetica declarada ANTES de gravar: se o _meta e a lista divergem,
  // o numero que vai para a tela ja nasce errado.
  const prio = seed.temas.filter((t) => t.classe === "prioritaria").length;
  const ind = seed.temas.filter((t) => t.classe === "indicativa").length;
  if (seed.temas.length !== m.total || prio !== m.total_prioritarios || ind !== m.total_indicativos) {
    console.error(`ABORTADO: _meta declara ${m.total} (${m.total_prioritarios}+${m.total_indicativos}) mas a lista tem ${seed.temas.length} (${prio}+${ind}).`);
    process.exit(1);
  }

  const { data: ag, error: agErr } = await supabase
    .from("agencies").select("id, acronym").eq("acronym", m.agencia).maybeSingle();
  if (agErr) { console.error(`Erro ao buscar a agencia: ${agErr.message}`); process.exit(1); }
  if (!ag) { console.error(`Agencia ${m.agencia} nao cadastrada. Rode o seed de agencias.`); process.exit(1); }

  const eixos = Object.fromEntries((seed.eixos || []).map((e) => [e.numero, e]));
  const linhas = seed.temas.map((t) => {
    const e = eixos[t.eixo] || {};
    return {
      agency_id: ag.id,
      biennium: m.biennium,
      theme_title: t.titulo,
      status: t.classe === "prioritaria" ? "prioritaria" : "indicativa",
      area: e.superintendencia || null,
      source_url: m.source_url,
      metadata: {
        eixo: t.eixo,
        eixo_nome: e.nome || null,
        inciso: t.inciso || null,
        classe: t.classe,
        alteracao: t.alteracao || null,
        // Proveniencia — exigida pela skill lgpd-e-proveniencia.
        ato: m.ato_aprovador,
        ato_dou: m.ato_dou,
        alterado_por: m.alterado_por,
        versao_do_texto: m.versao_do_texto,
        source_doc: m.source_doc,
        curated_at: m.curated_at,
        curated_by: m.curated_by,
        review_due: m.review_due
      }
    };
  });

  console.log(`=== Agenda ${m.agencia} ${m.biennium} ===`);
  console.log(`Ato        : ${m.ato_aprovador} (${m.ato_dou})`);
  console.log(`Alterado   : ${m.alterado_por}`);
  console.log(`Versao     : ${m.versao_do_texto}`);
  console.log(`Curadoria  : ${m.curated_at} por ${m.curated_by} · revisar ate ${m.review_due}`);
  console.log(`Temas      : ${linhas.length} (${prio} prioritarios + ${ind} indicativos)\n`);

  if (dryRun) {
    for (const l of linhas.slice(0, 6)) console.log(`  [dry] E${l.metadata.eixo}/${l.metadata.inciso} (${l.status}) ${l.theme_title.slice(0, 74)}`);
    console.log(`  ... e mais ${Math.max(0, linhas.length - 6)}`);
    console.log("\n(dry-run: nada gravado)");
    return;
  }

  // Idempotente por (agency_id, biennium, theme_title). Sem unique index no banco, o
  // caminho seguro e apagar o bienio desta agencia e regravar: a agenda e um documento
  // fechado, nao um acumulado, entao substituir a versao inteira e o certo.
  const { error: delErr } = await supabase
    .from("regulatory_agenda").delete().eq("agency_id", ag.id).eq("biennium", m.biennium);
  if (delErr) { console.error(`Erro ao limpar o bienio: ${delErr.message}`); process.exit(1); }

  const { data: ins, error: insErr } = await supabase
    .from("regulatory_agenda").insert(linhas).select("id");
  if (insErr) { console.error(`Erro ao gravar: ${insErr.message}`); process.exit(1); }

  console.log(`Gravados: ${(ins || []).length} tema(s).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
