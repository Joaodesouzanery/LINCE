// Motor de Inteligencia Nacional: score de risco por setor/agencia,
// radar de normas dos proximos 30/60/90 dias, resumo executivo diario,
// monitores de vigilancia (CRUD), Gerador de Dossie Comercial (landscape por
// tema, dossie de deal e narrativa IA) e resumo executivo de dossie por IA.
// GET /api/intelligence?type=radar|score|daily|landscape|deal_dossier|monitors|monitor_alerts|holdings
// POST /api/intelligence?type=monitor_save|monitor_toggle|monitor_delete|deal_narrative|exec_summary
const { getSupabase } = require("../lib/supabase");
const { normalizeName, onlyDigits } = require("../lib/text");

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
        last_ingest: lastIngest, days_stale: daysStale,
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
      const days = Math.min(Number(req.query.days) || 30, 90);
      const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      const { data: docs } = await supabase
        .from("documents")
        .select("published_at, document_type")
        .eq("source_name", "DOU")
        .gte("published_at", since)
        .order("published_at", { ascending: true })
        .limit(5000);
      const buckets = {};
      for (const d of docs || []) {
        const k = d.published_at;
        if (!buckets[k]) buckets[k] = { date: k, norma: 0, ato_pessoal: 0, contrato: 0, total: 0 };
        const t = d.document_type === "norma" || d.document_type === "ato_pessoal" || d.document_type === "contrato" ? d.document_type : "norma";
        buckets[k][t]++; buckets[k].total++;
      }
      const series = Object.values(buckets).sort((a, b) => a.date.localeCompare(b.date));
      const total = (docs || []).length;
      return res.status(200).json({ ok: true, type: "trend", days, total, series });
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
      // Resumo executivo: atos das ultimas 24h por agencia
      const since = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const { data: docs } = await supabase
        .from("documents")
        .select("title, document_type, published_at, metadata, agencies(acronym)")
        .eq("source_name", "DOU")
        .gte("published_at", since)
        .order("published_at", { ascending: false })
        .limit(50);

      const byAgency = {};
      for (const d of docs || []) {
        const ac = d.agencies?.acronym || d.metadata?.agency_acronym || "?";
        if (!byAgency[ac]) byAgency[ac] = { normas: 0, pessoal: 0, contratos: 0, destaques: [] };
        if (d.document_type === "norma") byAgency[ac].normas++;
        else if (d.document_type === "ato_pessoal") byAgency[ac].pessoal++;
        else if (d.document_type === "contrato") byAgency[ac].contratos++;
        if (d.metadata?.ai_summary) byAgency[ac].destaques.push(d.metadata.ai_summary);
      }
      return res.status(200).json({ ok: true, type: "daily", date: since, truncated: (docs || []).length >= 50, by_agency: byAgency });
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
      const now = new Date();
      const d30 = new Date(now); d30.setDate(d30.getDate() + 30);
      const d60 = new Date(now); d60.setDate(d60.getDate() + 60);
      const d90 = new Date(now); d90.setDate(d90.getDate() + 90);

      // Contratos E mandatos de dirigentes vencendo nos proximos 90 dias.
      const today = now.toISOString().slice(0, 10);
      const horizon = d90.toISOString().slice(0, 10);
      const [contractsRes, mandatesRes] = await Promise.all([
        supabase.from("contracts")
          .select("object, supplier_name, ends_at, agencies(acronym)")
          .lte("ends_at", horizon).gte("ends_at", today).order("ends_at").limit(500),
        supabase.from("mandates")
          .select("role, ended_at, people(full_name), agencies(acronym)")
          .lte("ended_at", horizon).gte("ended_at", today).order("ended_at").limit(500)
      ]);

      const radar = { "30d": [], "60d": [], "90d": [] };
      const bucketize = (dateStr, entry) => {
        const end = new Date(dateStr);
        if (end <= d30) radar["30d"].push(entry);
        else if (end <= d60) radar["60d"].push(entry);
        else radar["90d"].push(entry);
      };
      for (const c of contractsRes.data || []) {
        bucketize(c.ends_at, {
          type: "contrato", agency: c.agencies?.acronym,
          label: (c.object || "").slice(0, 80), supplier: c.supplier_name, date: c.ends_at
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
      return res.status(200).json({ ok: true, type: "radar", radar });
    }

    if (type === "giratoria") {
      // Porta giratoria + SELF-DEALING: diretores que sao socios de empresas, e
      // (o sinal forte) cujas empresas FORNECEM a PROPRIA agencia que dirigem.
      // Correlacao deterministica: mandates x relationships(socio) x contracts.
      const { data: mandates } = await supabase
        .from("mandates")
        .select("person_id, agency_id, role, started_at, ended_at, people(full_name), agencies(acronym)")
        .limit(3000);

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
        const { data: cts } = await supabase.from("contracts")
          .select("supplier_company_id, agency_id, signed_at, value")
          .in("supplier_company_id", socioCompanyIds.slice(i, i + 200));
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

      const seen = new Set();
      const cases = [];
      for (const m of mandates || []) {
        const socios = socioByPerson[m.person_id];
        if (!socios || !socios.length) continue; // REQUER vinculo societario (filiacao-so NAO e porta-giratoria)
        if (seen.has(m.person_id)) continue;
        seen.add(m.person_id);

        const selfDealing = [], publicSupplier = [];
        let duringMandate = false;
        for (const s of socios) {
          const ags = supplierAgencies[s.company_id];
          if (!ags) continue;
          if (m.agency_id && ags[m.agency_id]) {
            selfDealing.push(s);
            // timing: contrato assinado DENTRO da janela do mandato?
            for (const c of ags[m.agency_id]) {
              if (c.signed_at && m.started_at && c.signed_at >= m.started_at && (!m.ended_at || c.signed_at <= m.ended_at)) duringMandate = true;
            }
          } else {
            publicSupplier.push(s);
          }
        }
        const severity = selfDealing.length ? "critical" : (publicSupplier.length ? "high" : "medium");
        cases.push({
          person_id: m.person_id, name: m.people?.full_name || "?", agency: m.agencies?.acronym, role: m.role,
          mandate_from: m.started_at, mandate_to: m.ended_at, active: !m.ended_at,
          companies: socios, self_dealing: selfDealing, public_supplier: publicSupplier,
          contract_during_mandate: duringMandate,
          parties: partyByPerson[m.person_id] || [], severity,
          rationale: selfDealing.length
            ? `Sócio de ${selfDealing.length} fornecedor(es) da PRÓPRIA agência (${m.agencies?.acronym})${duringMandate ? " — com contrato assinado durante o mandato" : ""}`
            : (publicSupplier.length ? "Sócio de fornecedor público (outra agência)" : "Vínculo societário durante o mandato")
        });
      }
      cases.sort((a, b) => (b.self_dealing.length - a.self_dealing.length) || (b.companies.length - a.companies.length));
      return res.status(200).json({
        ok: true, type: "giratoria", total: cases.length,
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
      const [docsTotal, docs30d, alertsRes, mandatesRes, weeklyRes] = await Promise.all([
        supabase.from("documents").select("id", { count: "exact", head: true }).eq("agency_id", ag.id),
        supabase.from("documents").select("id", { count: "exact", head: true }).eq("agency_id", ag.id).gte("published_at", since30),
        supabase.from("alerts").select("id, alert_type, severity, title, body, created_at").eq("target_id", ag.id).is("acknowledged_at", null).order("created_at", { ascending: false }).limit(5),
        supabase.from("mandates").select("id", { count: "exact", head: true }).eq("agency_id", ag.id).is("ended_at", null),
        supabase.from("documents").select("published_at").eq("agency_id", ag.id).gte("published_at", since8w).order("published_at")
      ]);
      const weekBuckets = {};
      for (const d of weeklyRes.data || []) {
        const dt = new Date(d.published_at + "T12:00:00Z");
        dt.setUTCDate(dt.getUTCDate() - dt.getUTCDay());
        const k = dt.toISOString().slice(0, 10);
        weekBuckets[k] = (weekBuckets[k] || 0) + 1;
      }
      const weekly_series = Object.entries(weekBuckets)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([week, total]) => ({ week, total }))
        .slice(-8);
      const baseline_avg = weekly_series.length
        ? Math.round(weekly_series.reduce((s, w) => s + w.total, 0) / weekly_series.length)
        : 0;
      return res.status(200).json({
        ok: true, type: "agency_stats",
        agency: ag.acronym, agency_name: ag.name,
        total_docs: docsTotal.count || 0, docs_30d: docs30d.count || 0,
        open_alerts: alertsRes.data?.length || 0, active_directors: mandatesRes.count || 0,
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
      const digits = onlyDigits(p.cpf_cnpj);
      if (digits.length === 11 || digits.length === 14) row.cpf_cnpj = digits;
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
      return res.status(200).json({ ok: true, monitor: result.data });
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
        (r) => r.companies?.registration_status && !/ativ/i.test(r.companies.registration_status)
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
          const inaptas = comps.filter((c) => c.registration_status && !/ativ/i.test(c.registration_status)).length;
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
      for (const m of recent) {
        const comps = socioByPerson[m.person_id] || [];
        for (const comp of comps) {
          const contracts = contractsByComp[comp.id] || [];
          if (!contracts.length) continue;
          out.push({
            kind: "nomeacao_x_fornecedor", severity: "high",
            title: `${m.people?.full_name || "Dirigente"} nomeado(a) há pouco na ${m.agencies?.acronym || "agência"} é sócio(a) de fornecedor público`,
            entities: [
              { kind: "person", id: m.person_id, label: m.people?.full_name || "?" },
              { kind: "company", id: comp.id, label: comp.legal_name || comp.cnpj }
            ],
            evidence: [
              `Mandato iniciado em ${m.started_at}${m.role ? ` (${m.role})` : ""}`,
              `Sócio(a) de ${comp.legal_name || comp.cnpj}${comp.socio_role ? ` como ${comp.socio_role}` : ""}`,
              ...contracts.slice(0, 3).map((c) => `Contrato público: ${(c.object || "").slice(0, 80)}${c.agencies?.acronym ? ` (${c.agencies.acronym})` : ""}`)
            ],
            suggested_action: "Verificar impedimento/conflito de interesse e histórico de contratos."
          });
        }
      }

      // Regra 2 (MEDIA/ALTA): dirigente ativo x empresa inapta/baixada.
      const seenR2 = new Set();
      for (const m of active) {
        if (seenR2.has(m.person_id)) continue;
        const inaptas = (socioByPerson[m.person_id] || []).filter((c) => c.registration_status && !/ativ/i.test(c.registration_status));
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
        for (const mon of hotMonitors || []) {
          const pid = mon.person_id;
          const links = pid ? (socioByPerson[pid] || []) : [];
          if (pid && links.length) {
            out.push({
              kind: "monitor_x_vinculos", severity: "high",
              title: `Monitor "${mon.label}" disparou ${mon.hit_count}x sobre pessoa com ${links.length} vínculo(s) societário(s)`,
              entities: [{ kind: "person", id: pid, label: mon.label }],
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
          const inaptas = links.filter((c) => c.registration_status && !/ativ/i.test(c.registration_status));
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
