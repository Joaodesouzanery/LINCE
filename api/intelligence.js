// Motor de Inteligencia Nacional: score de risco por setor/agencia,
// radar de normas dos proximos 30/60/90 dias, resumo executivo diario,
// monitores de vigilancia (CRUD), Gerador de Dossie Comercial (landscape por
// tema, dossie de deal e narrativa IA) e resumo executivo de dossie por IA.
// GET /api/intelligence?type=overview|radar|score|daily|landscape|deal_dossier|monitors|monitor_alerts|holdings
// POST /api/intelligence?type=monitor_save|monitor_toggle|monitor_delete|deal_narrative|exec_summary
const { getSupabase } = require("../lib/supabase");
const { normalizeName, onlyDigits, isSituacaoAtiva } = require("../lib/text");
const { buildOverview } = require("../lib/overview");

// Mutacoes e listas de monitor aceitam POST (body JSON) ou GET (querystring).
function params(req) {
  return req.method === "POST" && req.body && typeof req.body === "object" ? req.body : req.query;
}

// ── Analise semanal compartilhada (trends_anomalies + correlations) ─────────
// Agrega os atos do DOU das ultimas N semanas por agencia x semana x tipo e
// detecta anomalias: PICO (semana atual >= 2x o baseline) e SILENCIO (agencia
// ativa que zerou). Baseline = media das semanas anteriores a atual.
// onlyAgencyIds (opcional): restringe o scan às agências dadas — o painel_get usa
// p/ não paginar o corpus DOU inteiro (20k+ linhas) a cada abertura de painel.
async function weeklyAgencyAnalysis(supabase, weeks = 8, onlyAgencyIds = null) {
  const since = new Date(Date.now() - weeks * 7 * 86400000).toISOString().slice(0, 10);
  let agQuery = supabase.from("agencies").select("id, acronym, name").eq("sector", "regulatory");
  if (onlyAgencyIds && onlyAgencyIds.length) agQuery = agQuery.in("id", onlyAgencyIds);
  const { data: agencies } = await agQuery;
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
    let q = supabase
      .from("documents")
      .select("agency_id, published_at, document_type")
      .eq("source_name", "DOU")
      .gte("published_at", since);
    if (onlyAgencyIds && onlyAgencyIds.length) q = q.in("agency_id", onlyAgencyIds);
    const { data } = await q
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
  // F-INT1 (F2): PRO-RATA da semana parcial — numa quinta, a semana atual tem ~4/7 dos
  // atos e o teste de pico (current >= 2x baseline) quase nunca disparava a tempo.
  // Projeta current p/ 7 dias SO no teste de pico; o valor exibido segue o real.
  // Com <3 dias decorridos NAO projeta (domingo x7 = falso pico garantido).
  const daysElapsed = Math.max(1, new Date().getUTCDay() + 1); // dom=1 ... sab=7
  const canProject = daysElapsed >= 3;
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
      const projected = canProject ? Math.round((current / daysElapsed) * 7 * 10) / 10 : current; // pro-rata 7d
      if (baseline >= 2 && current >= 5 && projected >= baseline * 2) {
        anomalies.push({ agency: ag.acronym, metric, kind: "pico", current, projected, baseline: Math.round(baseline * 10) / 10, ratio: Math.round((projected / baseline) * 10) / 10 });
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
    // A rota /api/ingest-dou pula IA e extracao de pessoas por padrao (ver la o
    // porque), entao o range voltou a caber no orcamento — o caveat antigo sobre
    // analyzeAto estourar 60s nao se aplica mais a este caminho.
    //
    // Datas em America/Sao_Paulo: toISOString() e UTC e depois das 21h de Brasilia
    // pediria a edicao de AMANHA, que nao existe.
    const emSP = (d) => new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit"
    }).format(d);
    const dates = [];
    if (req.query.date) {
      dates.push(String(req.query.date));
    } else {
      const n = Math.min(5, Math.max(1, parseInt(req.query.days, 10) || 1));
      const agora = Date.now();
      for (let i = 0; i < n; i++) dates.push(emSP(new Date(agora - i * 86400000)));
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

    if (type === "overview") {
      // M31 — payload unico da Visao Geral. Substitui as 7 chamadas que a tela
      // fazia (trend + data_health + recent + score + daily + radar + alerts).
      // s-maxage curto: a tela e a primeira coisa que abre e o usuario espera
      // ver o efeito do botao "Atualizar" (que manda ?t= para furar a borda).
      res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=600");
      const payload = await buildOverview(supabase, { days: req.query.days });
      return res.status(200).json({ ...payload, type: "overview" });
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
      // F-INT1 (F2 — "honesto e simples"): a versao min-max sempre produzia um 100 e um 0
      // (mesmo com tudo calmo) e era dominada por VOLUME disfarçado de risco. Agora sao
      // DOIS numeros com nome honesto, sem normalizacao escondida:
      //   atividade_90d = volume de publicacao (nao e risco)
      //   sinais        = alertas ponderados (TTL 180d; alertas de PESSOA contam no
      //                   bucket da agencia via metadata.agency_id — antes eram perdidos)
      const { data: agencies } = await supabase.from("agencies").select("id, acronym, name").eq("sector", "regulatory");
      const since90 = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
      const since180 = new Date(Date.now() - 180 * 86400000).toISOString(); // TTL: alerta velho nao conta p/ sempre
      const SEV_WEIGHT = { high: 3, medium: 2, info: 1, low: 1 };
      const agIds = (agencies || []).map((a) => a.id);

      if (!agIds.length) return res.status(200).json({ ok: true, type: "score", window_days: 90, alert_ttl_days: 180, scores: [] });
      // Alerts paginados (teto default de 1000 do PostgREST) em ordem ESTAVEL
      // (created_at desc: com >CAP alertas, os descartados sao os mais antigos).
      async function fetchOpenAlerts() {
        const rows = []; const CAP = 10000;
        for (let from = 0; from < CAP; from += 1000) {
          const { data } = await supabase.from("alerts")
            .select("target_id, target_kind, severity, alert_type, metadata, created_at")
            .is("acknowledged_at", null).gte("created_at", since180)
            .order("created_at", { ascending: false }).order("id", { ascending: false })
            .range(from, from + 999);
          rows.push(...(data || []));
          if (!data || data.length < 1000) break;
        }
        return { rows, truncated: rows.length >= CAP };
      }
      const [docTotals, doc90s, alertsPage, mandatesRes] = await Promise.all([
        Promise.all(agIds.map((id) => supabase.from("documents")
          .select("id", { count: "exact", head: true }).eq("agency_id", id).eq("source_name", "DOU"))),
        Promise.all(agIds.map((id) => supabase.from("documents")
          .select("id", { count: "exact", head: true }).eq("agency_id", id).eq("source_name", "DOU").gte("published_at", since90))),
        fetchOpenAlerts(),
        supabase.from("mandates").select("agency_id, person_id").is("ended_at", null).in("agency_id", agIds).limit(5000)
      ]);
      const alertsRes = { data: alertsPage.rows };
      const agIdSet = new Set(agIds);
      const alertsByAgency = {}, directorsByAgency = {}, directorsSeen = {};
      for (const m of mandatesRes.data || []) {
        const seen = (directorsSeen[m.agency_id] = directorsSeen[m.agency_id] || new Set());
        if (m.person_id && seen.has(m.person_id)) continue; // pessoa com 2 mandatos = 1 diretor
        if (m.person_id) seen.add(m.person_id);
        directorsByAgency[m.agency_id] = (directorsByAgency[m.agency_id] || 0) + 1;
      }
      for (const a of alertsRes.data || []) {
        // bucket: alerta de agencia -> target_id; alerta de pessoa (nomeacao/exoneracao/
        // monitor) -> agency_id da metadata (gravado na ingestao).
        const agId = agIdSet.has(a.target_id) ? a.target_id : (a.metadata?.agency_id && agIdSet.has(a.metadata.agency_id) ? a.metadata.agency_id : null);
        if (agId) (alertsByAgency[agId] = alertsByAgency[agId] || []).push(a);
      }

      const scores = (agencies || []).map((ag, i) => {
        const openAlerts = alertsByAgency[ag.id] || [];
        const sinais = openAlerts.reduce((s, a) => s + (SEV_WEIGHT[a.severity] || 1), 0);
        const porTipo = {};
        for (const a of openAlerts) { const k = a.alert_type || "outro"; porTipo[k] = (porTipo[k] || 0) + 1; }
        return {
          id: ag.id, // usado pelo select de órgãos do painel (painel_item_add exige o uuid)
          agency: ag.acronym, name: ag.name,
          docs: docTotals[i]?.count || 0, atividade_90d: doc90s[i]?.count || 0, docs_90d: doc90s[i]?.count || 0,
          open_alerts: openAlerts.length, sinais, sinais_por_tipo: porTipo,
          active_directors: directorsByAgency[ag.id] || 0
        };
      }).sort((a, b) => (b.sinais - a.sinais) || (b.atividade_90d - a.atividade_90d));
      return res.status(200).json({ ok: true, type: "score", window_days: 90, alert_ttl_days: 180, alerts_truncated: alertsPage.truncated, scores });
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
      // F-INT1 (F2): R$ agregado — total de contratos a vencer por janela (o numero que
      // faltava: contrato de R$ 2 mil pesava igual a R$ 200 mi).
      const valor_total = {};
      for (const w of ["30d", "60d", "90d"]) valor_total[w] = radar[w].filter((e) => e.type === "contrato").reduce((s, e) => s + (Number(e.value) || 0), 0);
      valor_total.total = valor_total["30d"] + valor_total["60d"] + valor_total["90d"];
      return res.status(200).json({ ok: true, type: "radar", truncated, valor_total, radar });
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

      // ATENCAO: relationships e POLIMORFICA (to_id sem FK) -> embed `companies(...)`
      // devolve PGRST200 ("Could not find a relationship..."), o erro era engolido pelo
      // `|| []` e a lista de casos saia SEMPRE vazia. Resolve as empresas em 2a query,
      // como o political_risk ja faz.
      // .in() em CHUNKS: com centenas de person_id a URL do PostgREST estoura e a
      // query inteira falha (personIds cresce a cada ingestao de ato de pessoal).
      const socioRels = [];
      for (let i = 0; i < personIds.length; i += 200) {
        const { data, error } = await supabase.from("relationships").select("from_id, to_id, metadata")
          .eq("from_kind", "person").eq("to_kind", "company").eq("relationship", "socio")
          .in("from_id", personIds.slice(i, i + 200));
        if (error) return res.status(500).json({ ok: false, error: error.message });
        socioRels.push(...(data || []));
      }
      const partyRows = [];
      for (let i = 0; i < personIds.length; i += 200) {
        const { data } = await supabase.from("party_links").select("person_id, party").in("person_id", personIds.slice(i, i + 200));
        partyRows.push(...(data || []));
      }
      const partyRes = { data: partyRows };
      const socioCompById = {};
      {
        const ids = [...new Set(socioRels.map((r) => r.to_id).filter(Boolean))];
        for (let i = 0; i < ids.length; i += 200) {
          const { data: comps } = await supabase.from("companies")
            .select("id, cnpj, legal_name, registration_status").in("id", ids.slice(i, i + 200));
          for (const c of comps || []) socioCompById[c.id] = c;
        }
      }

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
        .push({ company_id: r.to_id, company: socioCompById[r.to_id]?.legal_name, cnpj: socioCompById[r.to_id]?.cnpj, role: r.metadata?.role });

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
        let selfDealingValue = 0; // F-INT1 (F2): R$ dos contratos self-dealing (dimensiona o caso)
        let best = null; // o mandato que evidencia o caso (prioridade: self-dealing > ativo > mais recente)
        for (const m of ms) {
          for (const s of socios) {
            const ags = supplierAgencies[s.company_id];
            if (!ags || !m.agency_id || !ags[m.agency_id]) continue;
            const key = `${s.company_id}|${m.agency_id}`;
            if (!selfKeys.has(key)) {
              selfKeys.add(key); selfDealing.push({ ...s, agency: m.agencies?.acronym });
              selfDealingValue += ags[m.agency_id].reduce((sum, c) => sum + (Number(c.value) || 0), 0);
            }
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
          companies: socios, self_dealing: selfDealing, self_dealing_value: selfDealingValue, public_supplier: publicSupplier,
          contract_during_mandate: duringMandate,
          parties: partyByPerson[personId] || [], severity,
          rationale: selfDealing.length
            ? `Sócio de ${selfDealing.length} fornecedor(es) da PRÓPRIA agência que dirige/dirigiu${duringMandate ? " — com contrato assinado durante o mandato" : ""}`
            : (publicSupplier.length ? "Sócio de fornecedor público (outra agência)" : "Vínculo societário durante o mandato")
        });
      }
      // Contrato assinado DURANTE o mandato primeiro (o timing e o agravante), depois
      // self-dealing por QUANTIDADE e por R$ (F2), depois rede.
      cases.sort((a, b) => ((b.contract_during_mandate ? 1 : 0) - (a.contract_during_mandate ? 1 : 0)) || (b.self_dealing.length - a.self_dealing.length) || ((b.self_dealing_value || 0) - (a.self_dealing_value || 0)) || (b.companies.length - a.companies.length));
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
      // Fase 1: destinatario do alerta por e-mail (vazio limpa).
      if (p.owner_email !== undefined) {
        const em = String(p.owner_email || "").trim();
        if (em && !em.includes("@")) return res.status(400).json({ ok: false, error: "E-mail invalido." });
        row.owner_email = em ? em.slice(0, 200) : null;
      }
      // F-INT1: cpf_cnpj SEMPRE recalculado (limpa o antigo se o padrao deixou de ser CNPJ/CPF).
      const digits = onlyDigits(p.cpf_cnpj || pattern);
      row.cpf_cnpj = (digits.length === 11 || digits.length === 14) ? digits : null;
      // kind=agency: resolve a sigla para agency_id (match por UUID no cron).
      if (kind === "agency") {
        const { data: ag } = await supabase.from("agencies").select("id, acronym").eq("acronym", normalized.replace(/\s+/g, "")).maybeSingle();
        if (!ag) return res.status(400).json({ ok: false, error: `Agencia "${pattern}" nao encontrada. Use a sigla (ex.: ANEEL).` });
        row.agency_id = ag.id;
      }
      const gravar = async (r) => (p.id
        ? supabase.from("monitors").update(r).eq("id", p.id).select().maybeSingle()
        : supabase.from("monitors").insert(r).select().maybeSingle());
      let result = await gravar(row);
      // Se a coluna owner_email ainda nao existe no banco (migration pendente),
      // grava sem ela em vez de derrubar a criacao do monitor inteira.
      if (result.error && /owner_email/.test(result.error.message || "")) {
        const { owner_email, ...semEmail } = row;
        result = await gravar(semEmail);
        if (!result.error) result.warn = "Coluna monitors.owner_email ausente — aplique o schema para habilitar alerta por e-mail.";
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
      return res.status(200).json({ ok: true, monitor: result.data, backfill_hits: backfillHits, backfill_error: backfillError, warn: result.warn || null });
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
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      // Janela relativa. Whitelist para valor invalido cair no default em vez de
      // virar NaN na comparacao de data. created_at e a hora da COLETA (nao do fato)
      // — aqui e o correto: o feed responde "o que meus monitores dispararam".
      const DIAS = [1, 7, 15, 30, 90];
      const pedido = Number(req.query.days);
      const days = DIAS.includes(pedido) ? pedido : 7;
      const desde = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);

      let q = supabase
        .from("alerts")
        .select("id, alert_type, severity, title, body, created_at, metadata, acknowledged_at")
        .eq("alert_type", "monitor")
        .gte("created_at", `${desde}T00:00:00Z`)
        .order("created_at", { ascending: false })
        .limit(limit);
      const { data, error } = await q;
      if (error) return res.status(500).json({ ok: false, error: error.message });
      // total do periodo por COUNT: sem ele, "50 alertas" seria o teto do limit
      // exibido como se fosse o universo.
      const { count } = await supabase
        .from("alerts").select("id", { count: "exact", head: true })
        .eq("alert_type", "monitor").gte("created_at", `${desde}T00:00:00Z`);
      return res.status(200).json({
        ok: true, days, desde, total: count ?? (data || []).length,
        truncated: (data || []).length >= limit, items: data || []
      });
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

      // F-INT1 (F3): o painel passa a ser ALIMENTADO pela camada de inteligencia —
      // anomalias, contratos a vencer e consultas abertas dos ORGAOS do painel.
      // Tudo best-effort: painel sem orgaos ou tabela ausente degrada para vazio.
      const inteligencia = { anomalias: [], contratos_vencendo: [], consultas: [] };
      const orgaoIds = [...orgaoMap.keys()];
      if (orgaoIds.length) {
        const acrOf = new Set([...orgaoMap.values()].map((o) => o.acronym).filter(Boolean));
        const todayIso = new Date().toISOString().slice(0, 10);
        const in90Iso = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
        const since45Iso = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
        const [anomP, ctsP, consP] = await Promise.allSettled([
          // scan restrito às agências do painel (sem o filtro seriam 20k+ linhas por request)
          weeklyAgencyAnalysis(supabase, 8, orgaoIds),
          supabase.from("contracts").select("object, supplier_name, value, ends_at, agencies(acronym)")
            .in("agency_id", orgaoIds).gte("ends_at", todayIso).lte("ends_at", in90Iso)
            .order("value", { ascending: false, nullsFirst: false }).limit(10),
          supabase.from("documents").select("title, published_at, source_url, agencies(acronym)")
            .eq("source_name", "DOU").in("agency_id", orgaoIds).gte("published_at", since45Iso)
            .or("title.ilike.%consulta publica%,title.ilike.%consulta pública%,title.ilike.%audiencia publica%,title.ilike.%audiência pública%,title.ilike.%tomada de subs%")
            .order("published_at", { ascending: false }).limit(10)
        ]);
        if (anomP.status === "fulfilled") {
          inteligencia.anomalias = (anomP.value.anomalies || []).filter((a) => acrOf.has(a.agency)).slice(0, 6);
        }
        if (ctsP.status === "fulfilled") {
          inteligencia.contratos_vencendo = (ctsP.value.data || []).map((c) => ({
            object: (c.object || "Contrato").slice(0, 120), supplier: c.supplier_name || null,
            value: c.value, ends_at: c.ends_at, agency: c.agencies?.acronym || null
          }));
        }
        if (consP.status === "fulfilled") {
          inteligencia.consultas = (consP.value.data || []).map((d) => ({
            title: d.title, date: d.published_at, link: d.source_url, agency: d.agencies?.acronym || null
          }));
        }
      }

      // F-INT1 (F3): COMISSAO x PAUTA — stakeholder do painel que integra o colegiado
      // onde uma proposicao do painel esta na pauta (chave natural: orgao_sigla).
      let comissao_pauta = [];
      const eventSiglas = new Set(agenda.map((a) => a.evento?.orgao_sigla).filter(Boolean));
      const stakeIds = [...stakeMap.keys()];
      if (eventSiglas.size && stakeIds.length) {
        const { data: bms } = await supabase.from("body_memberships")
          .select("person_id, orgao_sigla, orgao_nome, cargo").in("person_id", stakeIds).limit(1000);
        // Presidente/relator primeiro TAMBEM no dedup (senao "suplente" podia vencer).
        const pesoCargo = (c) => /presi/i.test(c || "") ? 0 : /relat|vice/i.test(c || "") ? 1 : 2;
        const seenCp = new Set(); // pessoa com 2 cargos no MESMO orgao (titular+suplente) duplicava o card
        for (const bm of (bms || []).slice().sort((a, b) => pesoCargo(a.cargo) - pesoCargo(b.cargo))) {
          if (!eventSiglas.has(bm.orgao_sigla)) continue;
          const cpKey = `${bm.person_id}|${bm.orgao_sigla}`;
          if (seenCp.has(cpKey)) continue;
          seenCp.add(cpKey);
          const matches = agenda.filter((a) => a.evento?.orgao_sigla === bm.orgao_sigla);
          for (const a of matches.slice(0, 3)) {
            comissao_pauta.push({
              person_id: bm.person_id, nome: (stakeMap.get(String(bm.person_id)) || {}).full_name || null,
              cargo: bm.cargo || null, orgao_sigla: bm.orgao_sigla, orgao_nome: bm.orgao_nome || null,
              prop_titulo: a.prop_titulo, data_inicio: a.evento?.data_inicio || null
            });
          }
        }
        // Presidente/relator primeiro — e o alerta mais acionavel do painel.
        comissao_pauta = comissao_pauta.sort((a, b) => pesoCargo(a.cargo) - pesoCargo(b.cargo)).slice(0, 12);
      }

      return res.status(200).json({ ok: true, painel, proposicoes, stakeholders, orgaos, agenda, noticias, inteligencia, comissao_pauta, counts: { proposicoes: proposicoes.length, stakeholders: stakeholders.length, orgaos: orgaos.length, agenda: agenda.length, noticias: noticias.length } });
    }

    if (type === "painel_save") {
      res.setHeader("Cache-Control", "no-store");
      const p = params(req);
      // UPDATE = PATCH PARCIAL (so os campos enviados). Antes reconstruia a linha
      // inteira: salvar a marca white-label zerava owner_email/webhook_url/frequencia.
      if (p.id) {
        const patch = { updated_at: new Date().toISOString() };
        if (p.nome !== undefined) {
          const nome = String(p.nome).trim();
          if (nome.length < 2) return res.status(400).json({ ok: false, error: "Informe o nome do painel." });
          patch.nome = nome;
        }
        if (p.cliente !== undefined) patch.cliente = p.cliente ? String(p.cliente).slice(0, 200) : null;
        if (p.descricao !== undefined) patch.descricao = p.descricao ? String(p.descricao).slice(0, 1000) : null;
        if (p.tema !== undefined) patch.tema = Array.isArray(p.tema) ? p.tema : null;
        if (p.webhook_url !== undefined) patch.webhook_url = p.webhook_url ? String(p.webhook_url).slice(0, 500) : null;
        if (p.frequencia !== undefined && ["tempo_real", "diario", "off"].includes(p.frequencia)) patch.frequencia = p.frequencia;
        if (p.owner_email !== undefined) patch.owner_email = p.owner_email ? String(p.owner_email).slice(0, 200) : null;
        if (p.metadata && typeof p.metadata === "object" && !Array.isArray(p.metadata)) {
          const { data: cur, error: cErr } = await supabase.from("paineis").select("metadata").eq("id", String(p.id)).maybeSingle();
          if (cErr) return res.status(500).json({ ok: false, error: cErr.message }); // sem isso um erro de leitura viraria overwrite total
          patch.metadata = { ...((cur && cur.metadata) || {}), ...p.metadata }; // merge (nao perde outras chaves)
        }
        const { data, error } = await supabase.from("paineis").update(patch).eq("id", String(p.id)).select().maybeSingle();
        if (error) return res.status(500).json({ ok: false, error: error.message });
        if (!data) return res.status(404).json({ ok: false, error: "Painel nao encontrado." });
        return res.status(200).json({ ok: true, painel: data });
      }
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
      const { data, error } = await supabase.from("paineis").insert(row).select().maybeSingle();
      if (error) return res.status(500).json({ ok: false, error: error.message });
      return res.status(200).json({ ok: true, painel: data });
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
      // Fase 1 (1C): branding WHITE-LABEL vem de metadata.brand — whitelist explicita
      // (o resto do metadata segue interno: saldos, config, cursores).
      const b = (digest.painel.metadata && digest.painel.metadata.brand) || {};
      const safeHttps = (u) => { try { const x = new URL(String(u)); return x.protocol === "https:" ? x.href : null; } catch { return null; } };
      const pub = {
        nome: digest.painel.nome, cliente: digest.painel.cliente, descricao: digest.painel.descricao,
        brand: {
          logo_url: safeHttps(b.logo_url),
          cor: /^#[0-9a-f]{6}$/i.test(String(b.cor || "")) ? b.cor : null,
          titulo: b.titulo ? String(b.titulo).slice(0, 120) : null,
          rodape: b.rodape ? String(b.rodape).slice(0, 200) : null,
          ocultar_marca: !!b.ocultar_marca
        }
      };
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

      const [partyRes, mandatesRes, socioRes, donationsRes] = await Promise.all([
        supabase.from("party_links").select("party, link_type, amount, reference_year").eq("person_id", id),
        supabase.from("mandates").select("agency_id, role, started_at, ended_at").eq("person_id", id),
        // relationships e polimorfica (to_id sem FK) -> NAO da para usar embed
        // companies(...). Busca so os ids/metadata e resolve as empresas depois.
        supabase.from("relationships")
          .select("to_id, metadata")
          .eq("from_kind", "person").eq("from_id", id)
          .eq("to_kind", "company").eq("relationship", "socio"),
        // F-INT1 (F2): doacoes REAIS (a tabela boa, com valor/tipo/ano) — antes o
        // componente partidario contava LINHAS de filiacao (2 filiacoes antigas = teto).
        supabase.from("campaign_donations").select("amount, donor_type, reference_year").eq("recipient_person_id", id).order("reference_year", { ascending: false, nullsFirst: false }).limit(5000)
      ]);

      const parties = partyRes.data || [];
      const mandates = mandatesRes.data || [];
      const socioRels = socioRes.data || [];
      const donations = donationsRes.data || [];
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

      // SELF-DEALING com OVERLAP TEMPORAL (F2): a empresa-socio fornece a agencia
      // que a pessoa dirige/dirigiu, com contrato assinado DENTRO da janela do mandato.
      // (Antes: contrato de 2015 x mandato de 2022 pontuava 35 — sem relacao temporal.)
      const socioCompanyIds = [...new Set(socioRels.map((r) => r.to_id).filter(Boolean))];
      const selfDealingCompanies = []; const supplierNoOverlap = [];
      let selfDealingValue = 0;
      if (socioCompanyIds.length && mandates.length) {
        // Ordem por signed_at desc (estavel/relevante): se o teto de 1000 do PostgREST
        // cortar, ficam os contratos recentes — os que importam p/ overlap de mandato.
        const { data: cts } = await supabase.from("contracts")
          .select("supplier_company_id, agency_id, signed_at, value")
          .in("supplier_company_id", socioCompanyIds)
          .order("signed_at", { ascending: false, nullsFirst: false }).limit(5000);
        const flaggedOverlap = new Set(), flaggedAny = new Set();
        for (const c of cts || []) {
          if (!c.supplier_company_id || !c.agency_id) continue;
          for (const m of mandates) {
            if (m.agency_id !== c.agency_id) continue;
            flaggedAny.add(c.supplier_company_id);
            const inWindow = c.signed_at && m.started_at && c.signed_at >= m.started_at && (!m.ended_at || c.signed_at <= m.ended_at);
            // break: o valor do contrato conta UMA vez (reconducao/mandato duplicado
            // na mesma agencia somava o mesmo contrato 2x+).
            if (inWindow) { flaggedOverlap.add(c.supplier_company_id); selfDealingValue += Number(c.value) || 0; break; }
          }
        }
        for (const cid of flaggedOverlap) selfDealingCompanies.push(companiesById[cid]?.legal_name || cid);
        for (const cid of flaggedAny) if (!flaggedOverlap.has(cid)) supplierNoOverlap.push(companiesById[cid]?.legal_name || cid);
      }

      // Financiamento politico (F2): doacoes reais com DECAIMENTO (>8 anos pesa metade).
      const currentYear = new Date().getFullYear();
      let doacoesEfetivas = 0, doacoesTotal = 0;
      for (const d of donations) {
        const v = Number(d.amount) || 0;
        doacoesTotal += v;
        doacoesEfetivas += (d.reference_year && currentYear - d.reference_year > 8) ? v * 0.5 : v;
      }
      const financiamento = doacoesEfetivas >= 500000 ? 30 : doacoesEfetivas >= 50000 ? 20 : doacoesEfetivas > 0 ? 10 : (parties.length ? 5 : 0);

      // Patrimonio declarado (TSE) — sinal EXIBIDO com evolucao por ano (nao pontua).
      const { data: assetsRows } = await supabase.from("assets").select("value, reference_year").eq("person_id", id).order("reference_year", { ascending: false, nullsFirst: false }).limit(5000);
      let patrimonio = 0; const patrimonioPorAno = {};
      for (const a of assetsRows || []) {
        const v = Number(a.value) || 0; patrimonio += v;
        if (a.reference_year) patrimonioPorAno[a.reference_year] = (patrimonioPorAno[a.reference_year] || 0) + v;
      }

      // Componentes 0-100 (transparentes: o front exibe o detalhamento).
      // financiamento max 30 · self_dealing 35 (overlap) / 15 (fornece sem overlap) /
      // 8 (socio + mandato ativo) · rede max 20 · inaptas max 15.
      const components = {
        financiamento_politico: financiamento,
        self_dealing: selfDealingCompanies.length ? 35 : (supplierNoOverlap.length ? 15 : (activeMandate && socio.length ? 8 : 0)),
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
          doacoes: { total: doacoesTotal, efetivo_com_decaimento: Math.round(doacoesEfetivas), n: donations.length },
          active_mandate: activeMandate,
          mandate_count: mandates.length,
          self_dealing_companies: selfDealingCompanies,
          self_dealing_value: selfDealingValue,
          supplier_no_overlap: supplierNoOverlap,
          patrimonio_declarado: patrimonio,
          patrimonio_por_ano: patrimonioPorAno,
          companies: socio.map((r) => ({
            cnpj: r.companies?.cnpj, legal_name: r.companies?.legal_name,
            status: r.companies?.registration_status, role: r.metadata?.role
          })),
          inactive_companies: inactiveCompanies
        }
      });
    }

    // Radar de Risco & Oportunidade (estilo Arko + Sherlocker).
    // F-INT1 (F2): o painel de RISCOS agora vem de type=giratoria (motor forte, com
    // contratos + severity) — o computeRisks fraco ("tem CNPJ" = risco) foi removido.
    // Aqui ficam: (1) contratos a vencer, (2) consultas abertas, (3) proposicoes.
    if (type === "radar_intel") {
      res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=1800");
      const today = new Date().toISOString().slice(0, 10);
      const in90 = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
      const since45 = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);

      // OPORTUNIDADE — contratos a vencer nos proximos 90 dias, MAIORES primeiro
      // (F2: R$ manda; antes a ordem era so cronologica).
      async function computeContracts() {
        const { data } = await supabase.from("contracts")
          .select("object, supplier_name, ends_at, value, agencies(acronym)")
          .gte("ends_at", today).lte("ends_at", in90)
          .order("value", { ascending: false, nullsFirst: false }).order("ends_at").limit(40);
        return (data || []).map((c) => ({
          kind: "contrato_vencendo", label: (c.object || "Contrato").slice(0, 140),
          supplier: c.supplier_name || null, agency: c.agencies?.acronym || null,
          ends_at: c.ends_at, value: c.value || null
        }));
      }

      // OPORTUNIDADE — consultas/audiencias publicas abertas (dos atos do DOU).
      // F2: full-text (search_tsv, stemming pt) no lugar de %audi% (que casava
      // "auditoria", "auditor"...). Fallback ILIKE se a migracao M17 nao existir.
      async function computeConsultas() {
        const sel = "title, published_at, source_url, agencies(acronym)";
        let r = await supabase.from("documents").select(sel)
          .eq("source_name", "DOU").gte("published_at", since45)
          // Acentos IMPORTAM: o tsvector 'portuguese' preserva acento ("públic" != "public").
          // Os atos do DOU vem acentuados; as variantes sem acento cobrem texto degradado.
          .textSearch("search_tsv", '"consulta pública" OR "consulta publica" OR "audiência pública" OR "audiencia publica" OR "tomada de subsídios" OR "tomada de subsidios"', { type: "websearch", config: "portuguese" })
          .order("published_at", { ascending: false }).limit(25);
        if (r.error) {
          r = await supabase.from("documents").select(sel)
            .eq("source_name", "DOU").gte("published_at", since45)
            .or("title.ilike.%consulta publica%,title.ilike.%consulta pública%,title.ilike.%audiencia publica%,title.ilike.%audiência pública%,title.ilike.%tomada de subs%")
            .order("published_at", { ascending: false }).limit(25);
        }
        return (r.data || []).map((d) => ({
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

      const [contractsP, consultasP, legisP] = await Promise.allSettled([
        computeContracts(), computeConsultas(), computeLegislative()
      ]);
      const val = (p) => (p.status === "fulfilled" ? p.value : []);
      const opportunities = [...val(contractsP), ...val(consultasP)];
      const legislative = val(legisP);

      // Cobertura da base societaria. O Radar depende do QSA para achar
      // self-dealing e porta-giratoria; sem este numero a tela so consegue dizer
      // "nada encontrado", que confunde ausencia de SINAL com ausencia de DADO.
      let qsa = null;
      try {
        const [{ count: totalEmp }, { count: semQsa }] = await Promise.all([
          supabase.from("companies").select("id", { count: "exact", head: true }),
          supabase.from("companies").select("id", { count: "exact", head: true }).eq("shareholding", "[]")
        ]);
        if (totalEmp != null) qsa = { total: totalEmp, faltam: semQsa ?? 0 };
      } catch { /* cobertura e informativa: nao derruba o radar */ }

      return res.status(200).json({
        ok: true, type: "radar_intel",
        counts: { opportunities: opportunities.length, legislative: legislative.length },
        qsa_cobertura: qsa,
        // riscos: usar type=giratoria (motor com contratos/severity) — campo mantido
        // vazio p/ compat de payload.
        risks: [], risks_source: "giratoria",
        opportunities, legislative,
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

      // F-INT1 (F2): as correlacoes de ALTO valor viram registros em `alerts` —
      // entram no webhook/central de alertas em vez de existirem so enquanto a tela
      // esta aberta. Dedup manual por metadata->>corr_key (source_document_id NULL
      // nao conflita no indice unico). Best-effort: falha aqui nao derruba a resposta.
      try {
        const persistKinds = new Set(["nomeacao_x_fornecedor", "janela_regulatoria"]);
        const toPersist = out.filter((c) => persistKinds.has(c.kind)).slice(0, 20);
        if (toPersist.length) {
          // janela_regulatoria vem so com o ACRONIMO da agencia — resolve o uuid
          // (alerts.target_id e NOT NULL; sem isso o insert falhava silenciosamente).
          const acrsToResolve = [...new Set(toPersist
            .map((c) => c.entities?.[0]).filter((e) => e && e.kind === "agency" && !e.id && e.label)
            .map((e) => e.label))];
          const agByAcr = {};
          if (acrsToResolve.length) {
            const { data: ags } = await supabase.from("agencies").select("id, acronym").in("acronym", acrsToResolve);
            for (const a of ags || []) agByAcr[a.acronym] = a.id;
          }
          const candidates = toPersist.map((c) => {
            const ent = c.entities?.[0] || {};
            const targetId = ent.id || (ent.kind === "agency" ? agByAcr[ent.label] : null) || null;
            if (!targetId) return null; // target_id e NOT NULL — sem id resolvido, nao persiste
            return {
              corrKey: `${c.kind}:${ent.id || ent.label || c.title.slice(0, 60)}`,
              row: {
                alert_type: "correlacao", severity: c.severity || "medium",
                target_kind: ent.kind === "person" || ent.kind === "company" ? ent.kind : "agency",
                target_id: targetId,
                title: c.title.slice(0, 200), body: (c.evidence || []).join(" · ").slice(0, 500),
                metadata: { kind: c.kind, suggested_action: c.suggested_action || null }
              }
            };
          }).filter(Boolean);
          if (candidates.length) {
            // Dedup em LOTE (1 select) + insert em lote — antes eram ate 40 queries por GET.
            const keys = candidates.map((c) => c.corrKey);
            const { data: dups } = await supabase.from("alerts").select("metadata->>corr_key")
              .eq("alert_type", "correlacao").in("metadata->>corr_key", keys);
            const dupSet = new Set((dups || []).map((d) => d.corr_key));
            const fresh = candidates.filter((c) => !dupSet.has(c.corrKey))
              .map((c) => ({ ...c.row, metadata: { ...c.row.metadata, corr_key: c.corrKey } }));
            if (fresh.length) {
              const { error: insErr } = await supabase.from("alerts").insert(fresh);
              if (insErr) console.error("correlations persist:", insErr.message);
            }
          }
        }
      } catch (e) { console.error("correlations persist:", e?.message); }

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
        // F-INT1 (F3): mesma FTS do radar_intel (acentos importam no tsvector pt;
        // %audi% casava "auditoria"). Fallback ILIKE se a migracao M17 nao existir.
        const consultaSel = "title, published_at, source_url, agency_id, agencies(acronym)";
        const buildConsultas = (useFts) => {
          let cq = supabase.from("documents").select(consultaSel)
            .eq("source_name", "DOU").gte("published_at", since45);
          cq = useFts
            ? cq.textSearch("search_tsv", '"consulta pública" OR "consulta publica" OR "audiência pública" OR "audiencia publica" OR "tomada de subsídios" OR "tomada de subsidios"', { type: "websearch", config: "portuguese" })
            : cq.or("title.ilike.%consulta publica%,title.ilike.%consulta pública%,title.ilike.%audiencia publica%,title.ilike.%audiência pública%,title.ilike.%tomada de subs%");
          if (targetIds.length) cq = cq.in("agency_id", targetIds);
          return cq.order("published_at", { ascending: false }).limit(40);
        };
        let consultasQuery = buildConsultas(true);

        const [contractsR, consultasFtsR] = await Promise.all([
          targetIds.length
            ? supabase.from("contracts")
                .select("object, supplier_name, ends_at, value, agencies(acronym)")
                .in("agency_id", targetIds).gte("ends_at", today).lte("ends_at", in90)
                .order("ends_at").limit(30)
            : Promise.resolve({ data: [] }),
          consultasQuery
        ]);
        const consultasR = consultasFtsR.error ? await buildConsultas(false) : consultasFtsR;
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
      // F-INT1 (F3): risks e SUBCONJUNTO de directors (mesmas pessoas) — dedupa antes
      // do prompt p/ a IA nao contar a mesma pessoa 2x como "decisor" e "risco".
      if (Array.isArray(payload.directors) && Array.isArray(payload.risks)) {
        const riskIds = new Set(payload.risks.map((r) => r.person_id).filter(Boolean));
        payload.directors = payload.directors.filter((d) => !d.person_id || !riskIds.has(d.person_id));
      }
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

    return res.status(400).json({ ok: false, error: "type invalido. Use: overview, radar, radar_intel, correlations, trends_anomalies, landscape, deal_dossier, deal_narrative, score, daily, trend, recent, giratoria, political_risk, search, alerts, agency_stats, dismiss_alert, monitors, monitor_save, monitor_toggle, monitor_delete, monitor_alerts, holdings, exec_summary, auth_config, refresh, data_health" });
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message });
  }
};
