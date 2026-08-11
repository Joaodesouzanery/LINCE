// Motor de Inteligencia Nacional: score de risco por setor/agencia,
// radar de normas dos proximos 30/60/90 dias, resumo executivo diario,
// monitores de vigilancia (CRUD), Gerador de Dossie Comercial (landscape por
// tema, dossie de deal e narrativa IA) e resumo executivo de dossie por IA.
// GET /api/intelligence?type=radar|score|daily|landscape|deal_dossier|monitors|monitor_alerts|holdings
// POST /api/intelligence?type=monitor_save|monitor_toggle|monitor_delete|deal_narrative|exec_summary
const { getSupabase } = require("../lib/supabase");
const { normalizeName, onlyDigits, isSituacaoAtiva } = require("../lib/text");
const { runScore, CONTRACT_SCAN_CAP } = require("../lib/sponsor-score"); // M27 — Score de Patrocinador (F-EVT4)
const { sponsorAngle } = require("../lib/anthropic");         // M27 — angulo (gated)
const { screeningByCnpj } = require("../lib/transparencia");  // M27 — screening (bloqueio duro na aprovacao)

// Mutacoes e listas de monitor aceitam POST (body JSON) ou GET (querystring).
function params(req) {
  return req.method === "POST" && req.body && typeof req.body === "object" ? req.body : req.query;
}

