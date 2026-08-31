// Backfill historico do DOU: ingere todos os dias de 2026-01-02 ate ontem.
// Idempotente: dedupe por content_hash — pode rodar multiplas vezes sem duplicar.
// Uso: node scripts/backfill-dou.js [YYYY-MM-DD inicio] [YYYY-MM-DD fim] [--ia] [--fonte=publico|inlabs]
// --ia liga o resumo por IA (analyzeAto): UMA chamada Claude por ato, sequencial.
// Sem a flag o acervo entra sem resumo e scripts/backfill-ai.js preenche depois —
// que e o caminho barato para recuperar muitos dias.
// Ex:  node scripts/backfill-dou.js 2026-01-02 2026-06-12
require("dotenv").config();
const { getSupabase } = require("../lib/supabase");
const { collectDou, login, AuthError } = require("../lib/dou");
const { collectDouPublico } = require("../lib/dou-publico");
const { analyzeAto } = require("../lib/anthropic");
const { loadActiveMonitors, flushMonitorAlerts } = require("../lib/ingest");
const { persistDou } = require("../lib/dou-persist");

// Opt-in explicito: a IA multiplica o tempo do backfill por ~50.
const COM_IA = process.argv.includes("--ia");

// Fonte da coleta. A publica e a primaria (mais completa, sem credencial); ver o
// cabecalho de lib/dou-publico.js. --fonte=inlabs forca a antiga.
const FONTE = (process.argv.find((a) => a.startsWith("--fonte=")) || "--fonte=publico").split("=")[1];

// Sessao INLABS compartilhada: loga uma vez e reusa o cookie. O cookie expira
// em 30 min (Max-Age=1800), entao re-loga periodicamente. Evita o rate-limit
// do INLABS, que bloqueia o IP apos ~20 logins seguidos.
const SESSION_TTL_MS = 25 * 60 * 1000; // re-loga a cada 25 min (margem de seguranca)
let _cookie = null;
let _cookieAt = 0;
async function getCookie() {
  const now = Date.now();
  if (!_cookie || now - _cookieAt > SESSION_TTL_MS) {
    _cookie = await login();
    _cookieAt = now;
  }
  return _cookie;
}

