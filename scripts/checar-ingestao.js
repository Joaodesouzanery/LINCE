// Alarme de ausencia de ingestao do DOU.
//
// POR QUE ISTO EXISTE: a causa raiz do furo do acervo nao foi uma fonte ruim — foi job
// falhando em SILENCIO. Medido em 31/08/2026: dos 127 dias uteis entre 13/02 e 10/08,
// 34 fecharam com ZERO atos, e os demais ficaram em 81% de completude em media, caindo
// de 90-97% (fev/mar) para ~56% (mai-ago). Ninguem percebeu por meses.
//
// A base piora sozinha. Sem alarme, qualquer conserto e temporario.
//
// A regra: dia util que fecha com zero atos de agencia dispara aviso NO MESMO DIA. Mas
// "zero atos" e ambiguo — pode ser feriado. Por isso o alarme consulta o denominador
// independente (total publicado no DOU naquele dia) antes de acusar.
//
// Uso: node scripts/checar-ingestao.js [--dias=7] [--quiet]
// Sai com codigo 1 se houver dia quebrado (para o workflow falhar de verdade).
require("dotenv").config();
const { getSupabase } = require("../lib/supabase");
const { indiceSecao } = require("../lib/dou-publico");
const { sendAlertWebhook } = require("../lib/notify");

const FUSO = "America/Sao_Paulo";
const FMT = new Intl.DateTimeFormat("en-CA", { timeZone: FUSO, year: "numeric", month: "2-digit", day: "2-digit" });
const isoBR = (d = new Date()) => FMT.format(d);
const arg = (nome, padrao) => {
  const a = process.argv.find((x) => x.startsWith(`--${nome}=`));
  return a ? a.split("=")[1] : padrao;
};

function ehDiaUtil(iso) {
  const [a, m, d] = iso.split("-").map(Number);
  const w = new Date(Date.UTC(a, m - 1, d)).getUTCDay();
  return w !== 0 && w !== 6;
}

async function main() {
  const dias = Math.max(1, Math.min(60, Number(arg("dias", 7))));
  const quiet = process.argv.includes("--quiet");
  const supabase = getSupabase();

  const hoje = isoBR();
  const janela = [];
  for (let i = 1; i <= dias; i++) {
    const iso = isoBR(new Date(Date.now() - i * 86400000));
    if (ehDiaUtil(iso)) janela.push(iso);
  }
  if (!janela.length) {
    console.log("Nenhum dia util na janela — nada a checar.");
    return;
  }

  const { data, error } = await supabase
    .from("documents")
    .select("published_at")
    .eq("source_name", "DOU")
    .in("published_at", janela);
  if (error) {
    console.error(`ERRO ao consultar o acervo: ${error.message}`);
    process.exit(1);
  }
  const porDia = {};
  for (const d of data || []) porDia[d.published_at] = (porDia[d.published_at] || 0) + 1;

  const quebrados = [];
  const semEdicao = [];
  console.log(`Checando ${janela.length} dia(s) util(eis) ate ${hoje}:\n`);

  for (const iso of janela.sort()) {
    const n = porDia[iso] || 0;
    if (n > 0) {
      if (!quiet) console.log(`  ${iso}  ${String(n).padStart(4)} atos  OK`);
      continue;
    }
    // Zero atos: consulta o denominador antes de acusar. Feriado nao e falha.
    const idx = await indiceSecao(iso, "do1");
    const publicados = idx.ok ? idx.atos.length : null;
    if (publicados === 0) {
      semEdicao.push(iso);
      if (!quiet) console.log(`  ${iso}     0 atos  sem edicao (DOU nao circulou)`);
    } else {
      quebrados.push({ iso, publicados });
      console.log(`  ${iso}     0 atos  QUEBRADO — o DOU publicou ${publicados ?? "?"} atos no DO1`);
    }
  }

  console.log(`\n=== Resumo ===`);
  console.log(`Dias uteis checados : ${janela.length}`);
  console.log(`Sem edicao          : ${semEdicao.length}`);
  console.log(`QUEBRADOS           : ${quebrados.length}`);

  if (!quebrados.length) {
    console.log(`\nIngestao em dia.`);
    return;
  }

  const alertas = quebrados.map((q) => ({
    title: `DOU sem ingestao em ${q.iso}`,
    body: `O acervo tem 0 atos nesse dia, mas o DOU publicou ${q.publicados} atos no DO1. Rode: node scripts/backfill-dou.js ${q.iso} ${q.iso} --fonte=publico`,
    severity: "high",
    alert_type: "ingestao_parada"
  }));
  const enviado = await sendAlertWebhook(alertas, { label: "LINCE · Ingestao DOU" });
  console.log(`Webhook: ${enviado.ok ? `enviado (${enviado.sent})` : (enviado.skipped || enviado.error)}`);

  // Falha de verdade: sem isto o workflow fica verde com a ingestao quebrada, que e
  // exatamente o bug que este script existe para nao repetir.
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
