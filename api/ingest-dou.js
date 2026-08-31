// Endpoint de ingestao do DOU (chamado pelo Vercel Cron 1x/dia ou manualmente).
// GET /api/ingest-dou?date=YYYY-MM-DD&fonte=auto|publico|inlabs   (default: hoje, auto)
// Protegido por CRON_SECRET: header "authorization: Bearer <CRON_SECRET>".
//
// A fonte PUBLICA (in.gov.br) e primaria; o INLABS e secundario. Medido no mesmo dia
// com o mesmo matchAgency: publica 225 atos contra 114 do INLABS (+97%), 0 agencias
// zeradas contra 4, sem credencial, e com source_url que abre (o do INLABS da 404).
// Ver o cabecalho de lib/dou-publico.js para a comparacao completa.
const { getSupabase } = require("../lib/supabase");
const { collectDou } = require("../lib/dou");
const { collectDouPublico } = require("../lib/dou-publico");
const { analyzeAto } = require("../lib/anthropic");
const { persistDou } = require("../lib/dou-persist");
const { loadActiveMonitors, flushMonitorAlerts } = require("../lib/ingest");
const { timingSafeEqualStr } = require("../lib/timing");
const { sendAlertWebhook, sendMonitorEmails } = require("../lib/notify");

function authorized(req) {
  const secret = process.env.CRON_SECRET;
  // Fail-closed em PRODUCAO: sem CRON_SECRET, nega (evita ingestao/custo anonimo).
  // Em preview/dev, libera (conveniencia). A Vercel injeta o secret nos crons.
  if (!secret) return process.env.VERCEL_ENV !== "production";
  return timingSafeEqualStr(req.headers.authorization, `Bearer ${secret}`);
}

// Cascata de fontes. `auto` tenta a publica e so cai para o INLABS se ela falhar —
// nunca o contrario, porque a publica e mais completa e nao depende de credencial.
async function coletar(date, agencies, fonte) {
  const tentativas = fonte === "auto" ? ["publico", "inlabs"] : [fonte];
  const erros = [];
  for (const alvo of tentativas) {
    try {
      const records = alvo === "publico"
        ? await collectDouPublico(date, agencies)
        : await collectDou(date, agencies);
      // Sem edicao e um resultado VALIDO: nao justifica cair para a outra fonte
      // (o INLABS tambem nao teria nada) e nao e erro.
      if (records.semEdicao) return { ok: true, fonte: alvo, records };
      if (records.length > 0 || alvo === tentativas[tentativas.length - 1]) {
        return { ok: true, fonte: alvo, records };
      }
      erros.push(`${alvo}: 0 atos de agencia (publicados: ${records.totalPublicados ?? "?"})`);
    } catch (e) {
      erros.push(`${alvo}: ${e.message}`);
    }
  }
  return {
    ok: false,
    detalhe: { error: erros.join(" | "), tentativas: erros }
  };
}