// ── Analise semanal compartilhada (trends_anomalies + correlations) ─────────
// Agrega os atos do DOU das ultimas N semanas por agencia x semana x tipo e
// detecta anomalias: PICO (semana atual >= 2x o baseline) e SILENCIO (agencia
// ativa que zerou). Baseline = media das semanas anteriores a atual.
async function weeklyAgencyAnalysis(supabase, weeks = 8) {
  const since = new Date(Date.now() - weeks * 7 * 86400000).toISOString().slice(0, 10);
  const { data: agencies } = await supabase.from("agencies").select("id, acronym, name").eq("sector", "regulatory");
  const agById = Object.fromEntries((agencies || []).map((a) => [a.id, a]));

  // Pagina para nao estourar o teto de linhas do PostgREST (ha dezenas de
  // milhares de atos; 8 semanas ainda pode passar de 1000 linhas).
  // ORDEM DESCENDENTE (mais recente primeiro): se a janela passar do teto, os atos
  // DESCARTADOS sao os mais ANTIGOS — a SEMANA ATUAL sempre entra. Isso garante que
  // `archiveStale` (baseado em currentWeek) seja confiavel; com ordem ascendente,
  // >20k atos derrubavam a semana atual e archiveStale ficava sempre true,
  // suprimindo SILENCIOSAMENTE todos os alertas de silencio.
  const rows = [];
  const PAGE = 1000;
  const CAP = 40000;
  for (let from = 0; from < CAP; from += PAGE) {
    const { data } = await supabase
      .from("documents")
      .select("agency_id, published_at, document_type")
      .eq("source_name", "DOU")
      .gte("published_at", since)
      .order("published_at", { ascending: false })
      .range(from, from + PAGE - 1);
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  const truncated = rows.length >= CAP;

  // Chave de semana = domingo (mesmo criterio do agency_stats).
  const weekKey = (dateStr) => {
    const dt = new Date(dateStr + "T12:00:00Z");
    dt.setUTCDate(dt.getUTCDate() - dt.getUTCDay());
    return dt.toISOString().slice(0, 10);
  };
  const buckets = {}; // agencyId -> weekKey -> { total, norma, ato_pessoal, contrato }
  for (const d of rows) {
    if (!d.agency_id || !agById[d.agency_id]) continue;
    const wk = weekKey(d.published_at);
    const b = ((buckets[d.agency_id] = buckets[d.agency_id] || {})[wk] =
      buckets[d.agency_id][wk] || { total: 0, norma: 0, ato_pessoal: 0, contrato: 0 });
    b.total++;
    if (b[d.document_type] !== undefined) b[d.document_type]++;
  }

  const currentWeek = weekKey(new Date().toISOString().slice(0, 10));
  const midweek = new Date().getUTCDay() >= 3; // silencio so vale de quarta em diante
  // Se a semana atual esta vazia para TODAS as agencias, e FALHA DE INGESTAO (cron
  // parado), nao "silencio" regulatorio real -> nao pintar tudo de vermelho.

  // Todas as semanas da janela (mesmo as sem atividade): semanas zeradas
  // ENTRAM na baseline — senao a media fica inflada e o pico nunca dispara.
  const allWeeks = [];
  for (let i = weeks - 1; i >= 0; i--) {
    allWeeks.push(weekKey(new Date(Date.now() - i * 7 * 86400000).toISOString().slice(0, 10)));
  }

  const archiveStale = !Object.values(buckets).some((byWeek) => (byWeek[currentWeek]?.total || 0) > 0);
  const series = [];
  const anomalies = [];
  for (const [agencyId, byWeek] of Object.entries(buckets)) {
    const ag = agById[agencyId];
    const weekRows = allWeeks.map((wk) => ({ week: wk, total: 0, norma: 0, ato_pessoal: 0, contrato: 0, ...(byWeek[wk] || {}) }));
    series.push({ agency: ag.acronym, name: ag.name, weeks: weekRows });

    for (const metric of ["total", "norma", "ato_pessoal", "contrato"]) {
      const past = weekRows.filter((w) => w.week !== currentWeek).map((w) => w[metric] || 0);
      if (!past.length) continue;
      const baseline = past.reduce((a, b) => a + b, 0) / past.length;
      const current = byWeek[currentWeek]?.[metric] || 0;
      if (baseline >= 2 && current >= 5 && current >= baseline * 2) {
        anomalies.push({ agency: ag.acronym, metric, kind: "pico", current, baseline: Math.round(baseline * 10) / 10, ratio: Math.round((current / baseline) * 10) / 10 });
      } else if (metric === "total" && baseline >= 5 && current === 0 && midweek && !archiveStale) {
        anomalies.push({ agency: ag.acronym, metric, kind: "silencio", current: 0, baseline: Math.round(baseline * 10) / 10, ratio: 0 });
      }
    }
  }
  anomalies.sort((a, b) => (b.ratio || 0) - (a.ratio || 0));
  return { series, anomalies, truncated };
}

// ── Mapa de Landscape (M14) ─────────────────────────────────────────────────
// Compoe a distribuicao de atos do DOU por TEMA (habilitado pela coluna
// documents.themes) e, quando um tema e escolhido, o recorte por agencia com os
// atos mais recentes. Base do Gerador de Dossie. Retorna ready:false (sem
// lancar) quando a coluna 'themes' ainda nao existe (migracao Fase M14 pendente)
// -> o caller degrada com uma mensagem de "rode a migracao + backfill".
async function computeLandscape(supabase, { theme, days, agencies }) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const { THEME_LABELS } = require("../lib/themes");

  // Sonda barata: a coluna 'themes' existe? (head+count com filtro @>). Erro de
  // COLUNA AUSENTE (codigo 42703/PGRST204 ou mensagem citando 'themes') =>
  // migracao Fase M14 pendente -> degrada sem lancar. Qualquer outro erro e um
  // erro real de banco e NAO deve ser mascarado como "sem tema".
  const probe = await supabase.from("documents")
    .select("id", { count: "exact", head: true })
    .eq("source_name", "DOU").contains("themes", [THEME_LABELS[0]]);
  if (probe.error) {
    const msg = probe.error.message || "";
    if (probe.error.code === "42703" || probe.error.code === "PGRST204" || /themes/i.test(msg)) {
      return { ready: false, themes_available: THEME_LABELS, distribution: [], by_agency: [], total: 0, theme: theme || null };
    }
    throw new Error(msg);
  }

  // Distribuicao: 1 contagem head por tema, em paralelo (GIN cobre o @>).
  // Propaga erro real de query (nao coalesce silenciosamente para 0).
  const counts = await Promise.all(THEME_LABELS.map((t) =>
    supabase.from("documents")
      .select("id", { count: "exact", head: true })
      .eq("source_name", "DOU").gte("published_at", since).contains("themes", [t])
      .then((r) => ({ theme: t, count: r.count || 0, error: r.error?.message || null }))
  ));
  const countErr = counts.find((c) => c.error);
  if (countErr) throw new Error(countErr.error);
  const distribution = counts.filter((c) => c.count > 0).sort((a, b) => b.count - a.count);

  // Recorte por agencia + atos recentes: so quando ha tema selecionado.
  let by_agency = [], total = 0;
  if (theme) {
    // Reusa a lista de agencias se o caller ja a carregou (evita round-trip).
    let agList = agencies;
    if (!agList) {
      const agRes = await supabase.from("agencies").select("id, acronym, name").eq("sector", "regulatory");
      if (agRes.error) throw new Error(agRes.error.message);
      agList = agRes.data || [];
    }
    const agById = Object.fromEntries(agList.map((a) => [a.id, a]));
    // Total consistente com a distribuicao (head count do tema), sem teto de 6000.
    total = distribution.find((d) => d.theme === theme)?.count || 0;
    // Pagina para agregar por agencia + 5 atos recentes. Ordem com DESEMPATE
    // estavel (published_at e DATE -> muitos empates; id desempata) para nao
    // pular/duplicar registros na fronteira das paginas. Projeta so o necessario
    // (sem metadata jsonb, que e pesado e nao e usado no recorte).
    const byAg = {};
    const PAGE = 1000;
    for (let from = 0; from < 8000; from += PAGE) {
      const { data, error } = await supabase.from("documents")
        .select("id, title, published_at, document_type, source_url, agency_id")
        .eq("source_name", "DOU").gte("published_at", since).contains("themes", [theme])
        .order("published_at", { ascending: false }).order("id", { ascending: false })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      for (const d of data || []) {
        const ag = agById[d.agency_id];
        if (!ag) continue;
        const b = (byAg[ag.acronym] = byAg[ag.acronym] || { agency: ag.acronym, name: ag.name, count: 0, recent: [] });
        b.count++;
        if (b.recent.length < 5) {
          b.recent.push({ title: d.title, date: d.published_at, type: d.document_type, link: d.source_url });
        }
      }
      if (!data || data.length < PAGE) break;
    }
    by_agency = Object.values(byAg).sort((a, b) => b.count - a.count);
    // Piso: se o head count nao cobriu (tema fora da distribuicao), usa a soma agregada.
    const agg = by_agency.reduce((s, a) => s + a.count, 0);
    if (!total || agg > total) total = agg;
  }
  return { ready: true, themes_available: THEME_LABELS, distribution, by_agency, total, theme: theme || null };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=3600");
  const type = String(req.query.type || "radar");

  // Diagnostico: env vars (sem expor valores) + sondas de schema no banco.
  // As sondas confirmam que a migracao "Fase 5" foi aplicada em producao.
  if (type === "health") {
    res.setHeader("Cache-Control", "no-store");
    const payload = {
      ok: true,
      supabase_url: !!process.env.SUPABASE_URL,
      service_key: !!process.env.SUPABASE_SERVICE_KEY,
      inlabs_email: !!process.env.INLABS_EMAIL,
      inlabs_senha: !!process.env.INLABS_SENHA,
      anthropic_key: !!process.env.ANTHROPIC_API_KEY,
      alert_webhook: !!process.env.ALERT_WEBHOOK_URL,
      node_version: process.version,
      env: process.env.NODE_ENV || "production"
    };
    try {
      const supabase = getSupabase();
      // Cada sonda seleciona a coluna-alvo com head (barato); erro => objeto ausente.
      const probe = async (table, column) => {
        const { error } = await supabase.from(table).select(column, { count: "exact", head: true }).limit(1);
        return !error;
      };
      const [monitors, alertType, assets, partyJoined] = await Promise.all([
        probe("monitors", "id"),
        probe("alerts", "alert_type"),
        probe("assets", "id"),
        probe("party_links", "joined_at")
      ]);
      payload.db = {
        monitors_table: monitors,
        alerts_alert_type: alertType,
        assets_table: assets,
        party_links_joined_at: partyJoined,
        migration_fase5: monitors && alertType && assets && partyJoined
      };
    } catch (e) {
      payload.db = { error: e.message };
    }
    return res.status(200).json(payload);
  }

  // Config PUBLICA para a tela de login (URL + chave anon — ambas publicas).
  // Liberada pelo middleware antes do login. NUNCA expoe a service key.
  if (type === "auth_config") {
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      url: process.env.SUPABASE_URL || null,
      anonKey: process.env.SUPABASE_ANON_KEY || null,
      authEnabled: !!(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY)
    });
  }

  // Dispara a ingestao do DOU sob demanda (botao "Atualizar agora"). Gated por
  // JWT no middleware; repassa o CRON_SECRET server-side ao /api/ingest-dou
  // (que fica fora do gate JWT). POST.
  if (type === "refresh") {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST." });
    // Host CANONICO da propria deploy (VERCEL_URL) — NAO usar req.headers.host,
    // que e controlavel e vazaria o CRON_SECRET para um host arbitrario (SSRF).
    const base = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "";
    if (!base) return res.status(200).json({ ok: false, error: "Atualizacao indisponivel (sem VERCEL_URL). Rode a ingestao pelo cron/CLI." });
    const secret = process.env.CRON_SECRET;
    // Backfilla um RANGE curto (nao so hoje): cobre buracos de fim de semana/feriado
    // sem depender do CLI. `date` explicito = 1 dia; `days=N` = ultimos N dias (cap 5).
    // Ordem do MAIS NOVO -> mais antigo: HOJE sempre entra primeiro, entao mesmo que
    // um dia anterior estoure o tempo (cada ingest-dou e ele mesmo ate 60s), o dado de
    // hoje ja foi persistido. So a falha de HOJE (1o dia) e fatal -> sinaliza INLABS
    // caido na hora; dias anteriores que falhem viram aviso nao-fatal.
    // CAVEAT (Bloco H): quando a ANTHROPIC_API_KEY entrar, cada ingest fica lento
    // (analyzeAto) e um range >2 pode estourar 60s -> revisar days aqui.
    const dates = [];
    if (req.query.date) {
      dates.push(String(req.query.date));
    } else {
      const n = Math.min(5, Math.max(1, parseInt(req.query.days, 10) || 1));
      const base0 = new Date();
      for (let i = 0; i < n; i++) {
        const d = new Date(base0); d.setDate(d.getDate() - i);
        dates.push(d.toISOString().slice(0, 10));
      }
    }
    const results = [];
    const warnings = [];
    // Orcamento de tempo de parede: a funcao tem maxDuration 60s; paramos de INICIAR
    // novos dias em ~50s p/ retornar JSON limpo em vez de ser morto (504 sem corpo).
    // Cada ingest-dou (INLABS login + 3 zips + parse + inserts) pode levar dezenas de
    // segundos; sem esta trava um range de 3+ dias estouraria o limite.
    const startedAt = Date.now();
    const BUDGET_MS = 50000;
    try {
      for (let i = 0; i < dates.length; i++) {
        const d = dates[i];
        const remaining = BUDGET_MS - (Date.now() - startedAt);
        if (i > 0 && remaining < 8000) { // sem tempo seguro p/ mais um dia -> para limpo
          warnings.push(`Tempo esgotado antes de ${d}: rode o CLI backfill:dou para dias mais antigos.`);
          break;
        }
        let r, data;
        try {
          r = await fetch(`${base}/api/ingest-dou?date=${encodeURIComponent(d)}`, {
            headers: secret ? { authorization: `Bearer ${secret}` } : {},
            signal: AbortSignal.timeout(Math.max(8000, remaining))
          });
          data = await r.json().catch(() => ({}));
        } catch (fe) {
          // Timeout/abort do fetch deste dia. Fatal so se for o 1o (hoje).
          if (i === 0) return res.status(502).json({ ok: false, triggered: "ingest-dou", results, error: `Falha ao ingerir ${d}: ${fe.message}` });
          warnings.push(`Falha ao ingerir ${d}: ${fe.message}`);
          break;
        }
        results.push({ date: d, ok: r.ok, ...data });
        if (!r.ok) {
          // Falha do 1o dia (hoje) = fatal (INLABS/DB fora). Dias anteriores = aviso.
          if (i === 0) {
            return res.status(502).json({ ok: false, triggered: "ingest-dou", results, error: data.error || `Falha ao ingerir ${d}.` });
          }
          warnings.push(`Falha ao ingerir ${d}: ${data.error || "erro"}`);
          break; // nao insiste em dias ainda mais antigos apos uma falha
        }
      }
      const inserted = results.reduce((s, x) => s + (x.inserted || 0), 0);
      const doneDates = results.filter((x) => x.ok).map((x) => x.date);
      return res.status(200).json({ ok: true, triggered: "ingest-dou", dates: doneDates, inserted, results, warnings });
    } catch (e) {
      const okAny = results.some((x) => x.ok);
      return res.status(okAny ? 200 : 502).json({ ok: okAny, triggered: "ingest-dou", results, warnings, error: e.message });
    }
  }

  try {
    const supabase = getSupabase();

    // M20.2 — votacao LEGISLATIVA nominal ("como vota"). ANTES de "votos_" porque
    // "votos_leg_*" tambem casa aquele prefixo; reusa as MESMAS funcoes de vote-metrics.
    if (type.startsWith("votos_leg_")) {
      res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=600");
      const { serveLegVoteMetric } = require("../lib/vote-data");
      const out = await serveLegVoteMetric(supabase, type, req.query);
      return res.status(out.ok ? 200 : 400).json(out);
    }

    // Modulo "Voto dos Diretores" (M19): metricas de votacao/colegiado. Uma unica
    // branch delega para lib/vote-data (busca+mapeia) + lib/vote-metrics (funcoes
    // puras portadas do IRIS) — nao incha o hub nem cria novo arquivo em api/.
    if (type.startsWith("votos_")) {
      res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=600");
      const { serveVoteMetric } = require("../lib/vote-data");
      const out = await serveVoteMetric(supabase, type, req.query);
      return res.status(out.ok ? 200 : 400).json(out);
    }

    // Esteira de upload (writer de votos): recebe um PDF (base64) ou texto + a
    // sigla da agencia -> extrai -> grava deliberacao + votos (lib/vote-pipeline).
    if (type === "upload_deliberacao") {
      const p = req.body && typeof req.body === "object" ? req.body : {};
      if (!p.pdf_base64 && !p.text) return res.status(400).json({ ok: false, error: "envie pdf_base64 (ou text) e agency" });
      const { processPdfToVotos } = require("../lib/vote-pipeline");
      const buffer = p.pdf_base64 ? Buffer.from(p.pdf_base64, "base64") : null;
      const out = await processPdfToVotos(supabase, { buffer, text: p.text, agencyAcronym: p.agency, filename: p.filename, source: "upload" });
      return res.status(out.ok ? 200 : 400).json(out);
    }

    // Saude dos dados (M-ops): contagens por tabela/fonte + ultima ingestao +
    // lacunas acionaveis + flags de env. Degrada (null) para tabela ausente.
    if (type === "data_health") {
      res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=900");
      const count = async (t, f) => {
        let q = supabase.from(t).select("id", { count: "exact", head: true });
        if (f) q = f(q);
        const { count: c, error } = await q;
        return error ? null : c;
      };
      const [documents, raw, people, companies, contracts, mandates, relationships, party_links, assets, monitors, open_alerts, proposicoes, deliberations, regulatory_agenda] = await Promise.all([
        count("documents"), count("documents", (q) => q.eq("extraction_status", "raw")),
        count("people"), count("companies"), count("contracts"), count("mandates"), count("relationships"),
        count("party_links"), count("assets"), count("monitors"),
        count("alerts", (q) => q.is("acknowledged_at", null)),
        count("proposicoes"), count("deliberations"), count("regulatory_agenda")
      ]);
      const { data: last } = await supabase.from("documents").select("published_at")
        .eq("source_name", "DOU").order("published_at", { ascending: false }).limit(1);
      const lastIngest = last?.[0]?.published_at || null;
      const daysStale = lastIngest ? Math.floor((Date.now() - new Date(lastIngest + "T12:00:00Z")) / 86400000) : null;

      // F-INT1 (F4): FRESCOR POR FONTE — antes so o DOU tinha indicador; PNCP parado ha
      // meses era indistinguivel de PNCP de ontem. max(created_at) por tabela.
      // Erro de leitura != tabela vazia: 'erro' e um estado proprio (nao vira "nunca").
      const lastOf = async (table, col) => {
        try {
          const { data, error } = await supabase.from(table).select(col).order(col, { ascending: false, nullsFirst: false }).limit(1);
          if (error) return { last: null, error: error.message };
          return { last: data?.[0]?.[col] || null, error: null };
        } catch (e) { return { last: null, error: e.message }; }
      };
      const staleDays = (ts) => ts ? Math.floor((Date.now() - new Date(ts)) / 86400000) : null;
      const [fContratos, fProposicoes, fEventosLeg, fDoacoes, fBens, fAgenda] = await Promise.all([
        lastOf("contracts", "created_at"), lastOf("proposicoes", "last_seen"), lastOf("legislative_eventos", "created_at"),
        lastOf("campaign_donations", "created_at"), lastOf("assets", "created_at"), lastOf("regulatory_agenda", "created_at")
      ]);
      // expected_days: null = fonte MANUAL (TSE — dumps locais, sem cron): nunca fica "stale",
      // so "nunca rodou". As demais tem cron e atrasam de verdade.
      const freshness = [
        { source: "DOU", last: lastIngest, days_stale: daysStale, expected_days: 1, error: null },
        { source: "Contratos PNCP", ...fContratos, days_stale: staleDays(fContratos.last), expected_days: 2 },
        { source: "Proposições", ...fProposicoes, days_stale: staleDays(fProposicoes.last), expected_days: 8 },
        { source: "Eventos/pauta Câmara", ...fEventosLeg, days_stale: staleDays(fEventosLeg.last), expected_days: 2 },
        { source: "Doações TSE (manual)", ...fDoacoes, days_stale: staleDays(fDoacoes.last), expected_days: null },
        { source: "Bens TSE (manual)", ...fBens, days_stale: staleDays(fBens.last), expected_days: null },
        { source: "Agenda regulatória", ...fAgenda, days_stale: staleDays(fAgenda.last), expected_days: 8 }
      ].map((f) => ({ ...f, stale: !!f.error || (f.expected_days == null ? f.last == null : (f.days_stale == null || f.days_stale > f.expected_days)) }));

      const gaps = [];
      if (!process.env.ANTHROPIC_API_KEY) gaps.push(`IA desligada: ${raw ?? "?"} atos sem resumo (adicione ANTHROPIC_API_KEY).`);
      if (party_links === 0) gaps.push("0 vinculos partidarios — rode load:tse-filiacao.");
      if (assets === 0) gaps.push("0 patrimonio (TSE) — rode load:tse-bens.");
      if (contracts !== null && contracts < 300) gaps.push("Poucos contratos PNCP — rode ingest:pncp.");
      if (proposicoes === null) gaps.push("Proposicoes nao persistidas — aplique a migracao M18 + load:proposicoes.");
      if (daysStale !== null && daysStale > 3) gaps.push(`Ultima ingestao ha ${daysStale} dias — verifique o cron do DOU.`);

      return res.status(200).json({
        ok: true, type: "data_health",
        counts: { documents, raw, people, companies, contracts, mandates, relationships, party_links, assets, monitors, open_alerts, proposicoes, deliberations, regulatory_agenda },
        last_ingest: lastIngest, days_stale: daysStale, freshness,
        env: {
          anthropic: !!process.env.ANTHROPIC_API_KEY, inlabs: !!process.env.INLABS_EMAIL,
          portal_transparencia: !!process.env.PORTAL_TRANSPARENCIA_API_KEY, cron_secret: !!process.env.CRON_SECRET,
          allowed_emails: !!process.env.ALLOWED_EMAILS, supabase_anon: !!process.env.SUPABASE_ANON_KEY
        },
        gaps, fetchedAt: new Date().toISOString()
      });
    }

    if (type === "trend") {
      // Serie temporal de atos para o grafico de tendencia (ultimos N dias).
      // F-INT1: ordem DESC + paginacao — se truncar, quem cai fora sao os dias mais
      // ANTIGOS (antes a ordem asc cortava os dias RECENTES e a curva "caia" no fim).
      const days = Math.min(Number(req.query.days) || 30, 90);
      const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      const docs = [];
      const TREND_CAP = 20000;
      for (let from = 0; from < TREND_CAP; from += 1000) {
        const { data, error } = await supabase
          .from("documents")
          .select("published_at, document_type")
          .eq("source_name", "DOU")
          .gte("published_at", since)
          .order("published_at", { ascending: false })
          .order("id", { ascending: false })
          .range(from, from + 999);
        if (error) return res.status(500).json({ ok: false, error: error.message });
        docs.push(...(data || []));
        if (!data || data.length < 1000) break;
      }
      const truncated = docs.length >= TREND_CAP;
      const buckets = {};
      for (const d of docs) {
        const k = d.published_at;
        if (!buckets[k]) buckets[k] = { date: k, norma: 0, ato_pessoal: 0, contrato: 0, total: 0 };
        const t = d.document_type === "norma" || d.document_type === "ato_pessoal" || d.document_type === "contrato" ? d.document_type : "norma";
        buckets[k][t]++; buckets[k].total++;
      }
      const series = Object.values(buckets).sort((a, b) => a.date.localeCompare(b.date));
      // Se truncou, o dia mais antigo da janela esta INCOMPLETO — descarta p/ nao exibir contagem parcial.
      if (truncated && series.length > 1) series.shift();
      const total = series.reduce((s, b) => s + b.total, 0); // coerente com o grafico (pos-shift)
      return res.status(200).json({ ok: true, type: "trend", days, total, truncated, series });
    }

    if (type === "recent") {
      // Atos mais recentes para a tabela do dashboard.
      const limit = Math.min(Number(req.query.limit) || 20, 100);
      const { data: docs } = await supabase
        .from("documents")
        .select("id, title, document_type, published_at, source_url, metadata, agencies(acronym)")
        .eq("source_name", "DOU")
        // Desempate intradia por collected_at (published_at e DATE, sem hora).
        .order("published_at", { ascending: false })
        .order("collected_at", { ascending: false })
        .limit(limit);
      const items = (docs || []).map((d) => ({
        id: d.id,
        title: d.title,
        type: d.document_type,
        date: d.published_at,
        agency: d.agencies?.acronym || d.metadata?.agency_acronym || "?",
        summary: d.metadata?.ai_summary || null,
        confidence: d.metadata?.ai_confidence ?? null,
        origin: d.metadata?.ai_summary ? "ia" : "regex",
        link: d.source_url
      }));
      return res.status(200).json({ ok: true, type: "recent", truncated: (docs || []).length >= limit, items });
    }

    if (type === "daily") {
      // Resumo executivo: atos desde ontem por agencia.
      // F-INT1: pagina ate 3000 (antes limit 50 e as contagens por agencia eram uma
      // AMOSTRA exibida como total do dia). truncated agora e honesto e o front exibe.
      const since = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const docs = [];
      const DAILY_CAP = 3000;
      for (let from = 0; from < DAILY_CAP; from += 1000) {
        const { data, error } = await supabase
          .from("documents")
          .select("title, document_type, published_at, metadata, agencies(acronym)")
          .eq("source_name", "DOU")
          .gte("published_at", since)
          .order("published_at", { ascending: false })
          .order("id", { ascending: false })
          .range(from, from + 999);
        if (error) return res.status(500).json({ ok: false, error: error.message });
        docs.push(...(data || []));
        if (!data || data.length < 1000) break;
      }
      const byAgency = {};
      for (const d of docs) {
        const ac = d.agencies?.acronym || d.metadata?.agency_acronym || "?";
        if (!byAgency[ac]) byAgency[ac] = { normas: 0, pessoal: 0, contratos: 0, destaques: [] };
        if (d.document_type === "norma") byAgency[ac].normas++;
        else if (d.document_type === "ato_pessoal") byAgency[ac].pessoal++;
        else if (d.document_type === "contrato") byAgency[ac].contratos++;
        if (d.metadata?.ai_summary && byAgency[ac].destaques.length < 5) byAgency[ac].destaques.push(d.metadata.ai_summary);
      }
      return res.status(200).json({ ok: true, type: "daily", date: since, total: docs.length, truncated: docs.length >= DAILY_CAP, by_agency: byAgency });
    }

    if (type === "score") {
      // Score de risco por agencia. A versao antiga somava VOLUME cru sem janela
      // nem normalizacao -> todas saturavam em 100 (inutil). Agora: atividade
      // recente (90d) + alertas ponderados por severidade, NORMALIZADO entre as
      // agencias (min-max) para diferenciar de fato. docs = total (so display).
      const { data: agencies } = await supabase.from("agencies").select("id, acronym, name").eq("sector", "regulatory");
      const since90 = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
      const SEV_WEIGHT = { high: 3, medium: 2, info: 1, low: 1 };
      const agIds = (agencies || []).map((a) => a.id);

      // Em LOTE (era N+1: 4 queries x 11 agencias sequenciais). Agora: contagens
      // head por agencia em paralelo + 3 queries agregaveis em memoria.
      if (!agIds.length) return res.status(200).json({ ok: true, type: "score", window_days: 90, scores: [] });
      const [docTotals, doc90s, alertsRes, mandatesRes] = await Promise.all([
        Promise.all(agIds.map((id) => supabase.from("documents")
          .select("id", { count: "exact", head: true }).eq("agency_id", id).eq("source_name", "DOU"))),
        Promise.all(agIds.map((id) => supabase.from("documents")
          .select("id", { count: "exact", head: true }).eq("agency_id", id).eq("source_name", "DOU").gte("published_at", since90))),
        supabase.from("alerts").select("target_id, severity").is("acknowledged_at", null).in("target_id", agIds).limit(5000),
        supabase.from("mandates").select("agency_id").is("ended_at", null).in("agency_id", agIds).limit(5000)
      ]);
      const alertsByAgency = {}, directorsByAgency = {};
      for (const a of alertsRes.data || []) (alertsByAgency[a.target_id] = alertsByAgency[a.target_id] || []).push(a);
      for (const m of mandatesRes.data || []) directorsByAgency[m.agency_id] = (directorsByAgency[m.agency_id] || 0) + 1;

      const rows = (agencies || []).map((ag, i) => {
        const openAlerts = alertsByAgency[ag.id] || [];
        const weightedAlerts = openAlerts.reduce((s, a) => s + (SEV_WEIGHT[a.severity] || 1), 0);
        // Sinal bruto: atividade recente + peso de alertas (alertas pesam mais).
        const raw = (doc90s[i]?.count || 0) + weightedAlerts * 15;
        return {
          agency: ag.acronym, name: ag.name,
          docs: docTotals[i]?.count || 0, docs_90d: doc90s[i]?.count || 0,
          open_alerts: openAlerts.length, weighted_alerts: weightedAlerts,
          active_directors: directorsByAgency[ag.id] || 0, raw
        };
      });
      // Normaliza o sinal bruto para 0-100 entre as agencias (min-max).
      const raws = rows.map((r) => r.raw);
      const min = Math.min(...raws, 0), max = Math.max(...raws, 1);
      const span = max - min || 1;
      const scores = rows
        .map((r) => ({ ...r, score: Math.round(100 * (r.raw - min) / span) }))
        .sort((a, b) => b.score - a.score);
      return res.status(200).json({ ok: true, type: "score", window_days: 90, scores });
    }

    // Radar 30/60/90: atos mais recentes agrupados por periodo
    if (type === "radar") {
      // F-INT1: fronteiras por STRING de data (YYYY-MM-DD) — antes new Date(dateStr)
      // parseava UTC-meia-noite contra objetos locais e itens na borda caiam no balde errado.
      const addDaysIso = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
      const today = addDaysIso(0), s30 = addDaysIso(30), s60 = addDaysIso(60), horizon = addDaysIso(90);
      const [contractsRes, mandatesRes] = await Promise.all([
        supabase.from("contracts")
          .select("object, supplier_name, value, ends_at, agencies(acronym)")
          .lte("ends_at", horizon).gte("ends_at", today).order("ends_at").limit(500),
        supabase.from("mandates")
          .select("role, ended_at, people(full_name), agencies(acronym)")
          .lte("ended_at", horizon).gte("ended_at", today).order("ended_at").limit(500)
      ]);

      const radar = { "30d": [], "60d": [], "90d": [] };
      const bucketize = (dateStr, entry) => {
        const d = String(dateStr || "").slice(0, 10);
        if (d <= s30) radar["30d"].push(entry);
        else if (d <= s60) radar["60d"].push(entry);
        else radar["90d"].push(entry);
      };
      for (const c of contractsRes.data || []) {
        bucketize(c.ends_at, {
          type: "contrato", agency: c.agencies?.acronym,
          label: (c.object || "").slice(0, 80), supplier: c.supplier_name, value: c.value != null ? Number(c.value) : null, date: c.ends_at
        });
      }
      // Fim de mandato de dirigente = evento politico-regulatorio (sucessao).
      for (const m of mandatesRes.data || []) {
        bucketize(m.ended_at, {
          type: "mandato", agency: m.agencies?.acronym,
          label: `Fim de mandato: ${m.people?.full_name || "dirigente"}${m.role ? ` (${m.role})` : ""}`.slice(0, 100),
          date: m.ended_at
        });
      }
      const truncated = { contratos: (contractsRes.data || []).length >= 500, mandatos: (mandatesRes.data || []).length >= 500 };
      return res.status(200).json({ ok: true, type: "radar", truncated, radar });
    }

    if (type === "giratoria") {
      // Porta giratoria + SELF-DEALING: diretores que sao socios de empresas, e
      // (o sinal forte) cujas empresas FORNECEM a PROPRIA agencia que dirigem.
      // Correlacao deterministica: mandates x relationships(socio) x contracts.
      const { data: mandates } = await supabase
        .from("mandates")
        .select("person_id, agency_id, role, started_at, ended_at, people(full_name), agencies(acronym)")
        .order("started_at", { ascending: false, nullsFirst: false })
        .limit(3000);
      const mandatesTruncated = (mandates || []).length >= 3000;

      const personIds = [...new Set((mandates || []).map((m) => m.person_id))];
      if (personIds.length === 0) return res.status(200).json({ ok: true, type: "giratoria", cases: [] });

      const [socioRes, partyRes] = await Promise.all([
        supabase.from("relationships").select("from_id, to_id, metadata, companies(id, cnpj, legal_name)")
          .eq("from_kind", "person").eq("to_kind", "company").eq("relationship", "socio").in("from_id", personIds),
        supabase.from("party_links").select("person_id, party").in("person_id", personIds)
      ]);
      const socioRels = socioRes.data || [];

      // Contratos das empresas-socio -> quais agencias cada empresa fornece (+ datas/valores).
      const socioCompanyIds = [...new Set(socioRels.map((r) => r.to_id).filter(Boolean))];
      const supplierAgencies = {}; // company_id -> { agency_id -> [{signed_at, value}] }
      for (let i = 0; i < socioCompanyIds.length; i += 200) {
        // F-INT1: paginado (o teto default de 1000 do PostgREST truncava contratos e
        // podia esconder self-dealing sem aviso).
        const chunk = socioCompanyIds.slice(i, i + 200);
        const cts = [];
        for (let from = 0; from < 20000; from += 1000) {
          const { data: page } = await supabase.from("contracts")
            .select("supplier_company_id, agency_id, signed_at, value")
            .in("supplier_company_id", chunk).order("id", { ascending: true }).range(from, from + 999);
          cts.push(...(page || []));
          if (!page || page.length < 1000) break;
        }
        for (const c of cts || []) {
          if (!c.supplier_company_id || !c.agency_id) continue;
          const m = (supplierAgencies[c.supplier_company_id] = supplierAgencies[c.supplier_company_id] || {});
          (m[c.agency_id] = m[c.agency_id] || []).push({ signed_at: c.signed_at, value: c.value });
        }
      }

      const partyByPerson = {};
      for (const pl of partyRes.data || []) (partyByPerson[pl.person_id] = partyByPerson[pl.person_id] || []).push(pl.party);
      const socioByPerson = {};
      for (const r of socioRels) (socioByPerson[r.from_id] = socioByPerson[r.from_id] || [])
        .push({ company_id: r.to_id, company: r.companies?.legal_name, cnpj: r.companies?.cnpj, role: r.metadata?.role });

      // F-INT1: avalia TODOS os mandatos de cada pessoa (antes: so o 1o em ordem
      // arbitraria — podia descartar exatamente o mandato com self-dealing).
      const byPerson = new Map();
      for (const m of mandates || []) {
        const socios = socioByPerson[m.person_id];
        if (!socios || !socios.length) continue; // REQUER vinculo societario (filiacao-so NAO e porta-giratoria)
        if (!byPerson.has(m.person_id)) byPerson.set(m.person_id, []);
        byPerson.get(m.person_id).push(m);
      }
      const cases = [];
      for (const [personId, ms] of byPerson) {
        const socios = socioByPerson[personId];
        const selfDealing = []; const selfKeys = new Set();
        let duringMandate = false;
        let best = null; // o mandato que evidencia o caso (prioridade: self-dealing > ativo > mais recente)
        for (const m of ms) {
          for (const s of socios) {
            const ags = supplierAgencies[s.company_id];
            if (!ags || !m.agency_id || !ags[m.agency_id]) continue;
            const key = `${s.company_id}|${m.agency_id}`;
            if (!selfKeys.has(key)) { selfKeys.add(key); selfDealing.push({ ...s, agency: m.agencies?.acronym }); }
            // best = mandato self-dealing preferindo ATIVO, senao o mais recente.
            if (!best) best = m;
            else if (!m.ended_at && best.ended_at) best = m;
            else if (!!m.ended_at === !!best.ended_at && String(m.started_at || "") > String(best.started_at || "")) best = m;
            // timing: contrato assinado DENTRO da janela do mandato?
            for (const c of ags[m.agency_id]) {
              if (c.signed_at && m.started_at && c.signed_at >= m.started_at && (!m.ended_at || c.signed_at <= m.ended_at)) duringMandate = true;
            }
          }
        }
        if (!best) best = ms.find((m) => !m.ended_at) || ms.slice().sort((a, b) => String(b.started_at || "").localeCompare(String(a.started_at || "")))[0];
        const selfCompanyIds = new Set(selfDealing.map((s) => s.company_id));
        const publicSupplier = socios.filter((s) => supplierAgencies[s.company_id] && !selfCompanyIds.has(s.company_id));
        const severity = selfDealing.length ? "critical" : (publicSupplier.length ? "high" : "medium");
        cases.push({
          person_id: personId, name: best.people?.full_name || "?", agency: best.agencies?.acronym, role: best.role,
          mandate_from: best.started_at, mandate_to: best.ended_at, active: ms.some((m) => !m.ended_at),
          companies: socios, self_dealing: selfDealing, public_supplier: publicSupplier,
          contract_during_mandate: duringMandate,
          parties: partyByPerson[personId] || [], severity,
          rationale: selfDealing.length
            ? `Sócio de ${selfDealing.length} fornecedor(es) da PRÓPRIA agência que dirige/dirigiu${duringMandate ? " — com contrato assinado durante o mandato" : ""}`
            : (publicSupplier.length ? "Sócio de fornecedor público (outra agência)" : "Vínculo societário durante o mandato")
        });
      }
      // Contrato assinado DURANTE o mandato primeiro (o timing e o agravante), depois self-dealing.
      cases.sort((a, b) => ((b.contract_during_mandate ? 1 : 0) - (a.contract_during_mandate ? 1 : 0)) || (b.self_dealing.length - a.self_dealing.length) || (b.companies.length - a.companies.length));
      return res.status(200).json({
        ok: true, type: "giratoria", total: cases.length, truncated: mandatesTruncated,
        self_dealing_count: cases.filter((c) => c.self_dealing.length).length, cases
      });
    }

    if (type === "agency_stats") {
      const acronym = String(req.query.agency || "").toUpperCase();
      if (!acronym) return res.status(400).json({ ok: false, error: "Informe ?agency=SIGLA" });
      const { data: ag } = await supabase.from("agencies").select("id, acronym, name").eq("acronym", acronym).maybeSingle();
      if (!ag) return res.status(404).json({ ok: false, error: "Agência não encontrada" });
      const now = new Date();
      const since30 = new Date(now - 30 * 86400000).toISOString().slice(0, 10);
      const since8w = new Date(now - 56 * 86400000).toISOString().slice(0, 10);
      // F-INT1: contagens com filtro DOU (consistente com o motor de anomalias); alertas
      // abertos = COUNT real (antes .limit(5).length capava em 5); weekly paginado desc.
      const weeklyDocs = [];
      const [docsTotal, docs30d, alertsRes, alertsCount, mandatesRes] = await Promise.all([
        supabase.from("documents").select("id", { count: "exact", head: true }).eq("agency_id", ag.id).eq("source_name", "DOU"),
        supabase.from("documents").select("id", { count: "exact", head: true }).eq("agency_id", ag.id).eq("source_name", "DOU").gte("published_at", since30),
        supabase.from("alerts").select("id, alert_type, severity, title, body, created_at").eq("target_id", ag.id).is("acknowledged_at", null).order("created_at", { ascending: false }).limit(5),
        supabase.from("alerts").select("id", { count: "exact", head: true }).eq("target_id", ag.id).is("acknowledged_at", null),
        supabase.from("mandates").select("id", { count: "exact", head: true }).eq("agency_id", ag.id).is("ended_at", null)
      ]);
      for (let from = 0; from < 20000; from += 1000) { // desc: se truncar, perde as semanas ANTIGAS (nunca a atual)
        const { data, error } = await supabase.from("documents").select("published_at").eq("agency_id", ag.id).eq("source_name", "DOU").gte("published_at", since8w).order("published_at", { ascending: false }).order("id", { ascending: false }).range(from, from + 999);
        if (error) return res.status(500).json({ ok: false, error: error.message });
        weeklyDocs.push(...(data || []));
        if (!data || data.length < 1000) break;
      }
      const weekKeyOf = (dateStr) => { const dt = new Date(dateStr + "T12:00:00Z"); dt.setUTCDate(dt.getUTCDate() - dt.getUTCDay()); return dt.toISOString().slice(0, 10); };
      const weekBuckets = {};
      for (const d of weeklyDocs) { const k = weekKeyOf(d.published_at); weekBuckets[k] = (weekBuckets[k] || 0) + 1; }
      // Série com as 8 semanas COMPLETAS no eixo (semanas zeradas INCLUÍDAS — consistente
      // com weeklyAgencyAnalysis); baseline = média das semanas ANTERIORES à atual.
      const currentWeek = weekKeyOf(now.toISOString().slice(0, 10));
      const weekly_series = [];
      for (let i = 7; i >= 0; i--) {
        const dt = new Date(currentWeek + "T12:00:00Z"); dt.setUTCDate(dt.getUTCDate() - i * 7);
        const k = dt.toISOString().slice(0, 10);
        weekly_series.push({ week: k, total: weekBuckets[k] || 0, current: k === currentWeek });
      }
      const past = weekly_series.filter((w) => !w.current);
      const baseline_avg = past.length ? Math.round(past.reduce((s, w) => s + w.total, 0) / past.length) : 0;
      return res.status(200).json({
        ok: true, type: "agency_stats",
        agency: ag.acronym, agency_name: ag.name,
        total_docs: docsTotal.count || 0, docs_30d: docs30d.count || 0,
        open_alerts: alertsCount.count || 0, active_directors: mandatesRes.count || 0,
        weekly_series, baseline_avg, alerts: alertsRes.data || []
      });
    }

    if (type === "dismiss_alert") {
      // Mutacao: nunca deixar o CDN cachear a resposta.
      res.setHeader("Cache-Control", "no-store");
      const id = String(req.query.id || "").trim();
      if (!id) return res.status(400).json({ ok: false, error: "Informe ?id=<uuid>" });
      const { error: upErr } = await supabase.from("alerts").update({ acknowledged_at: new Date().toISOString() }).eq("id", id);
      if (upErr) return res.status(500).json({ ok: false, error: upErr.message });
      return res.status(200).json({ ok: true });
    }

    // ── Monitores de vigilância (estilo Arko Alerta) ────────────────────────
    if (type === "monitors") {
      res.setHeader("Cache-Control", "no-store");
      const { data, error } = await supabase.from("monitors").select("*").order("created_at", { ascending: false });
      if (error) return res.status(500).json({ ok: false, error: error.message });
      return res.status(200).json({ ok: true, items: data || [] });
    }

    if (type === "monitor_save") {
      res.setHeader("Cache-Control", "no-store");
      const p = params(req);
      const kind = String(p.kind || "").trim();
      const label = String(p.label || "").trim();
      const pattern = String(p.pattern || "").trim();
      if (!["keyword", "person", "company", "agency"].includes(kind)) {
        return res.status(400).json({ ok: false, error: "kind invalido. Use: keyword, person, company, agency" });
      }
      const normalized = normalizeName(pattern);
      if (normalized.length < 3) {
        return res.status(400).json({ ok: false, error: "Padrao muito curto (min. 3 caracteres uteis)." });
      }
      const row = {
        kind,
        label: label || pattern,
        pattern,
        normalized_pattern: normalized,
        severity: ["info", "medium", "high"].includes(p.severity) ? p.severity : "medium",
        updated_at: new Date().toISOString()
      };
      if (typeof p.active === "boolean") row.active = p.active; // F-INT1: o front sempre envia active — antes era ignorado
      // F-INT1: cpf_cnpj SEMPRE recalculado (limpa o antigo se o padrao deixou de ser CNPJ/CPF).
      const digits = onlyDigits(p.cpf_cnpj || pattern);
      row.cpf_cnpj = (digits.length === 11 || digits.length === 14) ? digits : null;
      // kind=agency: resolve a sigla para agency_id (match por UUID no cron).
      if (kind === "agency") {
        const { data: ag } = await supabase.from("agencies").select("id, acronym").eq("acronym", normalized.replace(/\s+/g, "")).maybeSingle();
        if (!ag) return res.status(400).json({ ok: false, error: `Agencia "${pattern}" nao encontrada. Use a sigla (ex.: ANEEL).` });
        row.agency_id = ag.id;
      }
      let result;
      if (p.id) {
        result = await supabase.from("monitors").update(row).eq("id", p.id).select().maybeSingle();
      } else {
        result = await supabase.from("monitors").insert(row).select().maybeSingle();
      }
      if (result.error) return res.status(500).json({ ok: false, error: result.error.message });
      if (!result.data) return res.status(404).json({ ok: false, error: "Monitor nao encontrado." });

      // F-INT1 (F4): BACKFILL — testa o monitor recem-criado/editado contra os atos dos
      // ultimos 90d (antes: monitor novo so valia a partir do proximo cron; "Nunca disparou"
      // parecia ausencia de fato). Best-effort, cap de 400 atos mais recentes.
      let backfillHits = 0, backfillError = null;
      if (result.data.active !== false) {
        try {
          const { matchMonitorsForDoc, flushMonitorAlerts } = require("../lib/ingest");
          const since90 = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
          const mon = [result.data];
          const allHits = [];
          for (let from = 0; from < 400; from += 100) {
            const { data: docs, error: dErr } = await supabase.from("documents")
              .select("id, title, extracted_text, agency_id, published_at, metadata, agencies(acronym)")
              .eq("source_name", "DOU").gte("published_at", since90)
              .order("published_at", { ascending: false }).order("id", { ascending: false })
              .range(from, from + 99);
            if (dErr) throw new Error(dErr.message);
            for (const d of docs || []) {
              const hits = matchMonitorsForDoc(mon, {
                docId: d.id, title: d.title, text: d.extracted_text, agencyId: d.agency_id,
                agencyAcronym: d.agencies?.acronym, publishedAt: d.published_at, aiEntities: d.metadata?.ai_entities
              });
              for (const h of hits) allHits.push(h.alert);
            }
            if (!docs || docs.length < 100) break;
          }
          // flushMonitorAlerts retorna so os INSERTS reais (re-save nao infla hit_count).
          if (allHits.length) backfillHits = await flushMonitorAlerts(supabase, allHits, null);
        } catch (e) { backfillError = e.message; } // best-effort: o monitor ja foi salvo — mas a falha e VISIVEL
      }
      return res.status(200).json({ ok: true, monitor: result.data, backfill_hits: backfillHits, backfill_error: backfillError });
    }

    if (type === "monitor_toggle") {
      res.setHeader("Cache-Control", "no-store");
      const p = params(req);
      const id = String(p.id || "").trim();
      if (!id) return res.status(400).json({ ok: false, error: "Informe id" });
      const { data: cur } = await supabase.from("monitors").select("active").eq("id", id).maybeSingle();
      if (!cur) return res.status(404).json({ ok: false, error: "Monitor nao encontrado." });
      const active = typeof p.active === "boolean" ? p.active : String(p.active || "") === "true" ? true : String(p.active || "") === "false" ? false : !cur.active;
      const { error: upErr } = await supabase.from("monitors").update({ active, updated_at: new Date().toISOString() }).eq("id", id);
      if (upErr) return res.status(500).json({ ok: false, error: upErr.message });
      return res.status(200).json({ ok: true, active });
    }

    if (type === "monitor_delete") {
      res.setHeader("Cache-Control", "no-store");
      const p = params(req);
      const id = String(p.id || "").trim();
      if (!id) return res.status(400).json({ ok: false, error: "Informe id" });
      const { error: delErr } = await supabase.from("monitors").delete().eq("id", id);
      if (delErr) return res.status(500).json({ ok: false, error: delErr.message });
      return res.status(200).json({ ok: true });
    }

    if (type === "monitor_alerts") {
      res.setHeader("Cache-Control", "no-store");
      const limit = Math.min(Number(req.query.limit) || 30, 100);
      const { data, error } = await supabase
        .from("alerts")
        .select("id, alert_type, severity, title, body, created_at, metadata, acknowledged_at")
        .eq("alert_type", "monitor")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) return res.status(500).json({ ok: false, error: error.message });
      return res.status(200).json({ ok: true, items: data || [] });
    }

    // ── M21: Paineis curados (NOMOS F1). CRUD multiplexado, molde monitor_*. ──
    if (type === "painel_list") {
      res.setHeader("Cache-Control", "no-store");
      const { data: paineis, error } = await supabase.from("paineis").select("*").order("created_at", { ascending: false });
      if (error) return res.status(500).json({ ok: false, error: error.message });
      // Contadores por painel: pagina painel_items p/ nao estourar o teto do PostgREST (1000).
      const counts = new Map();
      const zero = () => ({ proposicao: 0, stakeholder: 0, orgao: 0, evento: 0, monitor: 0, total: 0 });
      const PAGE = 1000;
      for (let from = 0; ; from += PAGE) {
        const { data: items, error: itemsErr } = await supabase.from("painel_items").select("painel_id, item_kind").range(from, from + PAGE - 1);
        if (itemsErr) return res.status(500).json({ ok: false, error: itemsErr.message });
        for (const it of items || []) {
          const c = counts.get(it.painel_id) || zero();
          if (c[it.item_kind] !== undefined) c[it.item_kind]++;
          c.total++; counts.set(it.painel_id, c);
        }
        if (!items || items.length < PAGE) break;
      }
      return res.status(200).json({ ok: true, items: (paineis || []).map((p) => ({ ...p, counts: counts.get(p.id) || zero() })) });
    }

    if (type === "painel_get") {
      res.setHeader("Cache-Control", "no-store");
      const id = String(req.query.id || "").trim();
      if (!id) return res.status(400).json({ ok: false, error: "Informe id" });
      const { data: painel } = await supabase.from("paineis").select("*").eq("id", id).maybeSingle();
      if (!painel) return res.status(404).json({ ok: false, error: "Painel nao encontrado." });
      const { data: rows } = await supabase.from("painel_items").select("*").eq("painel_id", id).order("created_at", { ascending: true });
      const items = rows || [];
      const refsOf = (kind) => items.filter((r) => r.item_kind === kind).map((r) => r.ref_id);
      const propRefs = refsOf("proposicao"), stakeRefs = refsOf("stakeholder"), orgaoRefs = refsOf("orgao");
      const [propsRes, stakeRes, orgaoRes, agendaRes, noticiasRes] = await Promise.allSettled([
        propRefs.length ? supabase.from("proposicoes").select("id, casa, tipo, numero, ano, titulo, ementa, situacao, themes, url").in("id", propRefs) : Promise.resolve({ data: [] }),
        stakeRefs.length ? supabase.from("people").select("id, full_name, role, uf, external_ids").in("id", stakeRefs) : Promise.resolve({ data: [] }),
        orgaoRefs.length ? supabase.from("agencies").select("id, acronym, name").in("id", orgaoRefs) : Promise.resolve({ data: [] }),
        // F4: proposicoes do painel que estao NA PAUTA de eventos (join embutido; [] se M22 ausente).
        propRefs.length ? supabase.from("evento_pauta").select("proposicao_id, ordem, topico, titulo, situacao_item, regime, legislative_eventos(id, data_inicio, data_fim, situacao, tipo, orgao_sigla, orgao_nome, local, url)").in("proposicao_id", propRefs) : Promise.resolve({ data: [] }),
        // F7: noticias curadas do painel ([] se M24 ausente).
        supabase.from("painel_noticias").select("id, url, titulo, fonte, published_at, resumo, added_by, created_at").eq("painel_id", id).order("created_at", { ascending: false }).limit(50)
      ]);
      const mapOf = (r) => new Map(((r.status === "fulfilled" ? r.value.data : null) || []).map((x) => [String(x.id), x]));
      const propMap = mapOf(propsRes), stakeMap = mapOf(stakeRes), orgaoMap = mapOf(orgaoRes);
      const hydrate = (r, m) => ({ item_id: r.id, item_kind: r.item_kind, ref_id: r.ref_id, prioridade: r.prioridade, posicionamento: r.posicionamento, tags: r.tags, nota: r.nota, data: m.get(String(r.ref_id)) || null });
      const proposicoes = items.filter((r) => r.item_kind === "proposicao").map((r) => hydrate(r, propMap));
      const stakeholders = items.filter((r) => r.item_kind === "stakeholder").map((r) => hydrate(r, stakeMap));
      const orgaos = items.filter((r) => r.item_kind === "orgao").map((r) => hydrate(r, orgaoMap));
      // Agenda: itens de pauta cujo evento e FUTURO (grace de 6h), ordenados por data.
      const agFloor = Date.now() - 6 * 3600 * 1000;
      const agenda = ((agendaRes.status === "fulfilled" ? agendaRes.value.data : null) || [])
        .map((r) => ({ proposicao_id: r.proposicao_id, prop_titulo: (propMap.get(String(r.proposicao_id)) || {}).titulo || r.titulo || r.proposicao_id, ordem: r.ordem, topico: r.topico, situacao_item: r.situacao_item, regime: r.regime, evento: r.legislative_eventos || null }))
        .filter((r) => r.evento && r.evento.data_inicio && new Date(r.evento.data_inicio).getTime() >= agFloor)
        .sort((a, b) => String(a.evento.data_inicio).localeCompare(String(b.evento.data_inicio)))
        .slice(0, 60);
      const noticias = ((noticiasRes.status === "fulfilled" ? noticiasRes.value.data : null) || []);
      return res.status(200).json({ ok: true, painel, proposicoes, stakeholders, orgaos, agenda, noticias, counts: { proposicoes: proposicoes.length, stakeholders: stakeholders.length, orgaos: orgaos.length, agenda: agenda.length, noticias: noticias.length } });
    }

    if (type === "painel_save") {
      res.setHeader("Cache-Control", "no-store");
      const p = params(req);
      const nome = String(p.nome || "").trim();
      if (nome.length < 2) return res.status(400).json({ ok: false, error: "Informe o nome do painel." });
      const row = {
        nome, cliente: p.cliente ? String(p.cliente).slice(0, 200) : null,
        descricao: p.descricao ? String(p.descricao).slice(0, 1000) : null,
        tema: Array.isArray(p.tema) ? p.tema : null,
        webhook_url: p.webhook_url ? String(p.webhook_url).slice(0, 500) : null,
        frequencia: ["tempo_real", "diario", "off"].includes(p.frequencia) ? p.frequencia : "diario",
        owner_email: p.owner_email ? String(p.owner_email).slice(0, 200) : null,
        updated_at: new Date().toISOString()
      };
      const result = p.id
        ? await supabase.from("paineis").update(row).eq("id", p.id).select().maybeSingle()
        : await supabase.from("paineis").insert(row).select().maybeSingle();
      if (result.error) return res.status(500).json({ ok: false, error: result.error.message });
      if (!result.data) return res.status(404).json({ ok: false, error: "Painel nao encontrado." });
      return res.status(200).json({ ok: true, painel: result.data });
    }

    if (type === "painel_delete") {
      res.setHeader("Cache-Control", "no-store");
      const id = String(params(req).id || "").trim();
      if (!id) return res.status(400).json({ ok: false, error: "Informe id" });
      const { error } = await supabase.from("paineis").delete().eq("id", id);
      if (error) return res.status(500).json({ ok: false, error: error.message });
      return res.status(200).json({ ok: true });
    }

    if (type === "painel_item_add") {
      res.setHeader("Cache-Control", "no-store");
      const p = params(req);
      const painel_id = String(p.painel_id || "").trim();
      const item_kind = String(p.item_kind || "").trim();
      const ref_id = String(p.ref_id || "").trim();
      if (!painel_id || !ref_id) return res.status(400).json({ ok: false, error: "Informe painel_id e ref_id" });
      if (!["proposicao", "stakeholder", "orgao", "evento", "monitor"].includes(item_kind)) return res.status(400).json({ ok: false, error: "item_kind invalido" });
      // Valida existencia do ref (evita item orfao) p/ os kinds com tabela.
      const tbl = { proposicao: "proposicoes", stakeholder: "people", orgao: "agencies" }[item_kind];
      if (tbl) {
        const { data: exists } = await supabase.from(tbl).select("id").eq("id", ref_id).maybeSingle();
        if (!exists) return res.status(400).json({ ok: false, error: `Referência ${item_kind} não encontrada na base.` });
      }
      const row = {
        painel_id, item_kind, ref_id,
        prioridade: ["alta", "media", "baixa"].includes(p.prioridade) ? p.prioridade : "media",
        posicionamento: ["favoravel", "contrario", "neutro"].includes(p.posicionamento) ? p.posicionamento : "neutro",
        tags: Array.isArray(p.tags) ? p.tags : null,
        nota: p.nota ? String(p.nota).slice(0, 1000) : null,
        added_by: p.added_by ? String(p.added_by).slice(0, 200) : null
      };
      const { data, error } = await supabase.from("painel_items").upsert(row, { onConflict: "painel_id,item_kind,ref_id" }).select().maybeSingle();
      if (error) return res.status(500).json({ ok: false, error: error.message });
      return res.status(200).json({ ok: true, item: data });
    }

    if (type === "painel_item_update") {
      res.setHeader("Cache-Control", "no-store");
      const p = params(req);
      const id = String(p.id || "").trim();
      if (!id) return res.status(400).json({ ok: false, error: "Informe id" });
      const patch = {};
      if (["alta", "media", "baixa"].includes(p.prioridade)) patch.prioridade = p.prioridade;
      if (["favoravel", "contrario", "neutro"].includes(p.posicionamento)) patch.posicionamento = p.posicionamento;
      if (Array.isArray(p.tags)) patch.tags = p.tags;
      if (p.nota !== undefined) patch.nota = p.nota ? String(p.nota).slice(0, 1000) : null;
      if (!Object.keys(patch).length) return res.status(400).json({ ok: false, error: "Nada a atualizar" });
      const { data, error } = await supabase.from("painel_items").update(patch).eq("id", id).select().maybeSingle();
      if (error) return res.status(500).json({ ok: false, error: error.message });
      if (!data) return res.status(404).json({ ok: false, error: "Item nao encontrado." });
      return res.status(200).json({ ok: true, item: data });
    }

    if (type === "painel_item_remove") {
      res.setHeader("Cache-Control", "no-store");
      const id = String(params(req).id || "").trim();
      if (!id) return res.status(400).json({ ok: false, error: "Informe id" });
      const { error } = await supabase.from("painel_items").delete().eq("id", id);
      if (error) return res.status(500).json({ ok: false, error: error.message });
      return res.status(200).json({ ok: true });
    }

    if (type === "painel_import_resolve") {
      res.setHeader("Cache-Control", "no-store");
      const { parseProposicaoRefs, resolveProposicaoRef } = require("../lib/legislativo");
      const refs = parseProposicaoRefs(String(params(req).texto || ""));
      if (!refs.length) return res.status(200).json({ ok: true, resolved: [], note: "Nenhuma referência reconhecida (ex.: 'PL 1234/2025')." });
      const settled = await Promise.allSettled(refs.slice(0, 50).map(async (ref) => ({ ref, matched: await resolveProposicaoRef(ref) })));
      return res.status(200).json({ ok: true, resolved: settled.map((s) => (s.status === "fulfilled" ? s.value : { ref: null, matched: [] })) });
    }

    if (type === "painel_import_confirm") {
      res.setHeader("Cache-Control", "no-store");
      const p = params(req);
      const painel_id = String(p.painel_id || "").trim();
      const list = Array.isArray(p.items) ? p.items : [];
      if (!painel_id || !list.length) return res.status(400).json({ ok: false, error: "Informe painel_id e items" });
      let added = 0, failed = 0;
      for (const it of list.slice(0, 200)) {
        if (!it || !it.id) { failed++; continue; }
        const propRow = {
          id: String(it.id), casa: it.casa || null, tipo: it.tipo || null,
          numero: it.numero != null ? String(it.numero) : null, ano: it.ano ? Number(it.ano) : null,
          ementa: it.ementa || null, titulo: it.titulo || null, url: it.url || null, last_seen: new Date().toISOString()
        };
        const up = await supabase.from("proposicoes").upsert(propRow, { onConflict: "id" });
        if (up.error) { failed++; continue; }
        const ins = await supabase.from("painel_items").upsert(
          { painel_id, item_kind: "proposicao", ref_id: String(it.id), prioridade: "media", posicionamento: "neutro" },
          { onConflict: "painel_id,item_kind,ref_id" }
        );
        if (ins.error) { failed++; continue; }
        added++;
      }
      return res.status(200).json({ ok: true, added, failed });
    }

    // F3: relatorio do painel (JSON + markdown p/ handoff ao Claude Design).
    if (type === "painel_report") {
      res.setHeader("Cache-Control", "no-store");
      const id = String(req.query.id || "").trim();
      if (!id) return res.status(400).json({ ok: false, error: "Informe id" });
      const { buildPainelDigest, toMarkdown } = require("../lib/painel-report");
      const since = req.query.since ? String(req.query.since) : undefined;
      const digest = await buildPainelDigest(supabase, id, { since });
      if (!digest) return res.status(404).json({ ok: false, error: "Painel nao encontrado." });
      return res.status(200).json({ ok: true, digest, markdown: toMarkdown(digest) });
    }

    // F3: envia o relatorio AGORA (webhook do painel + e-mail gated). Testa a entrega.
    if (type === "painel_send_report") {
      res.setHeader("Cache-Control", "no-store");
      const id = String(params(req).id || "").trim();
      if (!id) return res.status(400).json({ ok: false, error: "Informe id" });
      const { buildPainelDigest, toText, toEmailHtml } = require("../lib/painel-report");
      const { postWebhook } = require("../lib/notify");
      const { sendEmail } = require("../lib/mailer");
      const digest = await buildPainelDigest(supabase, id);
      if (!digest) return res.status(404).json({ ok: false, error: "Painel nao encontrado." });
      const painel = digest.painel;
      const [webhook, email] = await Promise.all([
        painel.webhook_url ? postWebhook(painel.webhook_url, { text: toText(digest), label: painel.nome }) : Promise.resolve({ ok: false, skipped: "no_webhook_url" }),
        painel.owner_email ? sendEmail({ to: painel.owner_email, subject: `LINCE · Painel ${painel.nome}`, html: toEmailHtml(digest), text: toText(digest) }) : Promise.resolve({ ok: false, skipped: "no_owner_email" })
      ]);
      // "Enviar agora" e um snapshot manual/teste: NAO move o cursor do digest agendado
      // (last_report_at, baseado em ingestao). So o scripts/send-painel-reports o avanca.
      return res.status(200).json({ ok: true, delivered: { webhook, email }, counts: digest.counts });
    }

    // F5: gera/rotaciona o link read-only do cliente (operador — atras do middleware).
    if (type === "painel_share") {
      res.setHeader("Cache-Control", "no-store");
      const id = String(params(req).id || "").trim();
      if (!id) return res.status(400).json({ ok: false, error: "Informe id" });
      const token = require("crypto").randomBytes(24).toString("hex"); // 48 hex = 192 bits
      const { data, error } = await supabase.from("paineis").update({ share_token: token, updated_at: new Date().toISOString() }).eq("id", id).select("id").maybeSingle();
      if (error) return res.status(500).json({ ok: false, error: error.message });
      if (!data) return res.status(404).json({ ok: false, error: "Painel nao encontrado." });
      return res.status(200).json({ ok: true, token });
    }

    // F5: revoga o link do cliente (operador).
    if (type === "painel_unshare") {
      res.setHeader("Cache-Control", "no-store");
      const id = String(params(req).id || "").trim();
      if (!id) return res.status(400).json({ ok: false, error: "Informe id" });
      const { error } = await supabase.from("paineis").update({ share_token: null, updated_at: new Date().toISOString() }).eq("id", id);
      if (error) return res.status(500).json({ ok: false, error: error.message });
      return res.status(200).json({ ok: true });
    }

    // F5: painel PUBLICO (link do cliente, sem login — bypass no middleware). Devolve SO
    // dados sanitizados: nunca owner_email/webhook_url/share_token/metadata/nota nem outro painel.
    if (type === "painel_public") {
      res.setHeader("Cache-Control", "no-store");
      const token = String(req.query.token || "").trim();
      if (token.length < 24) return res.status(400).json({ ok: false, error: "token invalido" });
      const { data: pRow } = await supabase.from("paineis").select("id").eq("share_token", token).maybeSingle();
      if (!pRow) return res.status(404).json({ ok: false, error: "Painel nao encontrado." });
      const { buildPainelDigest } = require("../lib/painel-report");
      const digest = await buildPainelDigest(supabase, pRow.id);
      if (!digest) return res.status(404).json({ ok: false, error: "Painel nao encontrado." });
      // Sanitiza: painel = so branding; itens = sem item_id/nota (notas do operador sao internas).
      const pub = { nome: digest.painel.nome, cliente: digest.painel.cliente, descricao: digest.painel.descricao };
      const sProp = (it) => ({ ref_id: it.ref_id, prioridade: it.prioridade, posicionamento: it.posicionamento, tags: it.tags, data: it.data });
      const sEnt = (it) => ({ ref_id: it.ref_id, data: it.data });
      // F7: reusa digest.noticias (ja sanitizado: url/titulo/fonte/published_at/resumo,
      // sem id/added_by) — evita 2a leitura de painel_noticias neste endpoint publico.
      return res.status(200).json({
        ok: true, painel: pub,
        noticias: digest.noticias || [],
        proposicoes: (digest.proposicoes || []).map(sProp),
        agenda: digest.na_pauta || [],
        votacoes: digest.novas_votacoes || [],
        stakeholders: (digest.stakeholders || []).map(sEnt),
        orgaos: (digest.orgaos || []).map(sEnt),
        counts: digest.counts
      });
    }

    // F7: fixa uma noticia curada no painel (operador). Sem SSRF: o servidor NAO busca a
    // URL — so persiste os campos recebidos (da busca Google News ou colados).
    if (type === "painel_noticia_add") {
      res.setHeader("Cache-Control", "no-store");
      const p = params(req);
      const painel_id = String(p.painel_id || "").trim();
      const url = String(p.url || "").trim();
      if (!painel_id || !url) return res.status(400).json({ ok: false, error: "Informe painel_id e url" });
      if (!/^https?:\/\//i.test(url)) return res.status(400).json({ ok: false, error: "url invalida (http/https)" });
      let published_at = null;
      if (p.published_at) { const d = new Date(p.published_at); if (!Number.isNaN(d.getTime())) published_at = d.toISOString(); }
      const row = {
        painel_id, url: url.slice(0, 1000),
        titulo: p.titulo ? String(p.titulo).slice(0, 400) : null,
        fonte: p.fonte ? String(p.fonte).slice(0, 200) : null,
        published_at,
        resumo: p.resumo ? String(p.resumo).slice(0, 1000) : null,
        added_by: p.added_by ? String(p.added_by).slice(0, 200) : null
      };
      const { data, error } = await supabase.from("painel_noticias").upsert(row, { onConflict: "painel_id,url" }).select().maybeSingle();
      if (error) return res.status(500).json({ ok: false, error: error.message });
      return res.status(200).json({ ok: true, noticia: data });
    }

    // F7: remove uma noticia curada (operador).
    if (type === "painel_noticia_remove") {
      res.setHeader("Cache-Control", "no-store");
      const id = String(params(req).id || "").trim();
      if (!id) return res.status(400).json({ ok: false, error: "Informe id" });
      const { error } = await supabase.from("painel_noticias").delete().eq("id", id);
      if (error) return res.status(500).json({ ok: false, error: error.message });
      return res.status(200).json({ ok: true });
    }

    // ===== M25: Modulo "Eventos" (gestao de seminarios IRIS) — types evt_* =====
    if (type.startsWith("evt_")) {
      res.setHeader("Cache-Control", "no-store");
      const EVT_COL_TYPES = ["text", "date", "select", "check", "url", "num"];
      const EVT_STATUS = ["planejamento", "confirmado", "realizado", "cancelado"];
      const EVT_DEFAULT_COLS = [
        { key: "item", label: "Item", type: "text" },
        { key: "categoria", label: "Categoria", type: "select", options: ["Operacional", "Marketing", "Comunicacao", "Paineis", "Patrocinio", "Financeiro"] },
        { key: "responsavel", label: "Responsavel", type: "text" },
        { key: "prazo", label: "Prazo", type: "date" },
        { key: "status", label: "Status", type: "select", options: ["pendente", "andamento", "feito"] },
        { key: "link", label: "Link", type: "url" },
        { key: "obs", label: "Obs", type: "text" }
      ];
      // [item, categoria, obs?, offset?] — offset (D-x) auto-data o prazo a partir da data do evento (F-EVT7).
      const EVT_SEED = [
        ["Gerador", "Operacional", null, -10], ["Hotel", "Operacional", null, -30], ["Passagens", "Operacional", null, -30],
        ["Financeiro", "Financeiro", null, -30], ["Credenciamento", "Operacional", null, -15], ["Coffee / welcome coffee", "Operacional", null, -10],
        ["Backdrop", "Marketing", "Painel LED: 1.280x512 e 128x512 px", -7], ["Save the date", "Marketing", null, -20], ["Post Instagram", "Marketing", null, -14],
        ["Post LinkedIn", "Marketing", null, -14], ["Stories", "Marketing", null, -5], ["Release / imprensa", "Marketing", null, -10],
        ["Carta-convite (painelistas)", "Comunicacao", null, -30], ["Pedido de minibio + foto", "Comunicacao", "apos aceite", -25],
        ["Autorizacao de uso de imagem", "Comunicacao", "apos aceite", -25], ["Abrir RSVP (formulario)", "Comunicacao", null, -21], ["Lembrete de RSVP", "Comunicacao", "D-7 e D-2", -7],
        // F-EVT5: materiais de envio (mensagens do mes).
        ["Convite a orgaos/empresas p/ indicarem convidados (ate N)", "Comunicacao", "variar por organizacao", -21],
        ["Convite + RSVP aos convidados (link do formulario)", "Comunicacao", null, -21],
        ["Encaminhar programacao aos convidados", "Comunicacao", null, -3],
        ["Solicitar autorizacao de logo no LED/backdrop (patrocinadores)", "Comunicacao", null, -14],
        ["Confirmacao final + instrucoes de credenciamento", "Comunicacao", null, -2],
        ["Revisar minibios antes de postar", "Marketing", "antes de cada post (QA)", -12],
        ["Fechar painelistas/moderadores", "Paineis", null, -35], ["Coletar minibios", "Paineis", null, -25], ["Programacao preliminar", "Paineis", null, -20]
      ];
      const nowIso = new Date().toISOString();

      // F-EVT2: métricas de um evento a partir das listas já carregadas.
      const evtMetricas = (itens, pain, patr, conv, prog) => {
        const feito = itens.filter((x) => (x.valores || {}).status === "feito").length;
        const fechado = patr.filter((x) => x.status === "fechado");
        const somaRs = (arr) => arr.reduce((s, x) => s + (Number(x.valor) || 0), 0);
        return {
          checklist: { total: itens.length, feito, pct: itens.length ? Math.round((feito / itens.length) * 100) : 0 },
          painelistas: { total: pain.length, confirmados: pain.filter((x) => x.status === "confirmado").length },
          patrocinio: { fechado_rs: somaRs(fechado), pipeline_rs: somaRs(patr), fechados_n: fechado.length },
          convidados: { total: conv.length, confirmados: conv.filter((x) => x.status === "confirmado").length },
          programacao: { blocos: prog.length }
        };
      };
      // Varre uma tabela inteira paginando (teto 1000 do PostgREST). Lança em erro.
      const evtScanAll = async (table, cols, fn) => {
        for (let from = 0; ; from += 1000) {
          const { data, error } = await supabase.from(table).select(cols).range(from, from + 999);
          if (error) throw new Error(`${table}: ${error.message}`);
          for (const r of data || []) fn(r);
          if (!data || data.length < 1000) break;
        }
      };
      // F-EVT6: taxonomia de segmento de convidado (densidade de ICP). IDENTICA no front (app.js).
      // "Compradores" (densidade que fecha cota) = Autoridade + Operadores + Regulador/Governo.
      const EVT_SEGMENTOS = ["Autoridade", "Operador publico", "Operador privado/Concessionaria", "Regulador/Governo", "Fornecedor", "Investidor/Financiador", "Consultoria/Juridico", "Associacao/Entidade", "Imprensa/Academia", "Outro"];
      // F-EVT7: estagios do pipeline de patrocinio (disciplina). IDENTICO no front (app.js EVT_ESTAGIOS).
      const EVT_ESTAGIOS = ["Alvo", "Contatado", "Reuniao", "Proposta", "Fechado", "Associado", "Perdido"];
      // status legado (prospect/negociacao/fechado/recusado) DERIVADO do estagio — mantem metricas coerentes.
      // Associado nao e receita de patrocinio -> 'recusado' (fora da soma de arrecadado).
      const ESTAGIO_TO_STATUS = { Alvo: "prospect", Contatado: "negociacao", Reuniao: "negociacao", Proposta: "negociacao", Fechado: "fechado", Associado: "recusado", Perdido: "recusado" };
      // F-EVT2: sub-entidades genéricas (whitelist de campos + enums por kind).
      const EVT_SUB = {
        programacao: { table: "evt_programacao", fields: ["evento_id", "ordem", "horario", "titulo", "tipo", "descricao", "painel_ref"], enums: { tipo: ["abertura", "painel", "coffee", "intervalo", "encerramento", "outro"] }, num: [], req: "titulo" },
        painelista: { table: "evt_painelistas", fields: ["evento_id", "painel", "nome", "person_id", "cargo", "empresa", "papel", "minibio", "foto_url", "status", "ordem"], enums: { papel: ["painelista", "moderador"], status: ["confirmado", "pendente", "recusado"] }, num: [], req: "nome" },
        patrocinador: { table: "evt_patrocinadores", fields: ["evento_id", "nome", "company_id", "cota", "valor", "beneficios", "status", "contato", "estagio", "porta", "proxima_acao", "data_acao"], enums: { status: ["prospect", "negociacao", "fechado", "recusado"], estagio: EVT_ESTAGIOS }, nullable: ["estagio"], num: ["valor"], req: "nome" },
        convidado: { table: "evt_convidados", fields: ["evento_id", "nome", "empresa", "email", "instituicao", "status", "segmento"], enums: { status: ["confirmado", "pendente", "recusado"], segmento: EVT_SEGMENTOS }, nullable: ["segmento"], num: [], req: "nome" }
      };

      if (type === "evt_list") {
        const eventos = [];
        for (let from = 0; ; from += 1000) { // pagina p/ nao truncar acima de 1000 eventos
          const { data, error } = await supabase.from("evt_eventos").select("id, nome, data_evento, local, status, created_at").order("data_evento", { ascending: false, nullsFirst: false }).range(from, from + 999);
          if (error) return res.status(500).json({ ok: false, error: error.message });
          eventos.push(...(data || []));
          if (!data || data.length < 1000) break;
        }
        // Agrega as sub-tabelas por evento_id (paginado, sem N+1) p/ o histórico/comparativo.
        const agg = {};
        const A = (eid) => (agg[eid] || (agg[eid] = { itens: 0, feito: 0, pain_t: 0, pain_c: 0, fechado_rs: 0, pipeline_rs: 0, fechados_n: 0, conv_t: 0, conv_c: 0 }));
        try {
          await evtScanAll("evt_checklist_itens", "evento_id, valores", (r) => { const a = A(r.evento_id); a.itens++; if ((r.valores || {}).status === "feito") a.feito++; });
          await evtScanAll("evt_painelistas", "evento_id, status", (r) => { const a = A(r.evento_id); a.pain_t++; if (r.status === "confirmado") a.pain_c++; });
          await evtScanAll("evt_patrocinadores", "evento_id, status, valor", (r) => { const a = A(r.evento_id); const v = Number(r.valor) || 0; a.pipeline_rs += v; if (r.status === "fechado") { a.fechado_rs += v; a.fechados_n++; } });
          await evtScanAll("evt_convidados", "evento_id, status", (r) => { const a = A(r.evento_id); a.conv_t++; if (r.status === "confirmado") a.conv_c++; });
        } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
        const items = (eventos || []).map((e) => {
          const a = agg[e.id] || {};
          return { ...e, itens: a.itens || 0, metricas: {
            checklist: { total: a.itens || 0, feito: a.feito || 0, pct: a.itens ? Math.round(((a.feito || 0) / a.itens) * 100) : 0 },
            painelistas: { total: a.pain_t || 0, confirmados: a.pain_c || 0 },
            patrocinio: { fechado_rs: a.fechado_rs || 0, pipeline_rs: a.pipeline_rs || 0, fechados_n: a.fechados_n || 0 },
            convidados: { total: a.conv_t || 0, confirmados: a.conv_c || 0 }
          } };
        });
        const totais = { n_eventos: items.length, por_status: {}, arrecadado_rs: 0, publico: 0, painelistas: 0 };
        for (const e of items) {
          totais.por_status[e.status] = (totais.por_status[e.status] || 0) + 1;
          totais.arrecadado_rs += e.metricas.patrocinio.fechado_rs;
          totais.publico += e.metricas.convidados.confirmados;
          totais.painelistas += e.metricas.painelistas.confirmados;
        }
        return res.status(200).json({ ok: true, items, totais });
      }

      if (type === "evt_get") {
        const id = String(req.query.id || "").trim();
        if (!id) return res.status(400).json({ ok: false, error: "Informe id" });
        const { data: evento, error: gErr } = await supabase.from("evt_eventos").select("*").eq("id", id).maybeSingle();
        if (gErr) return res.status(500).json({ ok: false, error: gErr.message });
        if (!evento) return res.status(404).json({ ok: false, error: "Evento nao encontrado." });
        const [itensR, progR, painR, patrR, convR] = await Promise.allSettled([
          supabase.from("evt_checklist_itens").select("id, valores, ordem").eq("evento_id", id).order("ordem", { ascending: true }).order("created_at", { ascending: true }),
          supabase.from("evt_programacao").select("*").eq("evento_id", id).order("ordem", { ascending: true }).order("created_at", { ascending: true }),
          supabase.from("evt_painelistas").select("*").eq("evento_id", id).order("ordem", { ascending: true }).order("created_at", { ascending: true }),
          supabase.from("evt_patrocinadores").select("*").eq("evento_id", id).order("created_at", { ascending: true }),
          supabase.from("evt_convidados").select("*").eq("evento_id", id).order("nome", { ascending: true })
        ]);
        const D = (r) => (r.status === "fulfilled" ? (r.value.data || []) : []);
        const itens = D(itensR), programacao = D(progR), painelistas = D(painR), patrocinadores = D(patrR), convidados = D(convR);
        return res.status(200).json({
          ok: true, evento, colunas: evento.checklist_colunas || [], itens, programacao, painelistas, patrocinadores, convidados,
          metricas: evtMetricas(itens, painelistas, patrocinadores, convidados, programacao)
        });
      }

      if (type === "evt_save") {
        const p = params(req);
        const nome = String(p.nome || "").trim();
        const patch = {
          ...(nome ? { nome: nome.slice(0, 300) } : {}),
          ...(p.data_evento !== undefined ? { data_evento: p.data_evento || null } : {}),
          ...(p.horario !== undefined ? { horario: p.horario ? String(p.horario).slice(0, 100) : null } : {}),
          ...(p.local !== undefined ? { local: p.local ? String(p.local).slice(0, 300) : null } : {}),
          ...(p.descricao !== undefined ? { descricao: p.descricao ? String(p.descricao).slice(0, 2000) : null } : {}),
          ...(p.status && EVT_STATUS.includes(p.status) ? { status: p.status } : {}),
          ...(Array.isArray(p.objetivos) ? { objetivos: p.objetivos.map((s) => String(s).slice(0, 400)).filter(Boolean).slice(0, 30) } : {}),
          updated_at: nowIso
        };
        if (p.id) {
          const { data, error } = await supabase.from("evt_eventos").update(patch).eq("id", String(p.id)).select().maybeSingle();
          if (error) return res.status(500).json({ ok: false, error: error.message });
          if (!data) return res.status(404).json({ ok: false, error: "Evento nao encontrado." });
          return res.status(200).json({ ok: true, evento: data });
        }
        if (!nome) return res.status(400).json({ ok: false, error: "Informe o nome do evento." });
        const { data: created, error } = await supabase.from("evt_eventos").insert({ ...patch, nome: nome.slice(0, 300), checklist_colunas: EVT_DEFAULT_COLS }).select().maybeSingle();
        if (error) return res.status(500).json({ ok: false, error: error.message });
        const seedRows = EVT_SEED.map(([item, categoria, obs, offset], i) => ({ evento_id: created.id, ordem: i, valores: { item, categoria, status: "pendente", ...(obs ? { obs } : {}), ...(offset != null ? { offset } : {}) } }));
        const seedRes = await supabase.from("evt_checklist_itens").insert(seedRows);
        if (seedRes.error) {
          await supabase.from("evt_eventos").delete().eq("id", created.id); // limpa o evento orfao
          return res.status(500).json({ ok: false, error: seedRes.error.message });
        }
        return res.status(200).json({ ok: true, evento: created });
      }

      if (type === "evt_delete") {
        const id = String(params(req).id || "").trim();
        if (!id) return res.status(400).json({ ok: false, error: "Informe id" });
        const { error } = await supabase.from("evt_eventos").delete().eq("id", id);
        if (error) return res.status(500).json({ ok: false, error: error.message });
        return res.status(200).json({ ok: true });
      }

      if (type === "evt_cols_save") {
        const p = params(req);
        const id = String(p.id || "").trim();
        if (!id) return res.status(400).json({ ok: false, error: "Informe id" });
        if (!Array.isArray(p.colunas)) return res.status(400).json({ ok: false, error: "colunas deve ser lista" });
        const seen = new Set(); const cols = [];
        for (const c of p.colunas.slice(0, 40)) {
          const key = String((c && c.key) || "").trim().slice(0, 40).replace(/[^a-zA-Z0-9_]/g, "");
          if (!key || seen.has(key)) continue;
          seen.add(key);
          const t = EVT_COL_TYPES.includes(c && c.type) ? c.type : "text";
          const col = { key, label: String((c && c.label) || key).slice(0, 80), type: t };
          if (t === "select" && Array.isArray(c && c.options)) col.options = c.options.slice(0, 40).map((o) => String(o).slice(0, 80));
          cols.push(col);
        }
        if (!cols.length) return res.status(400).json({ ok: false, error: "Nenhuma coluna valida." });
        const { data: upd, error } = await supabase.from("evt_eventos").update({ checklist_colunas: cols, updated_at: nowIso }).eq("id", id).select("id").maybeSingle();
        if (error) return res.status(500).json({ ok: false, error: error.message });
        if (!upd) return res.status(404).json({ ok: false, error: "Evento nao encontrado." });
        return res.status(200).json({ ok: true, colunas: cols });
      }

      if (type === "evt_item_add") {
        const p = params(req);
        const evento_id = String(p.evento_id || "").trim();
        if (!evento_id) return res.status(400).json({ ok: false, error: "Informe evento_id" });
        const { data: last } = await supabase.from("evt_checklist_itens").select("ordem").eq("evento_id", evento_id).order("ordem", { ascending: false }).limit(1).maybeSingle();
        const ordem = ((last && last.ordem) != null ? last.ordem : -1) + 1;
        const valores = (p.valores && typeof p.valores === "object" && !Array.isArray(p.valores)) ? p.valores : {};
        const { data, error } = await supabase.from("evt_checklist_itens").insert({ evento_id, ordem, valores }).select().maybeSingle();
        if (error) return res.status(500).json({ ok: false, error: error.message });
        return res.status(200).json({ ok: true, item: data });
      }

      if (type === "evt_item_update") {
        const p = params(req);
        const id = String(p.id || "").trim();
        if (!id || !p.valores || typeof p.valores !== "object" || Array.isArray(p.valores)) return res.status(400).json({ ok: false, error: "Informe id e valores (objeto)" });
        // Merge ATOMICO no Postgres (valores || patch) — sem lost-update entre edicoes
        // concorrentes de celulas diferentes da mesma linha.
        const { data, error } = await supabase.rpc("evt_item_patch", { p_id: id, p_patch: p.valores });
        if (error) return res.status(500).json({ ok: false, error: error.message });
        if (data == null) return res.status(404).json({ ok: false, error: "Item nao encontrado." });
        return res.status(200).json({ ok: true, valores: data });
      }

      if (type === "evt_item_remove") {
        const id = String(params(req).id || "").trim();
        if (!id) return res.status(400).json({ ok: false, error: "Informe id" });
        const { error } = await supabase.from("evt_checklist_itens").delete().eq("id", id);
        if (error) return res.status(500).json({ ok: false, error: error.message });
        return res.status(200).json({ ok: true });
      }

      // F-EVT2: upsert generico de sub-entidade (programacao/painelista/patrocinador/convidado).
      if (type === "evt_sub_save") {
        const p = params(req);
        const spec = EVT_SUB[p.kind];
        if (!spec) return res.status(400).json({ ok: false, error: "kind invalido" });
        const row = {};
        for (const f of spec.fields) {
          if (p[f] === undefined) continue;
          let v = p[f];
          if (typeof v === "string") v = v.trim();
          if (v === "") v = null;
          if (spec.enums[f]) {
            // enum invalido -> mantem. Vazio(null): campo OPCIONAL (ex.: segmento) limpa p/ null;
            // campo com default NOT NULL (status/papel) mantem o valor atual.
            if (v == null) { if (!(spec.nullable || []).includes(f)) continue; }
            else if (!spec.enums[f].includes(v)) continue;
          }
          else if (spec.num.includes(f)) { v = (v == null) ? null : (Number.isFinite(Number(v)) ? Number(v) : null); }
          else if (f === "ordem") { v = (v == null) ? 0 : (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0); }
          else if (typeof v === "string") v = v.slice(0, 4000);
          row[f] = v;
        }
        // F-EVT7: estagio e a fonte de verdade do pipeline; deriva o status legado (metricas/somas) p/ nao divergir.
        if (spec.table === "evt_patrocinadores" && row.estagio) {
          row.status = ESTAGIO_TO_STATUS[row.estagio] || row.status;
        }
        if (p.id) {
          delete row.evento_id; // nao muda o pai no update
          row.updated_at = nowIso;
          const { data, error } = await supabase.from(spec.table).update(row).eq("id", String(p.id)).select().maybeSingle();
          if (error) return res.status(500).json({ ok: false, error: error.message });
          if (!data) return res.status(404).json({ ok: false, error: "Registro nao encontrado." });
          return res.status(200).json({ ok: true, row: data });
        }
        if (!row.evento_id || !row[spec.req]) return res.status(400).json({ ok: false, error: `Informe evento_id e ${spec.req}` });
        const { data, error } = await supabase.from(spec.table).insert(row).select().maybeSingle();
        if (error) return res.status(500).json({ ok: false, error: error.message });
        return res.status(200).json({ ok: true, row: data });
      }

      if (type === "evt_sub_remove") {
        const p = params(req);
        const spec = EVT_SUB[p.kind];
        if (!spec) return res.status(400).json({ ok: false, error: "kind invalido" });
        const id = String(p.id || "").trim();
        if (!id) return res.status(400).json({ ok: false, error: "Informe id" });
        const { error } = await supabase.from(spec.table).delete().eq("id", id);
        if (error) return res.status(500).json({ ok: false, error: error.message });
        return res.status(200).json({ ok: true });
      }

      // F-EVT2: import de convidados a partir de lista colada ("Nome – Empresa ✅").
      if (type === "evt_convidado_import") {
        const p = params(req);
        const evento_id = String(p.evento_id || "").trim();
        if (!evento_id) return res.status(400).json({ ok: false, error: "Informe evento_id" });
        const rows = [], seen = new Set();
        for (const raw of String(p.texto || "").split(/\r?\n/).slice(0, 500)) {
          const line = raw.replace(/[✅✔☑⏱❌✖️]/g, "").trim();
          if (!line) continue;
          const parts = line.split(/\s+[–—-]\s+/);
          const nome = (parts[0] || "").trim().slice(0, 200);
          if (!nome) continue;
          const k = nome.toLowerCase();
          if (seen.has(k)) continue; seen.add(k);
          const status = /[❌✖]/.test(raw) ? "recusado" : (/[✅✔☑]/.test(raw) ? "confirmado" : "pendente");
          rows.push({ evento_id, nome, empresa: (parts[1] || "").trim().slice(0, 200) || null, status });
        }
        if (!rows.length) return res.status(400).json({ ok: false, error: "Nenhum nome reconhecido (use uma linha por convidado)." });
        const have = new Set();
        for (let from = 0; ; from += 1000) { // pagina p/ dedup correto acima de 1000 convidados
          const { data: ex, error: exErr } = await supabase.from("evt_convidados").select("nome").eq("evento_id", evento_id).range(from, from + 999);
          if (exErr) return res.status(500).json({ ok: false, error: exErr.message });
          for (const e of ex || []) have.add(String(e.nome).toLowerCase());
          if (!ex || ex.length < 1000) break;
        }
        const fresh = rows.filter((r) => !have.has(r.nome.toLowerCase()));
        if (fresh.length) {
          const { error } = await supabase.from("evt_convidados").insert(fresh);
          if (error) return res.status(500).json({ ok: false, error: error.message });
        }
        return res.status(200).json({ ok: true, inserted: fresh.length, pulados: rows.length - fresh.length });
      }

      // F-EVT3: cotas-catálogo do evento (metadata.cotas; merge sem perder outras chaves).
      if (type === "evt_cotas_save") {
        const p = params(req);
        const id = String(p.id || "").trim();
        if (!id) return res.status(400).json({ ok: false, error: "Informe id" });
        if (!Array.isArray(p.cotas)) return res.status(400).json({ ok: false, error: "cotas deve ser lista" });
        const cotas = p.cotas.slice(0, 20).map((c) => ({
          nome: String((c && c.nome) || "").trim().slice(0, 120),
          valor: (c && c.valor != null && Number.isFinite(Number(c.valor))) ? Number(c.valor) : null,
          beneficios: String((c && c.beneficios) || "").slice(0, 2000)
        })).filter((c) => c.nome);
        const { data: cur, error: gErr } = await supabase.from("evt_eventos").select("metadata").eq("id", id).maybeSingle();
        if (gErr) return res.status(500).json({ ok: false, error: gErr.message });
        if (!cur) return res.status(404).json({ ok: false, error: "Evento nao encontrado." });
        const metadata = { ...(cur.metadata || {}), cotas };
        const { error } = await supabase.from("evt_eventos").update({ metadata, updated_at: nowIso }).eq("id", id);
        if (error) return res.status(500).json({ ok: false, error: error.message });
        return res.status(200).json({ ok: true, cotas });
      }

      // F-EVT7 (D): info do evento em metadata (donos por area, metas, RSVP, Drive). Merge sem perder chaves.
      if (type === "evt_meta_save") {
        const p = params(req);
        const id = String(p.id || "").trim();
        if (!id) return res.status(400).json({ ok: false, error: "Informe id" });
        const meta = (p.meta && typeof p.meta === "object" && !Array.isArray(p.meta)) ? p.meta : {};
        const s = (x, n) => String(x == null ? "" : x).slice(0, n);
        const clean = {};
        if (meta.owners && typeof meta.owners === "object") clean.owners = { logistica: s(meta.owners.logistica, 120), marketing: s(meta.owners.marketing, 120), conteudo: s(meta.owners.conteudo, 120), imprensa: s(meta.owners.imprensa, 120) };
        if (meta.metas && typeof meta.metas === "object") clean.metas = { patrocinio: s(meta.metas.patrocinio, 40), publico: s(meta.metas.publico, 40) };
        if (meta.rsvp != null) clean.rsvp = s(meta.rsvp, 400);
        if (meta.drive != null) clean.drive = s(meta.drive, 400);
        const { data: cur, error: gErr } = await supabase.from("evt_eventos").select("metadata").eq("id", id).maybeSingle();
        if (gErr) return res.status(500).json({ ok: false, error: gErr.message });
        if (!cur) return res.status(404).json({ ok: false, error: "Evento nao encontrado." });
        const metadata = { ...(cur.metadata || {}), ...clean };
        const { error } = await supabase.from("evt_eventos").update({ metadata, updated_at: nowIso }).eq("id", id);
        if (error) return res.status(500).json({ ok: false, error: error.message });
        return res.status(200).json({ ok: true, metadata });
      }

      // ===== M27: "Score de Patrocinador" (F-EVT4) — prospeccao de patrocinio =====
      const nowMs = Date.now();
      const addDays = (d) => new Date(nowMs + d * 86400000).toISOString();
      const addMonths = (m) => { const dt = new Date(nowMs); dt.setUTCMonth(dt.getUTCMonth() + m); return dt.toISOString(); };
      const BAD_STATUS = /baix|suspens|inapt|nula|inativ|cancel/i;   // situacao cadastral que bloqueia (sinal local)
      // Supressao ATIVA por CNPJ (until null = permanente; futuro = ainda vale).
      const activeSuppression = async () => {
        const set = new Set();
        for (let from = 0; ; from += 1000) {
          const { data, error } = await supabase.from("evt_sponsor_supressao").select("cnpj_norm, until").range(from, from + 999);
          if (error) throw new Error(error.message);
          for (const r of data || []) { if (r.cnpj_norm && (r.until == null || r.until > nowIso)) set.add(r.cnpj_norm); }
          if (!data || data.length < 1000) break;
        }
        return set;
      };

      if (type === "evt_sponsor_run") {
        const p = params(req);
        const evento_id = String(p.evento_id || "").trim();
        const orgaos = Array.isArray(p.orgaos) ? p.orgaos.map((x) => String(x).trim()).filter(Boolean).slice(0, 50) : [];
        const setor = p.setor ? String(p.setor).slice(0, 120) : null;
        if (!evento_id) return res.status(400).json({ ok: false, error: "Informe evento_id" });
        if (!orgaos.length) return res.status(400).json({ ok: false, error: "Selecione ao menos um orgao-alvo." });
        const { data: ev, error: evErr } = await supabase.from("evt_eventos").select("id, data_evento, metadata").eq("id", evento_id).maybeSingle();
        if (evErr) return res.status(500).json({ ok: false, error: evErr.message });
        if (!ev) return res.status(404).json({ ok: false, error: "Evento nao encontrado." });
        const { data: rub } = await supabase.from("evt_sponsor_rubrics").select("*").eq("active", true).maybeSingle();
        const cotas = (ev.metadata && ev.metadata.cotas) || [];
        const rescore_of = p.rescore_of ? String(p.rescore_of) : null;

        const { data: run, error: runErr } = await supabase.from("evt_sponsor_runs").insert({
          evento_id, status: "running", orgaos, setor, rubric_version: (rub && rub.version) || null, rescore_of
        }).select().maybeSingle();
        if (runErr) return res.status(500).json({ ok: false, error: runErr.message });

        let result;
        try {
          const suppressed = await activeSuppression();
          result = await runScore(supabase, {
            orgaos, setor, cotas, dataEvento: ev.data_evento,
            weights: rub && rub.weights, tiers: rub && rub.tiers, cotaBands: rub && rub.cota_bands,
            sectorCnae: (rub && rub.sector_cnae && setor && rub.sector_cnae[setor]) || [],
            suppressed
          });
        } catch (e) { result = { ok: false, error: e.message }; }
        if (!result.ok) {
          await supabase.from("evt_sponsor_runs").update({ status: "failed", note: String(result.error).slice(0, 500), finished_at: nowIso }).eq("id", run.id);
          return res.status(500).json({ ok: false, error: result.error, run_id: run.id });
        }

        const rows = result.scored.map((s) => {
          const bloqueado = BAD_STATUS.test(String(s.evidence.situacao || ""));
          return {
            evento_id, run_id: run.id, company_id: s.company_id, cnpj: s.cnpj, empresa_key: s.empresa_key, nome: String(s.nome).slice(0, 300),
            total: s.total, tier: s.tier, subscores: s.subscores, evidence: s.evidence, as_of: result.as_of, capped: s.capped,
            cota_sugerida: s.cota_sugerida, timing: s.timing, rubric_version: (rub && rub.version) || null,
            bloqueado, screening: bloqueado ? { verified: false, local_block: true, reason: s.evidence.situacao } : { verified: false }
          };
        });
        if (rows.length) {
          const { error: insErr } = await supabase.from("evt_sponsor_scores").insert(rows);
          if (insErr) {
            await supabase.from("evt_sponsor_runs").update({ status: "failed", note: insErr.message.slice(0, 500), finished_at: nowIso }).eq("id", run.id);
            return res.status(500).json({ ok: false, error: insErr.message, run_id: run.id });
          }
        }
        const note = [result.truncado ? `scan truncado em ${CONTRACT_SCAN_CAP}` : null, result.remainder ? `${result.remainder} empresas alem do teto de enriquecimento` : null].filter(Boolean).join("; ") || null;
        const { data: doneRun, error: doneErr } = await supabase.from("evt_sponsor_runs").update({
          status: "done", n_candidates: result.n_candidates, n_scored: rows.length, truncado: result.truncado, finished_at: nowIso, note
        }).eq("id", run.id).select().maybeSingle();
        // Sem isso, um erro aqui deixaria o run preso em 'running' e o shortlist (ja gravado) invisivel, com ok:true enganoso.
        if (doneErr) return res.status(500).json({ ok: false, error: `falha ao concluir run: ${doneErr.message}`, run_id: run.id });
        const bloq = rows.filter((r) => r.bloqueado).length;
        return res.status(200).json({ ok: true, run: doneRun || run, n_scored: rows.length, bloqueados: bloq, remainder: result.remainder, truncado: result.truncado });
      }

      if (type === "evt_sponsor_list") {
        const evento_id = String(params(req).evento_id || "").trim();
        if (!evento_id) return res.status(400).json({ ok: false, error: "Informe evento_id" });
        // Selector de orgaos (agencias com sigla). Sempre retornado.
        const { data: ags } = await supabase.from("agencies").select("id, acronym, name").not("acronym", "is", null).order("acronym").limit(500);
        const { data: run } = await supabase.from("evt_sponsor_runs").select("*").eq("evento_id", evento_id).order("started_at", { ascending: false }).limit(1).maybeSingle();
        if (!run) return res.status(200).json({ ok: true, run: null, items: [], bloqueados: [], agencies: ags || [] });
        if (run.status === "running") return res.status(200).json({ ok: true, run, items: [], bloqueados: [], agencies: ags || [] });
        const { data: scores, error: sErr } = await supabase.from("evt_sponsor_scores").select("*").eq("run_id", run.id).order("total", { ascending: false });
        if (sErr) return res.status(500).json({ ok: false, error: sErr.message });
        const items = (scores || []).filter((s) => !s.bloqueado);
        const bloqueados = (scores || []).filter((s) => s.bloqueado);
        // F-EVT6: contatos conhecidos (por empresa) das empresas do shortlist — 1 query.
        const cids = [...new Set(items.map((s) => s.company_id).filter(Boolean))];
        const contatos = {};
        if (cids.length) {
          const { data: cts } = await supabase.from("evt_sponsor_contatos").select("id, company_id, nome, cargo, link, obs").in("company_id", cids).order("updated_at", { ascending: false });
          for (const c of cts || []) (contatos[c.company_id] = contatos[c.company_id] || []).push(c);
        }
        return res.status(200).json({ ok: true, run, items, bloqueados, agencies: ags || [], contatos });
      }

      // F-EVT6: contato do DECISOR por EMPRESA (reutilizavel entre eventos). LGPD: so
      // profissional (nome/cargo/link/obs) — sem e-mail/telefone/CPF.
      if (type === "evt_sponsor_contato_save") {
        const p = params(req);
        const nome = String(p.nome || "").trim();
        if (!nome) return res.status(400).json({ ok: false, error: "Informe o nome do contato" });
        const company_id = p.company_id ? String(p.company_id) : null;
        const cnpj = p.cnpj ? onlyDigits(p.cnpj) : null;
        if (!company_id && !(cnpj && cnpj.length === 14)) return res.status(400).json({ ok: false, error: "Informe a empresa (company_id ou CNPJ)" });
        const row = {
          company_id, cnpj: cnpj && cnpj.length === 14 ? cnpj : null,
          nome: nome.slice(0, 200), cargo: p.cargo ? String(p.cargo).slice(0, 200) : null,
          link: p.link ? String(p.link).slice(0, 400) : null, obs: p.obs ? String(p.obs).slice(0, 500) : null
        };
        if (p.id) {
          row.updated_at = nowIso;
          const { data, error } = await supabase.from("evt_sponsor_contatos").update(row).eq("id", String(p.id)).select().maybeSingle();
          if (error) return res.status(500).json({ ok: false, error: error.message });
          return res.status(200).json({ ok: true, contato: data });
        }
        const { data, error } = await supabase.from("evt_sponsor_contatos").insert(row).select().maybeSingle();
        if (error) return res.status(500).json({ ok: false, error: error.message });
        return res.status(200).json({ ok: true, contato: data });
      }
      if (type === "evt_sponsor_contato_remove") {
        const id = String(params(req).id || "").trim();
        if (!id) return res.status(400).json({ ok: false, error: "Informe id" });
        const { error } = await supabase.from("evt_sponsor_contatos").delete().eq("id", id);
        if (error) return res.status(500).json({ ok: false, error: error.message });
        return res.status(200).json({ ok: true });
      }

      if (type === "evt_sponsor_promote") {
        const p = params(req);
        const id = String(p.id || "").trim();
        const tier = Number(p.tier);
        if (!id || !Number.isFinite(tier)) return res.status(400).json({ ok: false, error: "Informe id e tier" });
        const patch = {
          promovido: true, promovido_tier: Math.trunc(tier),
          promovido_por: p.promovido_por ? String(p.promovido_por).slice(0, 200) : null,
          promovido_justificativa: p.justificativa ? String(p.justificativa).slice(0, 1000) : null
        };
        const { data, error } = await supabase.from("evt_sponsor_scores").update(patch).eq("id", id).select().maybeSingle();
        if (error) return res.status(500).json({ ok: false, error: error.message });
        if (!data) return res.status(404).json({ ok: false, error: "Score nao encontrado." });
        return res.status(200).json({ ok: true, score: data });
      }

      if (type === "evt_sponsor_angle") {
        const id = String(params(req).id || "").trim();
        if (!id) return res.status(400).json({ ok: false, error: "Informe id" });
        const { data: s, error } = await supabase.from("evt_sponsor_scores").select("*").eq("id", id).maybeSingle();
        if (error) return res.status(500).json({ ok: false, error: error.message });
        if (!s) return res.status(404).json({ ok: false, error: "Score nao encontrado." });
        const { data: run } = await supabase.from("evt_sponsor_runs").select("setor").eq("id", s.run_id).maybeSingle();
        const setor = (run && run.setor) || null;
        const { data: notes } = await supabase.from("evt_ref_notes").select("id, kind, segment, content").in("kind", ["won_language", "objecao"]).limit(40);
        const refUsadas = (notes || []).filter((n) => !n.segment || !setor || String(n.segment).toLowerCase() === String(setor).toLowerCase());
        const { data: ev } = await supabase.from("evt_eventos").select("nome, data_evento, descricao").eq("id", s.evento_id).maybeSingle();
        const payload = {
          evento: ev ? { nome: ev.nome, data: ev.data_evento, descricao: ev.descricao } : null,
          empresa: { nome: s.nome, tier: s.tier, total: s.total, cota_sugerida: s.cota_sugerida },
          evidencia: s.evidence,
          ref_notes: refUsadas.map((n) => ({ kind: n.kind, content: n.content }))
        };
        const out = await sponsorAngle(payload);
        if (!out.angulo && out.skipped === "no_api_key") return res.status(200).json({ ok: true, skipped: "no_api_key", angulo: null });
        // IA falhou (rate-limit/HTTP/JSON) -> NAO sobrescreve um angulo valido anterior com null.
        if (!out.angulo) return res.status(200).json({ ok: false, angulo: null, error: out.error || "sem resposta da IA" });
        const angulo_fontes = { ref_notes: refUsadas.map((n) => n.id), evidencia_keys: Object.keys(s.evidence || {}), confidence: out.confidence };
        const { data: upd, error: updErr } = await supabase.from("evt_sponsor_scores").update({ angulo: out.angulo, angulo_fontes }).eq("id", id).select().maybeSingle();
        if (updErr) return res.status(500).json({ ok: false, error: updErr.message });
        return res.status(200).json({ ok: true, angulo: out.angulo, confidence: out.confidence, score: upd });
      }

      if (type === "evt_sponsor_decide") {
        const p = params(req);
        const id = String(p.id || "").trim();
        const decisao = String(p.decisao || "").trim();
        if (!id || !["aprovar", "descartar"].includes(decisao)) return res.status(400).json({ ok: false, error: "Informe id e decisao (aprovar|descartar)" });
        const { data: s, error } = await supabase.from("evt_sponsor_scores").select("*").eq("id", id).maybeSingle();
        if (error) return res.status(500).json({ ok: false, error: error.message });
        if (!s) return res.status(404).json({ ok: false, error: "Score nao encontrado." });
        if (decisao === "descartar") {
          await supabase.from("evt_sponsor_scores").update({ status: "descartado" }).eq("id", id);
          return res.status(200).json({ ok: true, status: "descartado" });
        }
        // aprovar: REVERIFICA screening AGORA (a situacao muda entre a pontuacao e a aprovacao).
        let warn = null, screening = { verified: false, checked_at: nowIso };
        if (s.cnpj && onlyDigits(s.cnpj).length === 14) {
          const sc = await screeningByCnpj(onlyDigits(s.cnpj)).catch(() => null);
          // screeningByCnpj retorna ok:true mesmo SEM chave (fontes falham -> has_sanctions=false).
          // So confia se ALGUMA fonte respondeu de fato; senao e "nao verificado" (nao passar como ok).
          const anyOk = !!(sc && sc.sources && Object.values(sc.sources).some((x) => x && x.ok));
          if (anyOk) {
            screening = { verified: true, has_sanctions: !!(sc.flags && sc.flags.has_sanctions), checked_at: nowIso };
            if (screening.has_sanctions) {
              await supabase.from("evt_sponsor_scores").update({ bloqueado: true, screening }).eq("id", id);
              return res.status(200).json({ ok: false, blocked: true, error: "Empresa com sancao ativa (CEIS/CNEP) — bloqueada.", screening });
            }
          } else {
            warn = "Screening externo indisponivel (sem chave do Portal da Transparencia ou fonte fora do ar) — verifique manualmente antes de confirmar.";
          }
        } else { warn = "Empresa sem CNPJ valido — screening externo nao aplicavel."; }

        const cota = (p.cota != null && String(p.cota).trim()) ? String(p.cota).slice(0, 120) : (s.cota_sugerida || null);
        const valor = (p.valor != null && Number.isFinite(Number(p.valor))) ? Number(p.valor) : null;
        // F-EVT6: herda o ULTIMO contato conhecido da empresa (nome — cargo) se nao vier no request.
        let contato = p.contato ? String(p.contato).slice(0, 300) : null;
        if (!contato && s.company_id) {
          const { data: ct } = await supabase.from("evt_sponsor_contatos").select("nome, cargo").eq("company_id", s.company_id).order("updated_at", { ascending: false }).limit(1).maybeSingle();
          if (ct && ct.nome) contato = (ct.nome + (ct.cargo ? ` — ${ct.cargo}` : "")).slice(0, 300);
        }
        const { data: patr, error: pErr } = await supabase.from("evt_patrocinadores").insert({
          evento_id: s.evento_id, nome: s.nome, company_id: s.company_id, cota, valor,
          status: "negociacao", estagio: "Contatado", sponsor_score_id: s.id, contato  // F-EVT7: entra no pipeline como Contatado
        }).select().maybeSingle();
        if (pErr) return res.status(500).json({ ok: false, error: pErr.message });
        await supabase.from("evt_sponsor_scores").update({ status: "aprovado", screening }).eq("id", id);
        // Supressao curta 'em_abordagem' (protege a conta ENTRE aprovacao e resposta).
        if (s.cnpj) await supabase.from("evt_sponsor_supressao").insert({ cnpj: s.cnpj, company_id: s.company_id, evento_id: s.evento_id, status: "em_abordagem", desfecho: null, until: addDays(30) });
        return res.status(200).json({ ok: true, patrocinador: patr, warn, screening });
      }

      if (type === "evt_outcome_save") {
        const p = params(req);
        const patrocinador_id = String(p.patrocinador_id || "").trim();
        const desfecho = String(p.desfecho || "").trim();   // andamento|respondeu|fechou|recusou|optout
        if (!patrocinador_id) return res.status(400).json({ ok: false, error: "Informe patrocinador_id" });
        const { data: patr, error: gErr } = await supabase.from("evt_patrocinadores").select("id, evento_id, sponsor_score_id").eq("id", patrocinador_id).maybeSingle();
        if (gErr) return res.status(500).json({ ok: false, error: gErr.message });
        if (!patr) return res.status(404).json({ ok: false, error: "Patrocinador nao encontrado." });
        const patch = { updated_at: nowIso };
        if (p.respondeu != null) patch.respondeu = !!p.respondeu;
        if (p.motivo != null) patch.motivo = String(p.motivo).slice(0, 1000);
        if (p.valor != null && Number.isFinite(Number(p.valor))) patch.valor = Number(p.valor);
        if (desfecho === "fechou") { patch.status = "fechado"; patch.estagio = "Fechado"; patch.respondeu = true; }  // F-EVT7: estagio junto do status
        else if (desfecho === "recusou") { patch.status = "recusado"; patch.estagio = "Perdido"; patch.respondeu = true; }
        else if (desfecho === "respondeu") { patch.respondeu = true; }
        const { error: uErr } = await supabase.from("evt_patrocinadores").update(patch).eq("id", patrocinador_id);
        if (uErr) return res.status(500).json({ ok: false, error: uErr.message });
        // Atualiza supressao pelo desfecho (via CNPJ do score ligado). Casa por cnpj_norm
        // em QUALQUER status (nao so 'em_abordagem') — senao um 2o desfecho (ex.: optout
        // depois de recusou) seria descartado e o opt-out permanente nunca gravaria.
        if (patr.sponsor_score_id && ["fechou", "recusou", "optout"].includes(desfecho)) {
          const { data: sc } = await supabase.from("evt_sponsor_scores").select("cnpj, cnpj_norm, company_id").eq("id", patr.sponsor_score_id).maybeSingle();
          const cnpjNorm = sc && sc.cnpj_norm;
          if (cnpjNorm) {
            if (desfecho === "fechou") {
              // fechou = melhor prospect do proximo -> remove QUALQUER supressao daquele CNPJ.
              await supabase.from("evt_sponsor_supressao").delete().eq("cnpj_norm", cnpjNorm);
            } else {
              const until = desfecho === "optout" ? null : addMonths(12);  // optout = permanente
              const { data: upd } = await supabase.from("evt_sponsor_supressao").update({ status: "suprimido", desfecho, until }).eq("cnpj_norm", cnpjNorm).select("id");
              // Sem linha (supressao ja removida por um 'fechou' anterior, p.ex.): insere.
              if (!upd || !upd.length) await supabase.from("evt_sponsor_supressao").insert({ cnpj: sc.cnpj || null, company_id: sc.company_id || null, evento_id: patr.evento_id, status: "suprimido", desfecho, until });
            }
          }
        }
        return res.status(200).json({ ok: true });
      }

      if (type === "evt_ref_note_list") {
        const { data, error } = await supabase.from("evt_ref_notes").select("*").order("created_at", { ascending: false }).limit(500);
        if (error) return res.status(500).json({ ok: false, error: error.message });
        return res.status(200).json({ ok: true, items: data || [] });
      }
      if (type === "evt_ref_note_save") {
        const p = params(req);
        const kind = String(p.kind || "").trim();
        if (!["won_language", "loss_reason", "objecao", "banido"].includes(kind)) return res.status(400).json({ ok: false, error: "kind invalido" });
        const content = String(p.content || "").trim();
        if (!content) return res.status(400).json({ ok: false, error: "Informe content" });
        const row = { kind, content: content.slice(0, 4000), segment: p.segment ? String(p.segment).slice(0, 120) : null, source: p.source ? String(p.source).slice(0, 300) : null };
        if (p.id) {
          const { data, error } = await supabase.from("evt_ref_notes").update(row).eq("id", String(p.id)).select().maybeSingle();
          if (error) return res.status(500).json({ ok: false, error: error.message });
          return res.status(200).json({ ok: true, item: data });
        }
        const { data, error } = await supabase.from("evt_ref_notes").insert(row).select().maybeSingle();
        if (error) return res.status(500).json({ ok: false, error: error.message });
        return res.status(200).json({ ok: true, item: data });
      }
      if (type === "evt_ref_note_remove") {
        const id = String(params(req).id || "").trim();
        if (!id) return res.status(400).json({ ok: false, error: "Informe id" });
        const { error } = await supabase.from("evt_ref_notes").delete().eq("id", id);
        if (error) return res.status(500).json({ ok: false, error: error.message });
        return res.status(200).json({ ok: true });
      }

      if (type === "evt_golden_list") {
        const { data, error } = await supabase.from("evt_sponsor_golden").select("*").order("created_at", { ascending: false }).limit(500);
        if (error) return res.status(500).json({ ok: false, error: error.message });
        return res.status(200).json({ ok: true, items: data || [] });
      }
      if (type === "evt_golden_save") {
        const p = params(req);
        const nome = String(p.nome || "").trim();
        const tier_humano = Number(p.tier_humano);
        if (!nome || !Number.isFinite(tier_humano)) return res.status(400).json({ ok: false, error: "Informe nome e tier_humano" });
        // LGPD: so persiste CNPJ (14 digitos). Um CPF colado no campo vira null (nunca persiste CPF).
        const cnpjDig = p.cnpj ? onlyDigits(p.cnpj) : "";
        const row = { nome: nome.slice(0, 300), tier_humano: Math.trunc(tier_humano), cnpj: cnpjDig.length === 14 ? cnpjDig : null, nota: p.nota ? String(p.nota).slice(0, 1000) : null };
        if (p.id) {
          const { data, error } = await supabase.from("evt_sponsor_golden").update(row).eq("id", String(p.id)).select().maybeSingle();
          if (error) return res.status(500).json({ ok: false, error: error.message });
          return res.status(200).json({ ok: true, item: data });
        }
        const { data, error } = await supabase.from("evt_sponsor_golden").insert(row).select().maybeSingle();
        if (error) return res.status(500).json({ ok: false, error: error.message });
        return res.status(200).json({ ok: true, item: data });
      }
      if (type === "evt_golden_remove") {
        const id = String(params(req).id || "").trim();
        if (!id) return res.status(400).json({ ok: false, error: "Informe id" });
        const { error } = await supabase.from("evt_sponsor_golden").delete().eq("id", id);
        if (error) return res.status(500).json({ ok: false, error: error.message });
        return res.status(200).json({ ok: true });
      }

      // Validacao: INDICADOR ANTECEDENTE (taxa de RESPOSTA por tier + valor fechado por
      // tier) + concordancia do DETERMINISTICO vs golden. Devolve o `n` (front suprime n<5).
      if (type === "evt_sponsor_validate") {
        const p = params(req);
        // Junta patrocinadores <- score (tier deterministico). Pagina.
        const scoreTier = new Map(); // score_id -> tier (deterministico)
        await evtScanAll("evt_sponsor_scores", "id, tier", (r) => scoreTier.set(r.id, r.tier));
        const porTier = {}; // tier -> { abordados, respondeu, fechados, valor_fechado }
        const T = (t) => (porTier[t] || (porTier[t] = { tier: t, abordados: 0, respondeu: 0, fechados: 0, valor_fechado: 0 }));
        await evtScanAll("evt_patrocinadores", "sponsor_score_id, respondeu, status, valor", (r) => {
          if (!r.sponsor_score_id) return;
          const tier = scoreTier.get(r.sponsor_score_id);
          if (tier == null) return;
          const b = T(tier);
          b.abordados++;
          if (r.respondeu) b.respondeu++;
          if (r.status === "fechado") { b.fechados++; b.valor_fechado += Number(r.valor) || 0; }
        });
        const tiers = Object.values(porTier).map((b) => ({ ...b, taxa_resposta: b.abordados ? b.respondeu / b.abordados : null })).sort((a, z) => a.tier - z.tier);

        // Concordancia deterministico vs golden (exato). Usa o score mais recente por CNPJ.
        const goldenRes = await supabase.from("evt_sponsor_golden").select("cnpj_norm, tier_humano");
        const golden = (goldenRes.data || []).filter((g) => g.cnpj_norm);
        let concordancia = null, nGolden = 0;
        if (golden.length) {
          const latestTier = new Map(); // cnpj_norm -> tier (do score mais recente)
          const seen = new Set();
          // scores ja ordenados por created_at desc p/ pegar o mais recente por cnpj
          const { data: srows } = await supabase.from("evt_sponsor_scores").select("cnpj_norm, tier, created_at").order("created_at", { ascending: false }).limit(5000);
          for (const r of srows || []) { if (r.cnpj_norm && !seen.has(r.cnpj_norm)) { seen.add(r.cnpj_norm); latestTier.set(r.cnpj_norm, r.tier); } }
          let hit = 0, n = 0;
          for (const g of golden) { const t = latestTier.get(g.cnpj_norm); if (t == null) continue; n++; if (t === g.tier_humano) hit++; }
          nGolden = n; concordancia = n ? hit / n : null;
        }
        // F-EVT6: "golden no top-N" do run corrente do evento (o teste real da rubrica).
        const TOP_N = 20;
        let topHits = null;
        const eventoId = p.evento_id ? String(p.evento_id) : null;
        if (golden.length && eventoId) {
          const { data: crun } = await supabase.from("evt_sponsor_runs").select("id").eq("evento_id", eventoId).eq("status", "done").order("started_at", { ascending: false }).limit(1).maybeSingle();
          if (crun) {
            // Casa com o shortlist VISIVEL (evt_sponsor_list exclui bloqueados por screening).
            const { data: top } = await supabase.from("evt_sponsor_scores").select("cnpj_norm").eq("run_id", crun.id).eq("bloqueado", false).order("total", { ascending: false }).limit(TOP_N);
            const topset = new Set((top || []).map((r) => r.cnpj_norm).filter(Boolean));
            topHits = golden.filter((g) => topset.has(g.cnpj_norm)).length;
          }
        }
        // Grava calibracao apenas quando pedido (evita spam) — artefato comparavel entre versoes.
        if (req.method === "POST" && p.save && (concordancia != null || topHits != null)) {
          const { data: rub } = await supabase.from("evt_sponsor_rubrics").select("version").eq("active", true).maybeSingle();
          const { error: calErr } = await supabase.from("evt_sponsor_calibracoes").insert({ rubric_version: (rub && rub.version) || null, evento_id: eventoId, concordancia, n: nGolden, top_hits: topHits, top_n: TOP_N, golden_n: golden.length });
          if (calErr) return res.status(500).json({ ok: false, error: `falha ao salvar calibracao: ${calErr.message}` });
        }
        const { data: historico } = await supabase.from("evt_sponsor_calibracoes").select("rubric_version, concordancia, n, top_hits, top_n, golden_n, created_at").order("created_at", { ascending: false }).limit(20);
        return res.status(200).json({ ok: true, tiers, golden: { concordancia, n: nGolden, top_hits: topHits, top_n: TOP_N, golden_total: golden.length }, historico: historico || [] });
      }

      // ===== F-EVT7: Base de contatos CROSS-EVENTO (funil de associados) =====
      const EVT_REL = ["Contato", "Prospect patrocinio", "Prospect associado", "Patrocinador", "Associado", "Institucional"];
      const contatoKey = (nome, empresa) => `${String(nome || "").trim().toLowerCase()}|${String(empresa || "").trim().toLowerCase()}`;
      const loadContatoKeys = async () => {
        const set = new Set();
        for (let from = 0; ; from += 1000) {
          const { data, error } = await supabase.from("evt_contatos").select("nome, empresa").range(from, from + 999);
          if (error) throw new Error(error.message);
          for (const c of data || []) set.add(contatoKey(c.nome, c.empresa));
          if (!data || data.length < 1000) break;
        }
        return set;
      };

      if (type === "evt_contato_list") {
        const p = params(req);
        const q = String(p.q || "").trim().toLowerCase();
        const rel = p.rel && EVT_REL.includes(p.rel) ? p.rel : null;
        let query = supabase.from("evt_contatos").select("*").order("updated_at", { ascending: false }).limit(2000);
        if (rel) query = query.eq("rel", rel);
        const { data, error } = await query;
        if (error) return res.status(500).json({ ok: false, error: error.message });
        let items = data || [];
        if (q) items = items.filter((c) => (c.nome || "").toLowerCase().includes(q) || (c.empresa || "").toLowerCase().includes(q));
        return res.status(200).json({ ok: true, items, total: (data || []).length });
      }
      if (type === "evt_contato_save") {
        const p = params(req);
        // PATCH parcial: só grava os campos ENVIADOS (a Base edita 1 campo por vez). Nao reconstruir a linha.
        const LIM = { nome: 200, empresa: 200, cargo: 200, setor: 120, email: 200, telefone: 60, cota_assoc: 40, obs: 1000 };
        const row = {};
        for (const f of ["nome", "empresa", "cargo", "setor", "email", "telefone", "cota_assoc", "obs"]) {
          if (p[f] === undefined) continue;
          let v = p[f]; v = v == null ? null : String(v).trim(); if (v === "") v = null;
          row[f] = v == null ? null : v.slice(0, LIM[f]);
        }
        if (p.company_id !== undefined) row.company_id = p.company_id || null;
        if (p.origem_evento_id !== undefined) row.origem_evento_id = p.origem_evento_id || null;
        if (p.rel !== undefined) row.rel = EVT_REL.includes(p.rel) ? p.rel : "Contato";
        const dupMsg = "Já existe um contato com esse nome + empresa.";
        if (p.id) {
          if (!Object.keys(row).length) return res.status(400).json({ ok: false, error: "Nada para atualizar." });
          row.updated_at = nowIso;
          const { data, error } = await supabase.from("evt_contatos").update(row).eq("id", String(p.id)).select().maybeSingle();
          if (error) return res.status(error.code === "23505" ? 409 : 500).json({ ok: false, error: error.code === "23505" ? dupMsg : error.message });
          if (!data) return res.status(404).json({ ok: false, error: "Contato nao encontrado." });
          return res.status(200).json({ ok: true, contato: data });
        }
        if (!row.nome) return res.status(400).json({ ok: false, error: "Informe o nome" });
        if (row.rel === undefined) row.rel = "Contato";
        const { data, error } = await supabase.from("evt_contatos").insert(row).select().maybeSingle();
        if (error) return res.status(error.code === "23505" ? 409 : 500).json({ ok: false, error: error.code === "23505" ? dupMsg : error.message });
        return res.status(200).json({ ok: true, contato: data });
      }
      if (type === "evt_contato_remove") {
        const id = String(params(req).id || "").trim();
        if (!id) return res.status(400).json({ ok: false, error: "Informe id" });
        const { error } = await supabase.from("evt_contatos").delete().eq("id", id);
        if (error) return res.status(500).json({ ok: false, error: error.message });
        return res.status(200).json({ ok: true });
      }
      if (type === "evt_contato_import") {
        const p = params(req);
        const origem = p.origem_evento_id || null;
        const rows = [], seen = new Set();
        for (const raw of String(p.texto || "").split(/\r?\n/).slice(0, 1000)) {
          const line = raw.replace(/[✅✔☑⏱❌✖️]/g, "").trim();
          if (!line) continue;
          const parts = line.split(/\s+[–—-]\s+/);
          const nome = (parts[0] || "").trim().slice(0, 200);
          if (!nome) continue;
          const empresa = (parts[1] || "").trim().slice(0, 200) || null;
          const k = contatoKey(nome, empresa);
          if (seen.has(k)) continue; seen.add(k);
          rows.push({ nome, empresa, origem_evento_id: origem, rel: "Contato" });
        }
        if (!rows.length) return res.status(400).json({ ok: false, error: "Nenhum nome reconhecido (uma linha por contato: Nome – Empresa)." });
        let have; try { have = await loadContatoKeys(); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
        const fresh = rows.filter((r) => !have.has(contatoKey(r.nome, r.empresa)));
        if (fresh.length) { const { error } = await supabase.from("evt_contatos").insert(fresh); if (error) return res.status(500).json({ ok: false, error: error.message }); }
        return res.status(200).json({ ok: true, inserted: fresh.length, pulados: rows.length - fresh.length });
      }
      if (type === "evt_contato_from_convidados") {
        const evento_id = String(params(req).evento_id || "").trim();
        if (!evento_id) return res.status(400).json({ ok: false, error: "Informe evento_id" });
        const conv = [];
        for (let from = 0; ; from += 1000) {
          const { data, error } = await supabase.from("evt_convidados").select("nome, empresa, segmento").eq("evento_id", evento_id).eq("status", "confirmado").range(from, from + 999);
          if (error) return res.status(500).json({ ok: false, error: error.message });
          conv.push(...(data || []));
          if (!data || data.length < 1000) break;
        }
        if (!conv.length) return res.status(200).json({ ok: true, inserted: 0, pulados: 0 });
        let have; try { have = await loadContatoKeys(); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
        const seen = new Set(), fresh = [];
        for (const c of conv) {
          const k = contatoKey(c.nome, c.empresa);
          if (seen.has(k) || have.has(k)) continue; seen.add(k);
          fresh.push({ nome: String(c.nome).slice(0, 200), empresa: c.empresa ? String(c.empresa).slice(0, 200) : null, setor: c.segmento || null, origem_evento_id: evento_id, rel: "Contato" });
        }
        if (fresh.length) { const { error } = await supabase.from("evt_contatos").insert(fresh); if (error) return res.status(500).json({ ok: false, error: error.message }); }
        return res.status(200).json({ ok: true, inserted: fresh.length, pulados: conv.length - fresh.length });
      }
      if (type === "evt_contato_to_pipeline") {
        const p = params(req);
        const id = String(p.id || "").trim();
        const evento_id = String(p.evento_id || "").trim();
        if (!id || !evento_id) return res.status(400).json({ ok: false, error: "Informe id e evento_id" });
        const { data: c, error } = await supabase.from("evt_contatos").select("*").eq("id", id).maybeSingle();
        if (error) return res.status(500).json({ ok: false, error: error.message });
        if (!c) return res.status(404).json({ ok: false, error: "Contato nao encontrado." });
        const { data: patr, error: pErr } = await supabase.from("evt_patrocinadores").insert({
          evento_id, nome: (c.empresa || c.nome).slice(0, 300), company_id: c.company_id || null,
          contato: (c.nome + (c.cargo ? ` — ${c.cargo}` : "")).slice(0, 300), estagio: "Alvo", status: "prospect"
        }).select().maybeSingle();
        if (pErr) return res.status(500).json({ ok: false, error: pErr.message });
        // rel-flip é best-effort (o patrocinador já foi criado); surface como warn se falhar (não engolir).
        let warn = null;
        if (c.rel === "Contato") { const { error: relErr } = await supabase.from("evt_contatos").update({ rel: "Prospect patrocinio", updated_at: nowIso }).eq("id", id); if (relErr) warn = `contato criado no pipeline, mas falhou marcar como Prospect: ${relErr.message}`; }
        return res.status(200).json({ ok: true, patrocinador: patr, warn });
      }

      // F-EVT7 (C): PAUTA cross-evento — tarefas do checklist (prazo/offset) + proximas-acoes do
      // pipeline (data_acao), de todos os eventos ativos, ordenadas (proximas + vencidas).
      if (type === "evt_pauta") {
        const evById = {};
        for (let from = 0; ; from += 1000) { // pagina p/ nao truncar acima de 1000 eventos
          const { data: evs, error: evErr } = await supabase.from("evt_eventos").select("id, nome, data_evento, status").range(from, from + 999);
          if (evErr) return res.status(500).json({ ok: false, error: evErr.message });
          for (const e of evs || []) if (e.status !== "cancelado" && e.status !== "realizado") evById[e.id] = e;
          if (!evs || evs.length < 1000) break;
        }
        const derive = (v, dataEvento) => {
          if (v && v.prazo) return String(v.prazo).slice(0, 10);
          if (v && v.offset != null && v.offset !== "" && dataEvento) { const dt = new Date(String(dataEvento).slice(0, 10) + "T12:00:00"); if (!Number.isNaN(dt.getTime())) { dt.setUTCDate(dt.getUTCDate() + Number(v.offset)); return dt.toISOString().slice(0, 10); } }
          return null;
        };
        const out = [];
        await evtScanAll("evt_checklist_itens", "evento_id, valores", (it) => {
          const e = evById[it.evento_id]; if (!e) return;
          const v = it.valores || {}; if (v.status === "feito") return;
          const pr = derive(v, e.data_evento); if (pr) out.push({ date: pr, kind: "tarefa", txt: v.item || "(item)", who: v.responsavel || "", evento: e.nome, evento_id: it.evento_id });
        });
        await evtScanAll("evt_patrocinadores", "evento_id, nome, estagio, proxima_acao, data_acao, porta", (p) => {
          const e = evById[p.evento_id]; if (!e) return;
          if (!["Alvo", "Contatado", "Reuniao", "Proposta"].includes(p.estagio || "Alvo") || !p.data_acao) return;
          out.push({ date: String(p.data_acao).slice(0, 10), kind: "pipeline", txt: (p.proxima_acao || "ação") + " — " + (p.nome || "empresa"), who: p.porta || "", evento: e.nome, evento_id: p.evento_id });
        });
        out.sort((a, z) => (a.date < z.date ? -1 : a.date > z.date ? 1 : 0));
        return res.status(200).json({ ok: true, items: out.slice(0, 40) });
      }

      return res.status(400).json({ ok: false, error: `Tipo evt_ invalido: ${type}` });
    }

    // ===== M30: Modulo "Financeiro" (F-FIN1) — Balancete a partir do extrato — types fin_* =====
    if (type.startsWith("fin_")) {
      res.setHeader("Cache-Control", "no-store");
      const finNow = new Date().toISOString();
      const FIN_LANC_FIELDS = { conta: 120, lancamento: 200, detalhe: 300, descricao: 2000, estabelecimento: 200 };

      if (type === "fin_list") {
        const { data, error } = await supabase.from("fin_balancetes").select("id, competencia, titulo, status, created_at").order("competencia", { ascending: false }).limit(500);
        if (error) return res.status(500).json({ ok: false, error: error.message });
        // agrega contagem/total de despesas por balancete (paginado, sem N+1)
        const agg = {};
        for (let from = 0; ; from += 1000) {
          const { data: ls, error: lErr } = await supabase.from("fin_lancamentos").select("balancete_id, tipo, contabiliza, valor").order("id", { ascending: true }).range(from, from + 999);
          if (lErr) return res.status(500).json({ ok: false, error: lErr.message });
          for (const l of ls || []) { const a = (agg[l.balancete_id] = agg[l.balancete_id] || { n: 0, despesas: 0 }); a.n++; if (l.tipo === "debito" && l.contabiliza) a.despesas += Number(l.valor) || 0; }
          if (!ls || ls.length < 1000) break;
        }
        const items = (data || []).map((b) => ({ ...b, n_lancamentos: (agg[b.id] || {}).n || 0, total_despesas: (agg[b.id] || {}).despesas || 0 }));
        return res.status(200).json({ ok: true, items });
      }

      if (type === "fin_get") {
        const id = String(params(req).id || "").trim();
        if (!id) return res.status(400).json({ ok: false, error: "Informe id" });
        const { data: bal, error } = await supabase.from("fin_balancetes").select("*").eq("id", id).maybeSingle();
        if (error) return res.status(500).json({ ok: false, error: error.message });
        if (!bal) return res.status(404).json({ ok: false, error: "Balancete nao encontrado." });
        const { data: lancs, error: lErr } = await supabase.from("fin_lancamentos").select("*").eq("balancete_id", id).order("ordem", { ascending: true }).order("data", { ascending: true, nullsFirst: false }).order("created_at", { ascending: true });
        if (lErr) return res.status(500).json({ ok: false, error: lErr.message });
        // F-FIN1 (D): signed URLs curtas das NFs (bucket privado). Best-effort — se falhar, segue sem.
        const lancamentos = lancs || [];
        const comNf = lancamentos.filter((l) => l.nf_path);
        if (comNf.length) {
          try {
            const paths = comNf.map((l) => l.nf_path);
            const { data: signed } = await supabase.storage.from("financeiro-nf").createSignedUrls(paths, 3600);
            const byPath = {};
            for (const s of signed || []) if (s && s.path && s.signedUrl) byPath[s.path] = s.signedUrl;
            for (const l of comNf) l.nf_url = byPath[l.nf_path] || null;
          } catch (e) { /* sem signed url -> o front so mostra que ha NF */ }
        }
        return res.status(200).json({ ok: true, balancete: bal, lancamentos });
      }

      if (type === "fin_save") {
        const p = params(req);
        const patch = { updated_at: finNow };
        if (p.competencia !== undefined) patch.competencia = String(p.competencia).slice(0, 20);
        if (p.titulo !== undefined) patch.titulo = p.titulo ? String(p.titulo).slice(0, 300) : null;
        if (p.status && ["aberto", "fechado"].includes(p.status)) patch.status = p.status;
        if (p.id) {
          if (p.metadata && typeof p.metadata === "object" && !Array.isArray(p.metadata)) {
            const { data: cur, error: cErr } = await supabase.from("fin_balancetes").select("metadata").eq("id", String(p.id)).maybeSingle();
            if (cErr) return res.status(500).json({ ok: false, error: cErr.message }); // sem isso, um erro de leitura viraria overwrite total do metadata
            patch.metadata = { ...((cur && cur.metadata) || {}), ...p.metadata }; // merge sem perder chaves
          }
          const { data, error } = await supabase.from("fin_balancetes").update(patch).eq("id", String(p.id)).select().maybeSingle();
          if (error) return res.status(500).json({ ok: false, error: error.message });
          if (!data) return res.status(404).json({ ok: false, error: "Balancete nao encontrado." });
          return res.status(200).json({ ok: true, balancete: data });
        }
        if (!patch.competencia) return res.status(400).json({ ok: false, error: "Informe a competencia (YYYY-MM)." });
        const { data, error } = await supabase.from("fin_balancetes").insert(patch).select().maybeSingle();
        if (error) return res.status(500).json({ ok: false, error: error.message });
        return res.status(200).json({ ok: true, balancete: data });
      }

      if (type === "fin_delete") {
        const id = String(params(req).id || "").trim();
        if (!id) return res.status(400).json({ ok: false, error: "Informe id" });
        // F-FIN1: limpa as NFs do Storage ANTES (o cascade apaga as linhas mas nao os arquivos) — LGPD.
        const paths = [];
        for (let from = 0; ; from += 1000) {
          const { data: nfs, error: nErr } = await supabase.from("fin_lancamentos").select("nf_path").eq("balancete_id", id).not("nf_path", "is", null).order("id", { ascending: true }).range(from, from + 999);
          if (nErr) return res.status(500).json({ ok: false, error: nErr.message });
          for (const l of nfs || []) if (l.nf_path) paths.push(l.nf_path);
          if (!nfs || nfs.length < 1000) break;
        }
        if (paths.length) await supabase.storage.from("financeiro-nf").remove(paths).catch(() => {});
        const { error } = await supabase.from("fin_balancetes").delete().eq("id", id);
        if (error) return res.status(500).json({ ok: false, error: error.message });
        return res.status(200).json({ ok: true });
      }

      if (type === "fin_lancamento_add") {
        const p = params(req);
        const balancete_id = String(p.balancete_id || "").trim();
        if (!balancete_id) return res.status(400).json({ ok: false, error: "Informe balancete_id" });
        const { data: last } = await supabase.from("fin_lancamentos").select("ordem").eq("balancete_id", balancete_id).order("ordem", { ascending: false }).limit(1).maybeSingle();
        const ordem = ((last && last.ordem) != null ? last.ordem : -1) + 1;
        const row = { balancete_id, ordem, conta: p.conta ? String(p.conta).slice(0, 120) : "Banco do Brasil", tipo: "debito", contabiliza: true };
        const { data, error } = await supabase.from("fin_lancamentos").insert(row).select().maybeSingle();
        if (error) return res.status(500).json({ ok: false, error: error.message });
        return res.status(200).json({ ok: true, lancamento: data });
      }

      if (type === "fin_lancamento_save") {
        const p = params(req);
        const id = String(p.id || "").trim();
        if (!id) return res.status(400).json({ ok: false, error: "Informe id" });
        const row = {};
        for (const f of Object.keys(FIN_LANC_FIELDS)) { if (p[f] === undefined) continue; let v = p[f]; v = v == null ? null : String(v).trim(); row[f] = v === "" ? null : v.slice(0, FIN_LANC_FIELDS[f]); }
        if (p.data !== undefined) row.data = p.data ? String(p.data).slice(0, 10) : null;
        if (p.valor !== undefined) row.valor = (p.valor == null || p.valor === "") ? null : (Number.isFinite(Number(p.valor)) ? Number(p.valor) : null);
        if (p.tipo !== undefined && ["debito", "credito"].includes(p.tipo)) { row.tipo = p.tipo; row.contabiliza = p.tipo === "credito" ? false : true; } // credito nunca contabiliza
        if (p.contabiliza !== undefined) row.contabiliza = !!p.contabiliza; // override manual (ex.: debito interno que nao conta)
        if (!Object.keys(row).length) return res.status(400).json({ ok: false, error: "Nada para atualizar." });
        row.updated_at = finNow;
        const { data, error } = await supabase.from("fin_lancamentos").update(row).eq("id", id).select().maybeSingle();
        if (error) return res.status(500).json({ ok: false, error: error.message });
        if (!data) return res.status(404).json({ ok: false, error: "Lancamento nao encontrado." });
        return res.status(200).json({ ok: true, lancamento: data });
      }

      if (type === "fin_lancamento_remove") {
        const id = String(params(req).id || "").trim();
        if (!id) return res.status(400).json({ ok: false, error: "Informe id" });
        const { data: l, error: gErr } = await supabase.from("fin_lancamentos").select("nf_path").eq("id", id).maybeSingle();
        if (gErr) return res.status(500).json({ ok: false, error: gErr.message });
        if (l && l.nf_path) await supabase.storage.from("financeiro-nf").remove([l.nf_path]).catch(() => {}); // NF junto — LGPD
        const { error } = await supabase.from("fin_lancamentos").delete().eq("id", id);
        if (error) return res.status(500).json({ ok: false, error: error.message });
        return res.status(200).json({ ok: true });
      }

      // F-FIN1 (C): parser regex do extrato do BANCO DO BRASIL (texto colado, SEM IA).
      // Linha "VALOR (±) DATA TIPO" + (opcional) linha seguinte de detalhe "DD/MM HH:MM DESTINATARIO".
      if (type === "fin_extrato_import") {
        const p = params(req);
        const balancete_id = String(p.balancete_id || "").trim();
        const conta = p.conta ? String(p.conta).slice(0, 120) : "Banco do Brasil";
        if (!balancete_id) return res.status(400).json({ ok: false, error: "Informe balancete_id" });
        const lines = String(p.texto || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        const valRe = /^([\d.]+,\d{2})\s*\(([-+])\)\s*(\d{2})\/(\d{2})\/(\d{4})\s+(.+)$/;
        const detRe = /^\d{2}\/\d{2}\s+\d{2}:\d{2}\s+(.+)$/;
        const parsed = []; let saldoAnterior = null;
        for (let i = 0; i < lines.length; i++) {
          const m = lines[i].match(valRe);
          if (!m) continue;
          const valor = Number(m[1].replace(/\./g, "").replace(",", "."));
          const tipo = m[2] === "-" ? "debito" : "credito";
          const data = `${m[5]}-${m[4]}-${m[3]}`;
          const lancamento = m[6].trim();
          let detalhe = null;
          if (i + 1 < lines.length && !valRe.test(lines[i + 1])) { const dm = lines[i + 1].match(detRe); detalhe = (dm ? dm[1] : lines[i + 1]).trim().slice(0, 300); i++; }
          if (/saldo anterior/i.test(lancamento)) { saldoAnterior = valor; continue; }
          if (/^s\s*a\s*l\s*d\s*o$/i.test(lancamento.replace(/\s+/g, " ").trim())) continue;
          parsed.push({ data, lancamento: lancamento.slice(0, 200), detalhe, valor, tipo });
        }
        if (!parsed.length) return res.status(400).json({ ok: false, error: "Nenhum lançamento reconhecido (confira o formato Banco do Brasil)." });
        const key = (l) => `${l.data}|${l.valor}|${String(l.detalhe || "").toLowerCase()}`;
        const existing = new Set();
        for (let from = 0; ; from += 1000) {
          const { data: ex, error } = await supabase.from("fin_lancamentos").select("data, valor, detalhe").eq("balancete_id", balancete_id).order("id", { ascending: true }).range(from, from + 999);
          if (error) return res.status(500).json({ ok: false, error: error.message });
          for (const e of ex || []) existing.add(key({ data: e.data, valor: Number(e.valor), detalhe: e.detalhe }));
          if (!ex || ex.length < 1000) break;
        }
        const { data: last } = await supabase.from("fin_lancamentos").select("ordem").eq("balancete_id", balancete_id).order("ordem", { ascending: false }).limit(1).maybeSingle();
        let ordem = (last && last.ordem) != null ? last.ordem : -1;
        const fresh = parsed.filter((l) => !existing.has(key(l))).map((l) => ({ balancete_id, conta, ordem: ++ordem, data: l.data, lancamento: l.lancamento, detalhe: l.detalhe, valor: l.valor, tipo: l.tipo, contabiliza: l.tipo !== "credito" }));
        if (fresh.length) { const { error } = await supabase.from("fin_lancamentos").insert(fresh); if (error) return res.status(500).json({ ok: false, error: error.message }); }
        if (saldoAnterior != null) {
          const { data: cur, error: cErr } = await supabase.from("fin_balancetes").select("metadata").eq("id", balancete_id).maybeSingle();
          if (cErr) return res.status(500).json({ ok: false, error: cErr.message }); // sem isso, leitura falha -> overwrite total do metadata
          const md = (cur && cur.metadata) || {}; const saldos = { ...(md.saldos || {}) }; saldos[conta] = { ...(saldos[conta] || {}), anterior: saldoAnterior };
          const { error: uErr } = await supabase.from("fin_balancetes").update({ metadata: { ...md, saldos }, updated_at: finNow }).eq("id", balancete_id);
          if (uErr) return res.status(500).json({ ok: false, error: uErr.message });
        }
        return res.status(200).json({ ok: true, inserted: fresh.length, pulados: parsed.length - fresh.length, saldo_anterior: saldoAnterior });
      }

      // F-FIN1 (D): upload da NF no bucket PRIVADO via service-role. base64 (limite ~4MB).
      if (type === "fin_nf_upload") {
        const p = params(req);
        const id = String(p.id || "").trim();
        const base64 = String(p.base64 || "");
        if (!id || !base64) return res.status(400).json({ ok: false, error: "Informe id e o arquivo" });
        const bytes = Math.floor(base64.length * 3 / 4);
        if (bytes > 4 * 1024 * 1024) return res.status(413).json({ ok: false, error: "Arquivo muito grande (máx 4MB). Comprima a NF." });
        const { data: l, error: gErr } = await supabase.from("fin_lancamentos").select("balancete_id, nf_path").eq("id", id).maybeSingle();
        if (gErr) return res.status(500).json({ ok: false, error: gErr.message });
        if (!l) return res.status(404).json({ ok: false, error: "Lancamento nao encontrado." });
        const safe = String(p.filename || "nf").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-60) || "nf";
        const path = `${l.balancete_id}/${id}-${safe}`;
        const buffer = Buffer.from(base64, "base64");
        const { error: upErr } = await supabase.storage.from("financeiro-nf").upload(path, buffer, { contentType: p.mime || "application/octet-stream", upsert: true });
        if (upErr) return res.status(500).json({ ok: false, error: `upload: ${upErr.message}` });
        if (l.nf_path && l.nf_path !== path) await supabase.storage.from("financeiro-nf").remove([l.nf_path]).catch(() => {}); // troca de arquivo -> apaga o antigo
        const { error: uErr } = await supabase.from("fin_lancamentos").update({ nf_path: path, updated_at: finNow }).eq("id", id);
        if (uErr) return res.status(500).json({ ok: false, error: uErr.message });
        return res.status(200).json({ ok: true, nf_path: path });
      }
      if (type === "fin_nf_remove") {
        const id = String(params(req).id || "").trim();
        if (!id) return res.status(400).json({ ok: false, error: "Informe id" });
        const { data: l, error: gErr } = await supabase.from("fin_lancamentos").select("nf_path").eq("id", id).maybeSingle();
        if (gErr) return res.status(500).json({ ok: false, error: gErr.message }); // sem isso, falha de leitura pularia o delete do Storage e ainda limparia nf_path (orfa)
        if (l && l.nf_path) { const { error: rmErr } = await supabase.storage.from("financeiro-nf").remove([l.nf_path]); if (rmErr) return res.status(500).json({ ok: false, error: rmErr.message }); }
        const { error } = await supabase.from("fin_lancamentos").update({ nf_path: null, updated_at: finNow }).eq("id", id);
        if (error) return res.status(500).json({ ok: false, error: error.message });
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ ok: false, error: `Tipo fin_ invalido: ${type}` });
    }

    // Participacoes societarias locais de uma empresa (base receita_socio).
    if (type === "holdings") {
      const cnpj = onlyDigits(req.query.cnpj);
      if (cnpj.length !== 14) return res.status(400).json({ ok: false, error: "CNPJ invalido." });
      const { data: company } = await supabase.from("companies").select("id, cnpj, legal_name").eq("cnpj", cnpj).maybeSingle();
      if (!company) return res.status(200).json({ ok: true, items: [], note: "Empresa fora da base local. Rode load:receita-socio." });
      const { data: rels } = await supabase
        .from("relationships")
        .select("from_id, relationship, metadata, created_at")
        .eq("to_kind", "company").eq("to_id", company.id).eq("relationship", "socio");
      const personIds = [...new Set((rels || []).map((r) => r.from_id))];
      let people = [];
      if (personIds.length) {
        const { data: ppl } = await supabase.from("people").select("id, full_name, role").in("id", personIds);
        people = ppl || [];
      }
      const byId = Object.fromEntries(people.map((p) => [p.id, p]));
      const items = (rels || []).map((r) => ({
        person_id: r.from_id,
        name: byId[r.from_id]?.full_name || "?",
        role: r.metadata?.role || byId[r.from_id]?.role || "Sócio",
        source: "Receita Federal (dump SOCIO)"
      }));
      return res.status(200).json({ ok: true, company: company.legal_name, items });
    }

    // Score de risco politico de uma pessoa (inteligencia politica estilo Arko).
    // Componentes rastreaveis: filiacao/doacao partidaria, porta giratoria
    // (dirigente + socio), rede societaria e empresas inaptas. ?id=<uuid pessoa>.
    if (type === "political_risk") {
      const id = String(req.query.id || "").trim();
      if (!id) return res.status(400).json({ ok: false, error: "Informe ?id=<uuid da pessoa>" });
      const { data: person } = await supabase.from("people").select("id, full_name, role").eq("id", id).maybeSingle();
      if (!person) return res.status(404).json({ ok: false, error: "Pessoa nao encontrada." });

      const [partyRes, mandatesRes, socioRes] = await Promise.all([
        supabase.from("party_links").select("party, link_type, amount, reference_year").eq("person_id", id),
        supabase.from("mandates").select("agency_id, role, ended_at").eq("person_id", id),
        // relationships e polimorfica (to_id sem FK) -> NAO da para usar embed
        // companies(...). Busca so os ids/metadata e resolve as empresas depois.
        supabase.from("relationships")
          .select("to_id, metadata")
          .eq("from_kind", "person").eq("from_id", id)
          .eq("to_kind", "company").eq("relationship", "socio")
      ]);

      const parties = partyRes.data || [];
      const mandates = mandatesRes.data || [];
      const socioRels = socioRes.data || [];
      // 2a query: resolve empresas por id (padrao de api/dossier-person.js).
      let companiesById = {};
      if (socioRels.length) {
        const ids = [...new Set(socioRels.map((r) => r.to_id))];
        const { data: comps } = await supabase
          .from("companies").select("id, cnpj, legal_name, registration_status").in("id", ids);
        companiesById = Object.fromEntries((comps || []).map((c) => [c.id, c]));
      }
      const socio = socioRels.map((r) => ({ ...r, companies: companiesById[r.to_id] || null }));
      const activeMandate = mandates.some((m) => !m.ended_at);
      const inactiveCompanies = socio.filter(
        (r) => r.companies?.registration_status && !isSituacaoAtiva(r.companies.registration_status)
      ).length;

      // SELF-DEALING: alguma empresa-socio FORNECE uma agencia que a pessoa dirige?
      // (o sinal forte, deterministico: socio x contract x mandate mesma agencia).
      const mandateAgencies = new Set(mandates.map((m) => m.agency_id).filter(Boolean));
      const socioCompanyIds = [...new Set(socioRels.map((r) => r.to_id).filter(Boolean))];
      const selfDealingCompanies = [];
      if (socioCompanyIds.length && mandateAgencies.size) {
        const { data: cts } = await supabase.from("contracts")
          .select("supplier_company_id, agency_id").in("supplier_company_id", socioCompanyIds);
        const flagged = new Set();
        for (const c of cts || []) if (c.supplier_company_id && mandateAgencies.has(c.agency_id)) flagged.add(c.supplier_company_id);
        for (const cid of flagged) selfDealingCompanies.push(companiesById[cid]?.legal_name || cid);
      }

      // Patrimonio declarado (TSE) — sinal a monitorar (nao pontua alto sozinho).
      const { data: assetsRows } = await supabase.from("assets").select("value").eq("person_id", id);
      const patrimonio = (assetsRows || []).reduce((s, a) => s + (Number(a.value) || 0), 0);

      // Componentes 0-100 (transparentes: o front exibe o detalhamento).
      const components = {
        partidario: Math.min(30, parties.length * 15),
        self_dealing: selfDealingCompanies.length ? 35 : (activeMandate && socio.length ? 12 : 0),
        rede_societaria: Math.min(20, socio.length * 5),
        empresas_inaptas: Math.min(15, inactiveCompanies * 10)
      };
      const score = Math.min(100, Object.values(components).reduce((a, b) => a + b, 0));
      const band = score >= 70 ? "alto" : score >= 40 ? "medio" : "baixo";

      return res.status(200).json({
        ok: true, type: "political_risk",
        person: { id: person.id, name: person.full_name, role: person.role },
        score, band, components,
        signals: {
          parties: parties.map((p) => ({ party: p.party, type: p.link_type, amount: p.amount, year: p.reference_year })),
          active_mandate: activeMandate,
          mandate_count: mandates.length,
          self_dealing_companies: selfDealingCompanies,
          patrimonio_declarado: patrimonio,
          companies: socio.map((r) => ({
            cnpj: r.companies?.cnpj, legal_name: r.companies?.legal_name,
            status: r.companies?.registration_status, role: r.metadata?.role
          })),
          inactive_companies: inactiveCompanies
        }
      });
    }

    // Radar de Risco & Oportunidade (estilo Arko + Sherlocker). Sintetiza 4
    // angulos a partir do que ja existe: (1) porta giratoria/captura, (2)
    // contratos a vencer, (3) consultas abertas, (4) proposicoes legislativas.
    if (type === "radar_intel") {
      res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=1800");
      const today = new Date().toISOString().slice(0, 10);
      const in90 = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
      const since45 = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);

      // RISCO — porta giratoria: diretor ativo que tambem e socio de empresa(s).
      async function computeRisks() {
        const { data: activeMandates } = await supabase
          .from("mandates")
          .select("person_id, role, agency_id, people(full_name), agencies(acronym)")
          .is("ended_at", null).limit(2000);
        const dirIds = [...new Set((activeMandates || []).map((m) => m.person_id).filter(Boolean))];
        if (!dirIds.length) return [];
        const { data: socioRels } = await supabase
          .from("relationships").select("from_id, to_id, metadata")
          .eq("from_kind", "person").eq("to_kind", "company").eq("relationship", "socio")
          .in("from_id", dirIds).limit(4000);
        const compIds = [...new Set((socioRels || []).map((r) => r.to_id))];
        let compById = {};
        if (compIds.length) {
          const { data: comps } = await supabase.from("companies")
            .select("id, cnpj, legal_name, registration_status").in("id", compIds);
          compById = Object.fromEntries((comps || []).map((c) => [c.id, c]));
        }
        const byPerson = {};
        for (const r of socioRels || []) {
          const c = compById[r.to_id]; if (!c) continue;
          (byPerson[r.from_id] = byPerson[r.from_id] || []).push({ ...c, socio_role: r.metadata?.role });
        }
        const seen = new Set(), out = [];
        for (const m of activeMandates || []) {
          const comps = byPerson[m.person_id];
          if (!comps || seen.has(m.person_id)) continue;
          seen.add(m.person_id);
          const inaptas = comps.filter((c) => c.registration_status && !isSituacaoAtiva(c.registration_status)).length;
          out.push({
            kind: "porta_giratoria", person_id: m.person_id, name: m.people?.full_name || "?",
            agency: m.agencies?.acronym || null, role: m.role || null,
            companies: comps.length, inaptas, severity: inaptas ? "high" : "medium"
          });
        }
        return out.sort((a, b) => (b.inaptas - a.inaptas) || (b.companies - a.companies)).slice(0, 30);
      }

      // OPORTUNIDADE — contratos a vencer nos proximos 90 dias.
      async function computeContracts() {
        const { data } = await supabase.from("contracts")
          .select("object, supplier_name, ends_at, value, agencies(acronym)")
          .gte("ends_at", today).lte("ends_at", in90).order("ends_at").limit(40);
        return (data || []).map((c) => ({
          kind: "contrato_vencendo", label: (c.object || "Contrato").slice(0, 140),
          supplier: c.supplier_name || null, agency: c.agencies?.acronym || null,
          ends_at: c.ends_at, value: c.value || null
        }));
      }

      // OPORTUNIDADE — consultas/audiencias publicas abertas (dos atos do DOU).
      async function computeConsultas() {
        const { data } = await supabase.from("documents")
          .select("title, published_at, source_url, agencies(acronym)")
          .eq("source_name", "DOU").gte("published_at", since45)
          .or("title.ilike.%consulta p%,title.ilike.%audi%,title.ilike.%tomada de subs%")
          .order("published_at", { ascending: false }).limit(25);
        return (data || []).map((d) => ({
          kind: "consulta_aberta", label: d.title, agency: d.agencies?.acronym || null,
          date: d.published_at, link: d.source_url
        }));
      }

      // LEGISLATIVO — proposicoes recentes (Camara/Senado). Degrada se a API cair.
      async function computeLegislative() {
        try {
          const { searchProposicoes } = require("../lib/legislativo");
          const year = new Date().getFullYear();
          const r = await searchProposicoes({ ano: year, limit: 8 });
          return (r.items || []).map((p) => ({
            kind: "proposicao", titulo: p.titulo, casa: p.casa,
            ementa: (p.ementa || "").slice(0, 200), url: p.url
          }));
        } catch { return []; }
      }

      const [risksP, contractsP, consultasP, legisP] = await Promise.allSettled([
        computeRisks(), computeContracts(), computeConsultas(), computeLegislative()
      ]);
      const val = (p) => (p.status === "fulfilled" ? p.value : []);
      const risks = val(risksP);
      const opportunities = [...val(contractsP), ...val(consultasP)];
      const legislative = val(legisP);

      return res.status(200).json({
        ok: true, type: "radar_intel",
        counts: { risks: risks.length, opportunities: opportunities.length, legislative: legislative.length },
        risks, opportunities, legislative,
        fetchedAt: new Date().toISOString()
      });
    }

    // Tendencias e anomalias semanais por agencia (picos e silencios).
    if (type === "trends_anomalies") {
      res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");
      const weeks = Math.min(Math.max(Number(req.query.weeks) || 8, 4), 16);
      const result = await weeklyAgencyAnalysis(supabase, weeks);
      return res.status(200).json({ ok: true, type: "trends_anomalies", window_weeks: weeks, ...result, fetchedAt: new Date().toISOString() });
    }

    // Motor de correlacoes: cruza sinais ja existentes por entidade compartilhada.
    // Cada correlacao tem evidencias rastreaveis e severidade. Sem IA (fase 2).
    if (type === "correlations") {
      res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=1800");
      const since90 = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
      const in90 = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
      const today = new Date().toISOString().slice(0, 10);
      const out = [];

      // Base: mandatos (recentes e ativos) + vinculos societarios dessas pessoas.
      const [recentRes, activeRes] = await Promise.all([
        supabase.from("mandates")
          .select("person_id, role, started_at, people(full_name), agencies(acronym)")
          .gte("started_at", since90).limit(500),
        supabase.from("mandates")
          .select("person_id, role, people(full_name), agencies(acronym)")
          .is("ended_at", null).limit(2000)
      ]);
      const recent = recentRes.data || [];
      const active = activeRes.data || [];
      const personIds = [...new Set([...recent, ...active].map((m) => m.person_id).filter(Boolean))];

      let socioByPerson = {}, compById = {};
      if (personIds.length) {
        const { data: socioRels } = await supabase.from("relationships")
          .select("from_id, to_id, metadata")
          .eq("from_kind", "person").eq("to_kind", "company").eq("relationship", "socio")
          .in("from_id", personIds).limit(4000);
        const compIds = [...new Set((socioRels || []).map((r) => r.to_id))];
        if (compIds.length) {
          const { data: comps } = await supabase.from("companies")
            .select("id, cnpj, legal_name, registration_status").in("id", compIds);
          compById = Object.fromEntries((comps || []).map((c) => [c.id, c]));
        }
        for (const r of socioRels || []) {
          const c = compById[r.to_id]; if (!c) continue;
          (socioByPerson[r.from_id] = socioByPerson[r.from_id] || []).push({ ...c, socio_role: r.metadata?.role });
        }
      }

      // Contratos publicos das empresas ligadas (por company_id E por cnpj).
      const allCompIds = Object.values(compById).map((c) => c.id);
      const allCnpjs = Object.values(compById).map((c) => (c.cnpj || "").replace(/\D/g, "")).filter((v) => v.length >= 8);
      let contractsByComp = {};
      if (allCompIds.length) {
        const [byId, byCnpj] = await Promise.all([
          supabase.from("contracts").select("supplier_company_id, supplier_cnpj, object, value, ends_at, agencies(acronym)").in("supplier_company_id", allCompIds).limit(1000),
          allCnpjs.length ? supabase.from("contracts").select("supplier_company_id, supplier_cnpj, object, value, ends_at, agencies(acronym)").in("supplier_cnpj", allCnpjs).limit(1000) : Promise.resolve({ data: [] })
        ]);
        // Dedup por chave estavel (a mesma linha pode vir das duas buscas).
        const seenContract = new Set();
        const contractKey = (c) => `${c.supplier_cnpj || ""}|${c.ends_at || ""}|${(c.object || "").slice(0, 40)}`;
        const push = (key, c) => {
          if (!key) return;
          const ck = `${key}|${contractKey(c)}`;
          if (seenContract.has(ck)) return;
          seenContract.add(ck);
          (contractsByComp[key] = contractsByComp[key] || []).push(c);
        };
        for (const c of byId.data || []) push(c.supplier_company_id, c);
        for (const c of byCnpj.data || []) {
          const comp = Object.values(compById).find((x) => (x.cnpj || "").replace(/\D/g, "") === (c.supplier_cnpj || "").replace(/\D/g, ""));
          if (comp) push(comp.id, c);
        }
      }

      // Regra 1 (ALTA): nomeacao recente x socio x fornecedor publico.
      // F-INT1: UM card por pessoa (antes: pessoa com 6 empresas = 6 cards high identicos
      // empurrando o resto p/ fora do corte de 50).
      const seenR1 = new Set();
      for (const m of recent) {
        if (seenR1.has(m.person_id)) continue;
        const comps = (socioByPerson[m.person_id] || []).filter((comp) => (contractsByComp[comp.id] || []).length);
        if (!comps.length) continue;
        seenR1.add(m.person_id);
        const contratosEv = comps.flatMap((comp) => (contractsByComp[comp.id] || []).slice(0, 2).map((c) => `Contrato público de ${comp.legal_name || comp.cnpj}: ${(c.object || "").slice(0, 70)}${c.agencies?.acronym ? ` (${c.agencies.acronym})` : ""}`)).slice(0, 4);
        out.push({
          kind: "nomeacao_x_fornecedor", severity: "high",
          title: `${m.people?.full_name || "Dirigente"} nomeado(a) há pouco na ${m.agencies?.acronym || "agência"} é sócio(a) de ${comps.length} fornecedor(es) público(s)`,
          entities: [
            { kind: "person", id: m.person_id, label: m.people?.full_name || "?" },
            ...comps.slice(0, 3).map((comp) => ({ kind: "company", id: comp.id, label: comp.legal_name || comp.cnpj }))
          ],
          evidence: [
            `Mandato iniciado em ${m.started_at}${m.role ? ` (${m.role})` : ""}`,
            ...contratosEv
          ],
          suggested_action: "Verificar impedimento/conflito de interesse e histórico de contratos."
        });
      }

      // Regra 2 (MEDIA/ALTA): dirigente ativo x empresa inapta/baixada.
      const seenR2 = new Set();
      for (const m of active) {
        if (seenR2.has(m.person_id)) continue;
        const inaptas = (socioByPerson[m.person_id] || []).filter((c) => c.registration_status && !isSituacaoAtiva(c.registration_status));
        if (!inaptas.length) continue;
        seenR2.add(m.person_id);
        out.push({
          kind: "dirigente_x_inapta", severity: inaptas.length > 1 ? "high" : "medium",
          title: `${m.people?.full_name || "Dirigente"} (${m.agencies?.acronym || "agência"}) é sócio(a) de ${inaptas.length} empresa(s) inapta(s)/baixada(s)`,
          entities: [
            { kind: "person", id: m.person_id, label: m.people?.full_name || "?" },
            ...inaptas.slice(0, 3).map((c) => ({ kind: "company", id: c.id, label: c.legal_name || c.cnpj }))
          ],
          evidence: inaptas.slice(0, 3).map((c) => `${c.legal_name || c.cnpj}: situação "${c.registration_status}"`),
          suggested_action: "Checar padrão de empresas de fachada / interpostas (laranjas)."
        });
      }

      // Regra 3 (MEDIA): agencia em pico de atividade x contratos a vencer nela.
      try {
        const { anomalies } = await weeklyAgencyAnalysis(supabase, 8);
        const spikes = anomalies.filter((a) => a.kind === "pico" && a.metric !== "ato_pessoal");
        if (spikes.length) {
          const { data: endingContracts } = await supabase.from("contracts")
            .select("object, ends_at, agencies(acronym)")
            .gte("ends_at", today).lte("ends_at", in90).limit(200);
          const endingByAgency = {};
          for (const c of endingContracts || []) {
            const ac = c.agencies?.acronym; if (!ac) continue;
            (endingByAgency[ac] = endingByAgency[ac] || []).push(c);
          }
          for (const s of spikes.slice(0, 5)) {
            const ending = endingByAgency[s.agency] || [];
            if (!ending.length) continue;
            out.push({
              kind: "janela_regulatoria", severity: "medium",
              title: `${s.agency} em pico de ${s.metric === "total" ? "atividade" : s.metric} (${s.ratio}x o padrão) com ${ending.length} contrato(s) a vencer`,
              entities: [{ kind: "agency", id: null, label: s.agency }],
              evidence: [
                `Semana atual: ${s.current} vs baseline ${s.baseline} (${s.ratio}x)`,
                ...ending.slice(0, 3).map((c) => `Contrato vence ${c.ends_at}: ${(c.object || "").slice(0, 70)}`)
              ],
              suggested_action: "Janela de movimento regulatório: monitorar editais e consultas desta agência."
            });
          }
        }
      } catch { /* anomalias sao best-effort dentro das correlacoes */ }

      // Regra 4 (ALTA): monitor que disparou sobre entidade com vinculos societarios.
      try {
        const { data: hotMonitors } = await supabase.from("monitors")
          .select("id, label, kind, hit_count, last_hit_at, person_id, company_id")
          .eq("active", true).gt("hit_count", 0).limit(100);
        // F-INT1: rotula com o NOME da pessoa (antes: o label do monitor aparecia como se
        // fosse a pessoa no card) e pula quem ja tem card das regras 1/2 (dedup entre regras).
        const monPids = [...new Set((hotMonitors || []).map((m) => m.person_id).filter(Boolean))];
        const pName = {};
        if (monPids.length) {
          const { data: ppl } = await supabase.from("people").select("id, full_name").in("id", monPids);
          for (const p of ppl || []) pName[p.id] = p.full_name;
        }
        const seenR4 = new Set();
        for (const mon of hotMonitors || []) {
          const pid = mon.person_id;
          const links = pid ? (socioByPerson[pid] || []) : [];
          if (pid && links.length && !seenR1.has(pid) && !seenR2.has(pid) && !seenR4.has(pid)) {
            seenR4.add(pid);
            const nome = pName[pid] || mon.label;
            out.push({
              kind: "monitor_x_vinculos", severity: "high",
              title: `Monitor "${mon.label}" disparou ${mon.hit_count}x — ${nome} tem ${links.length} vínculo(s) societário(s)`,
              entities: [{ kind: "person", id: pid, label: nome }],
              evidence: [
                `Último disparo: ${String(mon.last_hit_at || "").slice(0, 10)}`,
                ...links.slice(0, 3).map((c) => `Sócio(a) de ${c.legal_name || c.cnpj}`)
              ],
              suggested_action: "Abrir o dossiê e revisar os atos que dispararam o monitor."
            });
          }
        }
      } catch { /* monitors podem nao existir em bancos antigos */ }

      const SEV_ORDER = { high: 0, medium: 1, low: 2 };
      out.sort((a, b) => (SEV_ORDER[a.severity] ?? 3) - (SEV_ORDER[b.severity] ?? 3));
      return res.status(200).json({
        ok: true, type: "correlations",
        total: out.length, correlations: out.slice(0, 50),
        fetchedAt: new Date().toISOString()
      });
    }

    // ── Mapa de Landscape (M14): distribuicao de atos por TEMA x agencia. ────
    // GET ?type=landscape[&theme=<label>][&days=180]. Sem theme: so distribuicao
    // + lista de temas (para o dropdown do Gerador). Com theme: recorte por
    // agencia + atos recentes. Degrada se a coluna 'themes' ainda nao existir.
    if (type === "landscape") {
      res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");
      const theme = req.query.theme ? String(req.query.theme) : null;
      const days = Math.min(Math.max(Number(req.query.days) || 180, 30), 720);
      const lp = await computeLandscape(supabase, { theme, days });
      if (!lp.ready) {
        return res.status(200).json({
          ok: true, type: "landscape", note: "themes_not_ready", days,
          themes_available: lp.themes_available, distribution: [], by_agency: [], total: 0
        });
      }
      return res.status(200).json({ ok: true, type: "landscape", days, ...lp });
    }

    // ── Dossie Comercial (M14): compoe Landscape + Briefing de decisores +
    // Memo (riscos/oportunidades) + Contraparte (opcional). So DADOS; a
    // narrativa IA vem de type=deal_narrative (POST). ─────────────────────────
    // GET ?type=deal_dossier&theme=<label>[&agency=ANEEL,ANATEL][&cnpj=][&days=180]
    if (type === "deal_dossier") {
      res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=1800");
      const theme = req.query.theme ? String(req.query.theme) : null;
      const days = Math.min(Math.max(Number(req.query.days) || 180, 30), 720);
      const agencyList = String(req.query.agency || "").toUpperCase().split(",").map((s) => s.trim()).filter(Boolean);
      const cnpj = onlyDigits(req.query.cnpj);
      const today = new Date().toISOString().slice(0, 10);
      const in90 = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
      const since45 = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);

      // Agencias uma unica vez (reusada no landscape e no agByAcr). Erro real
      // aqui NAO pode virar "agencias-alvo vazias" silenciosamente -> propaga.
      const agRes = await supabase.from("agencies").select("id, acronym, name").eq("sector", "regulatory");
      if (agRes.error) throw new Error(agRes.error.message);
      const agenciesAll = agRes.data || [];
      const agByAcr = Object.fromEntries(agenciesAll.map((a) => [a.acronym, a]));

      // 1) Landscape do tema + 2) Contraparte (independentes) em paralelo.
      const [landscape, counterparty] = await Promise.all([
        computeLandscape(supabase, { theme, days, agencies: agenciesAll }),
        cnpj.length === 14
          ? require("../lib/counterparty").composeCounterparty(cnpj)
          : Promise.resolve(null)
      ]);

      // Agencias-alvo: as informadas, senao as mais ativas do tema no landscape.
      let targetAcr = agencyList.filter((a) => agByAcr[a]);
      if (!targetAcr.length && landscape.by_agency?.length) targetAcr = landscape.by_agency.slice(0, 4).map((a) => a.agency);
      const targetAgencies = targetAcr.map((a) => agByAcr[a]).filter(Boolean);
      const targetIds = targetAgencies.map((a) => a.id);

      // 3) Briefing de decisores: dirigentes ATIVOS das agencias-alvo + vinculos
      //    societarios (padrao de radar_intel: relationships socio -> companies).
      async function computeBriefing() {
        const directors = [], risks = [];
        if (!targetIds.length) return { directors, risks };
        const { data: mandates } = await supabase.from("mandates")
          .select("person_id, role, started_at, agency_id, people(full_name), agencies(acronym)")
          .is("ended_at", null).in("agency_id", targetIds).limit(500);
        const pids = [...new Set((mandates || []).map((m) => m.person_id).filter(Boolean))];
        let linksByPerson = {};
        if (pids.length) {
          const { data: rels } = await supabase.from("relationships")
            .select("from_id, to_id, metadata")
            .eq("from_kind", "person").eq("to_kind", "company").eq("relationship", "socio")
            .in("from_id", pids).limit(4000);
          const compIds = [...new Set((rels || []).map((r) => r.to_id))];
          let compById = {};
          if (compIds.length) {
            const { data: comps } = await supabase.from("companies")
              .select("id, cnpj, legal_name, registration_status").in("id", compIds);
            compById = Object.fromEntries((comps || []).map((c) => [c.id, c]));
          }
          for (const r of rels || []) {
            const c = compById[r.to_id];
            if (!c) continue;
            (linksByPerson[r.from_id] = linksByPerson[r.from_id] || []).push({ ...c, socio_role: r.metadata?.role });
          }
        }
        const seen = new Set();
        for (const m of mandates || []) {
          if (seen.has(m.person_id)) continue;
          seen.add(m.person_id);
          const links = linksByPerson[m.person_id] || [];
          const inaptas = links.filter((c) => c.registration_status && !isSituacaoAtiva(c.registration_status));
          directors.push({
            person_id: m.person_id, name: m.people?.full_name || "?",
            agency: m.agencies?.acronym || null, role: m.role || null, since: m.started_at || null,
            socio_links: links.length, inaptas: inaptas.length,
            companies: links.slice(0, 5).map((c) => ({ cnpj: c.cnpj, legal_name: c.legal_name, status: c.registration_status, role: c.socio_role }))
          });
          // Risco: dirigente ativo com vinculo societario (porta giratoria).
          if (links.length) {
            risks.push({
              kind: "porta_giratoria", person_id: m.person_id, name: m.people?.full_name || "?",
              agency: m.agencies?.acronym || null, role: m.role || null,
              companies: links.length, inaptas: inaptas.length,
              severity: inaptas.length ? "high" : "medium"
            });
          }
        }
        directors.sort((a, b) => (b.inaptas - a.inaptas) || (b.socio_links - a.socio_links));
        risks.sort((a, b) => (b.inaptas - a.inaptas) || (b.companies - a.companies));
        return { directors, risks };
      }

      // 4) Memo — oportunidades: contratos a vencer + consultas abertas. O filtro
      //    por agencia-alvo vai DENTRO da query (antes do limit), senao o
      //    .limit(40) global descartaria consultas da agencia-alvo alem do top-40.
      async function computeOpportunities() {
        let consultasQuery = supabase.from("documents")
          .select("title, published_at, source_url, agency_id, agencies(acronym)")
          .eq("source_name", "DOU").gte("published_at", since45)
          .or("title.ilike.%consulta p%,title.ilike.%audi%,title.ilike.%tomada de subs%");
        if (targetIds.length) consultasQuery = consultasQuery.in("agency_id", targetIds);
        consultasQuery = consultasQuery.order("published_at", { ascending: false }).limit(40);

        const [contractsR, consultasR] = await Promise.all([
          targetIds.length
            ? supabase.from("contracts")
                .select("object, supplier_name, ends_at, value, agencies(acronym)")
                .in("agency_id", targetIds).gte("ends_at", today).lte("ends_at", in90)
                .order("ends_at").limit(30)
            : Promise.resolve({ data: [] }),
          consultasQuery
        ]);
        // Rede de seguranca (targetIds vazio => mantem tudo; senao ja veio filtrado).
        const consultas = (consultasR.data || []).filter((d) => !targetIds.length || targetIds.includes(d.agency_id));
        return [
          ...(contractsR.data || []).map((c) => ({
            kind: "contrato_vencendo", label: (c.object || "Contrato").slice(0, 140),
            supplier: c.supplier_name || null, agency: c.agencies?.acronym || null,
            ends_at: c.ends_at, value: c.value || null
          })),
          ...consultas.map((d) => ({
            kind: "consulta_aberta", label: d.title, agency: d.agencies?.acronym || null,
            date: d.published_at, link: d.source_url
          }))
        ];
      }

      // Briefing e oportunidades sao independentes -> em paralelo (corta latencia).
      const [{ directors, risks }, opportunities] = await Promise.all([
        computeBriefing(), computeOpportunities()
      ]);

      return res.status(200).json({
        ok: true, type: "deal_dossier", theme: theme || null, days,
        landscape_ready: landscape.ready,
        target_agencies: targetAgencies.map((a) => ({ acronym: a.acronym, name: a.name })),
        landscape: { distribution: landscape.distribution, by_agency: landscape.by_agency, total: landscape.total },
        directors, risks, opportunities, counterparty,
        generated_at: new Date().toISOString()
      });
    }

    // Narrativa IA COMERCIAL sobre o dossie composto (o front envia o payload de
    // type=deal_dossier no body). Degrada sem ANTHROPIC_API_KEY (skipped).
    if (type === "deal_narrative") {
      res.setHeader("Cache-Control", "no-store");
      if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST com o dossie no body." });
      const { narrateDeal } = require("../lib/anthropic");
      const payload = req.body && typeof req.body === "object" ? req.body : null;
      if (!payload) return res.status(400).json({ ok: false, error: "Body JSON ausente." });
      const ai = await narrateDeal(payload);
      return res.status(200).json({ ok: true, ...ai });
    }

    // Resumo executivo IA do dossie de EMPRESA (o front envia o dossie compacto
    // ja montado em state; o de pessoa usa /api/dossier-person?id=&ai=1).
    if (type === "exec_summary") {
      res.setHeader("Cache-Control", "no-store");
      if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST com o dossie no body." });
      const { summarizeDossier } = require("../lib/anthropic");
      const dossier = req.body && typeof req.body === "object" ? req.body : null;
      if (!dossier) return res.status(400).json({ ok: false, error: "Body JSON ausente." });
      const ai = await summarizeDossier(dossier);
      return res.status(200).json({ ok: true, ...ai });
    }

    if (type === "search") {
      const q = String(req.query.q || "").trim();
      if (!q) return res.status(400).json({ ok: false, error: "Informe ?q=termo" });
      const agency = req.query.agency ? String(req.query.agency).toUpperCase() : null;
      const limit = Math.min(Number(req.query.limit) || 30, 100);
      const sel = "id, title, document_type, published_at, source_url, metadata, agencies(acronym)";

      // Filtro por agencia DENTRO da query (antes do limit) — resolve sigla->id.
      // Senao o ?agency= filtraria so o top-N global e poderia dar 0 indevidamente.
      let agencyId = null;
      if (agency) {
        const { data: ag } = await supabase.from("agencies").select("id").eq("acronym", agency).maybeSingle();
        if (!ag) return res.status(200).json({ ok: true, type: "search", q, engine: "none", total: 0, items: [] });
        agencyId = ag.id;
      }
      const base = () => {
        let query = supabase.from("documents").select(sel).eq("source_name", "DOU");
        if (agencyId) query = query.eq("agency_id", agencyId);
        return query;
      };

      // Busca full-text nativa (M17): tokeniza, stemming pt, operadores websearch
      // ("frase exata", -exclui, OR). Ordenado por recencia. Fallback ILIKE se a
      // coluna search_tsv ainda nao existir (migracao M17 nao aplicada -> {error}).
      let engine = "fts";
      let result = await base().textSearch("search_tsv", q, { type: "websearch", config: "portuguese" })
        .order("published_at", { ascending: false }).limit(limit);
      if (result.error) {
        engine = "ilike";
        const term = `%${q.replace(/\s+/g, "%")}%`;
        result = await base().ilike("extracted_text", term)
          .order("published_at", { ascending: false }).limit(limit);
      }
      const items = (result.data || []).map((d) => ({
        id: d.id, title: d.title, type: d.document_type, date: d.published_at,
        agency: d.agencies?.acronym || d.metadata?.agency_acronym || "?", link: d.source_url
      }));
      return res.status(200).json({ ok: true, type: "search", q, engine, total: items.length, items });
    }

    if (type === "alerts") {
      const limit = Math.min(Number(req.query.limit) || 20, 100);
      const { data: alerts } = await supabase
        .from("alerts")
        .select("id, alert_type, severity, title, body, created_at, metadata")
        .is("acknowledged_at", null)
        .order("created_at", { ascending: false })
        .limit(limit);
      return res.status(200).json({ ok: true, type: "alerts", items: alerts || [] });
    }

    return res.status(400).json({ ok: false, error: "type invalido. Use: radar, radar_intel, correlations, trends_anomalies, landscape, deal_dossier, deal_narrative, score, daily, trend, recent, giratoria, political_risk, search, alerts, agency_stats, dismiss_alert, monitors, monitor_save, monitor_toggle, monitor_delete, monitor_alerts, holdings, exec_summary, auth_config, refresh, data_health" });
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message });
  }
};