function dateRange(from, to) {
  const dates = [];
  const cur = new Date(from + "T12:00:00Z");
  const end = new Date(to + "T12:00:00Z");
  while (cur <= end) {
    const d = cur.toISOString().slice(0, 10);
    // Pula fins de semana (DOU nao circula sabado/domingo normalmente)
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) dates.push(d);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

async function ingestDate(supabase, date, agencies, monitors) {
  let inserted = 0, skipped = 0, directors = 0, monitorHitsN = 0;
  let records;

  if (FONTE === "publico") {
    try {
      records = await collectDouPublico(date, agencies);
    } catch (e) {
      console.error(`  [${date}] ERRO coletor publico: ${e.message}`);
      return { inserted, skipped, directors, monitorHits: monitorHitsN, falhou: true };
    }
    // Dia sem edicao NAO e falha: e o resultado correto para fim de semana/feriado.
    // Confundir os dois foi o que deixou o job "verde ingerindo nada".
    if (records.semEdicao) return { inserted: 0, skipped: 0, directors: 0, monitorHits: 0, semEdicao: true };
    if (records.matcherSuspeito) {
      console.error(`  [${date}] ERRO: ${records.totalPublicados} atos publicados e NENHUM casou com agencia (matcher quebrado?)`);
      return { inserted, skipped, directors, monitorHits: monitorHitsN, falhou: true };
    }
    return persistir(supabase, date, records, monitors);
  }

  try {
    const cookie = await getCookie();
    records = await collectDou(date, agencies, { cookie });
  } catch (e) {
    // AuthError (cookie expirado/inválido) → re-loga e tenta a data 1x de novo.
    if (e instanceof AuthError) {
      _cookie = null;
      try {
        const cookie = await getCookie();
        records = await collectDou(date, agencies, { cookie });
      } catch (e2) {
        console.error(`  [${date}] ERRO após re-login: ${e2.message}`);
        return { inserted, skipped, directors, monitorHits: monitorHitsN, falhou: true };
      }
    } else {
      _cookie = null;
      console.error(`  [${date}] ERRO collectDou: ${e.message}`);
      return { inserted, skipped, directors, monitorHits: monitorHitsN, falhou: true };
    }
  }

  return persistir(supabase, date, records, monitors);
}

async function persistir(supabase, date, records, monitors) {
  let inserted = 0, skipped = 0, directors = 0, monitorHitsN = 0;
  // Persistencia em lote (lib/dou-persist.js). Antes eram ~3 round-trips por ato:
  // um SELECT de dedupe, o INSERT e um UPDATE so para themes.
  //
  // comAlertas: false — este script reingere HISTORICO. Gerar um alerta "novo" por
  // ato de pessoal de 3 meses atras afogaria os alertas do dia com fatos velhos.
  // A rota do dia (api/ingest-dou.js) mantem os alertas ligados.
  let r;
  try {
    r = await persistDou(supabase, records, {
      analisar: COM_IA ? analyzeAto : null,
      comPessoas: true,
      comAlertas: false,
      monitores: monitors || []
    });
  } catch (e) {
    if (e.code === "PARTICAO_VIOLADA") {
      console.error(`  [${date}] PULADO: ${e.message.split(".")[0]}.`);
      return { inserted: 0, skipped: 0, directors: 0, monitorHits: 0, particaoViolada: true };
    }
    console.error(`  [${date}] ERRO ao persistir: ${e.message}`);
    return { inserted: 0, skipped: 0, directors: 0, monitorHits: 0, falhou: true };
  }
  inserted = r.inserted;
  skipped = r.skipped;
  directors = r.directors;
  if (r.monitorAlerts.length) {
    await flushMonitorAlerts(supabase, r.monitorAlerts, r.monitorHits).catch(() => {});
    monitorHitsN = r.monitorAlerts.length;
  }
  return { inserted, skipped, directors, monitorHits: monitorHitsN };
}

async function main() {
  const supabase = getSupabase();
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const posicionais = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const fromDate = posicionais[0] || "2026-01-02";
  const toDate = posicionais[1] || yesterday;

  const { data: agencies } = await supabase
    .from("agencies")
    .select("id, acronym, name")
    .eq("sector", "regulatory");

  const dates = dateRange(fromDate, toDate);
  const monitors = await loadActiveMonitors(supabase); // F-INT1 (F4): monitores no backfill
  console.log(`Backfill DOU: ${dates.length} dias uteis (${fromDate} → ${toDate})`);
  console.log(`Agencias: ${(agencies || []).map((a) => a.acronym).join(", ")} | monitores ativos: ${monitors.length}\n`);

  let totalInserted = 0, totalSkipped = 0, totalDirectors = 0, totalMonitorHits = 0;
  let falhas = 0, semEdicao = 0, particao = 0;

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    process.stdout.write(`[${i + 1}/${dates.length}] ${date} ... `);
    const r = await ingestDate(supabase, date, agencies || [], monitors);
    totalInserted += r.inserted;
    totalSkipped += r.skipped;
    totalDirectors += r.directors;
    totalMonitorHits += r.monitorHits || 0;
    if (r.falhou) falhas++;
    if (r.semEdicao) semEdicao++;
    if (r.particaoViolada) particao++;
    console.log(`+${r.inserted} novos, ${r.skipped} ja existiam${r.directors ? `, ${r.directors} diretores` : ""}${r.monitorHits ? `, ${r.monitorHits} alerta(s) de monitor` : ""}`);

    // Fail-fast: se a 1ª data útil não inseriu nem achou nada, algo está errado
    // (login/download). Avisa para rodar com DOU_DEBUG=1 em vez de iterar 116 datas mudo.
    if (i === 0 && r.inserted === 0 && r.skipped === 0) {
      console.warn(`\n  ⚠ A primeira data retornou 0 atos. Possíveis causas: cookie/download.`);
      console.warn(`  Rode com diagnóstico para ver o status HTTP por seção:`);
      console.warn(`    DOU_DEBUG=1 npm run backfill:dou ${date} ${date}\n`);
    }

    // Pausa breve entre datas para nao sobrecarregar INLABS
    if (i < dates.length - 1) await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`\n=== Backfill concluido ===`);
  console.log(`Fonte          : ${FONTE}`);
  console.log(`Datas          : ${dates.length} (${semEdicao} sem edicao, ${falhas} com falha${particao ? `, ${particao} puladas por particao` : ""})`);
  console.log(`Atos inseridos : ${totalInserted}`);
  console.log(`Ja existiam    : ${totalSkipped}`);
  console.log(`Diretores      : ${totalDirectors}`);

  // Codigo de saida honesto. Antes o script capturava o erro por data, somava zero e
  // terminava com exit 0 — o workflow ficava VERDE ingerindo NADA, e foi assim que
  // meses de ingestao quebrada passaram despercebidos (o acervo caiu para ~56% de
  // cobertura no periodo recente sem nenhum alarme).
  //
  // "0 atos novos" e legitimo (fim de semana, ou tudo ja ingerido). "todas as datas
  // falharam" nao e.
  const tentadas = dates.length - semEdicao - particao;
  if (tentadas > 0 && falhas === tentadas) {
    console.error(`\nERRO: todas as ${tentadas} datas uteis falharam. Nada foi ingerido.`);
    process.exit(1);
  }
  if (falhas > 0) {
    console.warn(`\nAVISO: ${falhas} de ${tentadas} datas falharam — o intervalo esta incompleto.`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