module.exports = async function handler(req, res) {
  if (!authorized(req)) {
    return res.status(401).json({ ok: false, error: "Nao autorizado." });
  }

  const date = String(req.query.date || new Date().toISOString().slice(0, 10));

  try {
    const supabase = getSupabase();

    const { data: agencies, error: agErr } = await supabase
      .from("agencies")
      .select("id, acronym, name")
      .eq("sector", "regulatory");
    if (agErr) throw agErr;
    if (!agencies?.length) {
      return res.status(412).json({ ok: false, error: "Nenhuma agencia cadastrada. Rode o seed." });
    }

    const fonte = ["auto", "publico", "inlabs"].includes(req.query.fonte) ? req.query.fonte : "auto";
    const coleta = await coletar(date, agencies, fonte);
    if (!coleta.ok) {
      // Erro das DUAS tentativas, nunca de uma so: sem isso o operador conserta a
      // fonte errada.
      return res.status(502).json({ ok: false, date, fonte_tentada: fonte, ...coleta.detalhe });
    }
    const records = coleta.records;

    // Dia sem edicao (domingo, feriado, data futura) NAO e falha. Distinguir isso de
    // "ingestao quebrada" exige um denominador independente — o total publicado no dia,
    // antes de qualquer filtro. Confundir os dois foi o que deixou a ingestao parada
    // por 20 dias sem ninguem perceber.
    if (records.semEdicao) {
      return res.status(200).json({
        ok: true, date, sem_edicao: true, fonte_usada: coleta.fonte,
        found: 0, inserted: 0, skipped: 0,
        aviso: "Nenhum ato publicado nesta data (fim de semana, feriado ou data futura)."
      });
    }
    // Publicou e nada casou: o matcher quebrou. Falha RUIDOSA, nao "0 atos".
    if (records.matcherSuspeito) {
      return res.status(502).json({
        ok: false, date, fonte_usada: coleta.fonte,
        error: `Fonte publicou ${records.totalPublicados} atos e NENHUM casou com agencia — matcher quebrado ou lista de agencias vazia.`,
        total_publicados: records.totalPublicados
      });
    }
    if (records.discarded) console.log(`[ingest-dou ${date}] ${records.discarded}/${records.totalXml} atos sem match de agencia (descartados)`);

    // A rota HTTP tem 60s (vercel.json). Duas coisas nao cabem nela e por isso
    // ficam DESLIGADAS por padrao aqui:
    //   - IA: analyzeAto e uma chamada Claude por ato, sequencial. ~220 atos/dia
    //     dao ~7 min. scripts/backfill-ai.js preenche os resumos depois.
    //   - Pessoas: processPeopleFromDoc leva 25-30s sozinho e e trabalho duplicado
    //     do cron ingest-people-dou das 12:30.
    // ?ia=1 e ?pessoas=1 religam, para quando a chamada vem do CLI/Actions.
    const comIA = req.query.ia === "1";
    const comPessoas = req.query.pessoas === "1";

    const monitors = await loadActiveMonitors(supabase);
    const r = await persistDou(supabase, records, {
      analisar: comIA ? analyzeAto : null,
      comPessoas,
      monitores: monitors
    });
    const { inserted, skipped, directors, monitorAlerts, monitorHits } = r;

    // Se TUDO que era novo falhou ao gravar, isso e 502 — nao 200 com inserted:0.
    // "nao consegui gravar" e "nao havia o que gravar" precisam ser distinguiveis.
    if (r.falhas > 0 && inserted === 0) {
      return res.status(502).json({
        ok: false, date, fonte_usada: coleta.fonte, found: records.length,
        error: `Nenhum ato gravado: ${r.falhas} falha(s) de escrita.`, erros: r.erros
      });
    }

    await flushMonitorAlerts(supabase, monitorAlerts, monitorHits);

    // F2 — notificação externa (best-effort, gated por ALERT_WEBHOOK_URL): empurra
    // os HITS DE MONITOR (watchlist do usuário = alto sinal) para o webhook. Não
    // notifica os atos de pessoal genéricos (evita spam). Nunca lança.
    const notified = await sendAlertWebhook(monitorAlerts, { label: "LINCE · Monitor DOU" });
    // Fase 1 (1C): e-mail por monitor (monitors.owner_email). Best-effort — nunca lança.
    const emailed = await sendMonitorEmails(supabase, monitorAlerts, { label: "LINCE · Monitor DOU" })
      .catch((e) => ({ ok: false, error: e.message }));

    return res.status(200).json({
      ok: true,
      date,
      found: records.length,
      inserted,
      skipped,
      directors,
      alerts: r.alerts,
      monitor_alerts: monitorAlerts.length,
      fonte_usada: coleta.fonte,
      total_publicados: records.totalPublicados ?? null,
      so_preview: records.parcial ?? 0,
      falhas_escrita: r.falhas || 0,
      ...(r.falhas ? { erros: r.erros } : {}),
      // Declara o que NAO foi feito nesta rota, em vez de deixar o numero de
      // resumos vazios aparecer semanas depois como "a IA nao funciona".
      ia: comIA ? "aplicada" : `pulada (${r.pendentesDeIA} ato(s) sem resumo — use backfill:ai)`,
      pessoas: comPessoas ? "extraidas" : "puladas (cron ingest-people-dou)",
      notified: notified.ok ? notified.sent : (notified.skipped || notified.error || false),
      emailed: emailed.ok ? emailed.sent : (emailed.skipped || emailed.error || false),
      // falhas parciais de envio nao podem sumir so porque UM destinatario deu certo
      email_falhas: (emailed.falhas && emailed.falhas.length) ? emailed.falhas : undefined
    });
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message, source: "DOU/INLABS" });
  }
};
