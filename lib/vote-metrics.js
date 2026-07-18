/**
 * vote-metrics.js  (porte de analytics-engine.ts do IRIS)
 * Funções puras que computam dashboards/analytics a partir de Deliberacao[].
 * Usadas pelas rotas de API quando em modo "local" (sincronizado do localStorage do client).
 * Cada função retorna exatamente a mesma shape do método correspondente do demoData.
 *
 * NB (porte LINCE): mantém os nomes de campo do IRIS (tipo_voto, is_divergente,
 * is_nominal, resultado, microtema, diretor_id, diretor_nome, agencia_id,
 * data_reuniao, extraction_confidence, auto_classified, pauta_interna, votos[]).
 * Uma camada de mapeamento no endpoint faz a tradução p/ os campos do LINCE depois.
 *
 * Helpers de @/lib/utils, @/lib/server/regulatory-documents, empresa-resolver e
 * name-matcher foram INLINE aqui (pequenos e puros) — ver bloco "Helpers inlined".
 */

// ─── Helpers inlined ─────────────────────────────────────────────────────────

// Inline de @/lib/utils (isResultadoPositivo): resultados considerados "positivos"
// (deferimento/aprovação) para badges e métricas.
const RESULTADOS_POSITIVOS = new Set([
  "Deferido",
  "Aprovado",
  "Aprovado com Ressalvas",
  "Aprovado por Unanimidade",
  "Ratificado",
  "Autorizado",
  "Recomendado",
  "Determinado",
]);

function isResultadoPositivo(resultado) {
  return resultado ? RESULTADOS_POSITIVOS.has(resultado) : false;
}

// Inline de @/lib/server/regulatory-documents (isFinalDecisionRecord).
// Aceita tanto o formato completo (raw_extraction inteiro) quanto o achatado
// (sub-select do PostgREST): se raw_extraction vier projetado, lê dele; senão,
// dos campos achatados import_counts_as_final/documento_subtipo/documento_antt_tipo.
function isFinalDecisionRecord(row) {
  const hasRaw = row.raw_extraction != null;
  const raw = row.raw_extraction ?? {};
  const importCountsAsFinal = hasRaw ? raw.import_counts_as_final : row.import_counts_as_final;
  if (importCountsAsFinal === false) return false;
  const tipo = String(row.tipo_documento ?? "");
  const subtipo = String(
    (hasRaw
      ? (raw.documento_subtipo ?? raw.documento_antt_tipo)
      : (row.documento_subtipo ?? row.documento_antt_tipo)) ?? "",
  );

  if (["pauta", "voto_individual", "documento_apoio"].includes(tipo)) return false;
  if (["pauta", "voto_individual", "reuniao_deliberativa_eletronica", "reuniao_diretoria_publica", "reuniao_extraordinaria"].includes(subtipo)) {
    return false;
  }
  if (tipo === "ata") {
    return Boolean(row.documento_pai_id && row.resultado);
  }
  return ["deliberacao", "resolucao", "portaria"].includes(tipo);
}

// Inline de @/lib/server/empresa-resolver (isOrgaoInterno).
// Órgãos INTERNOS (da própria agência) NÃO são empresas reguladas. NÃO inclui
// órgãos EXTERNOS (Ministério/Secretaria/Departamento/Autarquia): DNIT, DER e
// Ministérios são contrapartes reais e devem aparecer.
const ORGAO_INTERNO_RE = /\b(superintend[êe]ncia|diretoria|coordena[çc][ãa]o|ger[êe]ncia|assessoria|procuradoria|n[úu]cleo|comiss[ãa]o\s+(interna|de\s+[ée]tica)|ag[êe]ncia\s+(nacional|reguladora|de\s+transporte))\b/i;

function isOrgaoInterno(nome) {
  return Boolean(nome && ORGAO_INTERNO_RE.test(nome));
}

// Inline de @/lib/server/name-matcher (canonicalizeEmpresa).
// Normaliza razão social: remove acentos, pontuação e sufixos societários.
function canonicalizeEmpresa(nome) {
  return nome
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.,/\\()'"]+/g, " ")
    .replace(/\b(s\s*\/?\s*a|sa|ltda|eireli|epp|mei|me|cia|companhia|concessionaria|holding|participacoes|empreendimentos)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function filterByAgencia(delibs, agenciaId) {
  return agenciaId ? delibs.filter((d) => d.agencia_id === agenciaId) : delibs;
}

/** YYYY-MM-DD para N dias atrás. */
function isoDateDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

/** YYYY-MM para N meses atrás. */
function isoMonthAgo(months) {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 7);
}

/**
 * Exclui ata-parents das contagens para evitar double-counting.
 * Ata-parents são registros com tipo_documento="ata" e SEM documento_pai_id
 * (i.e., são o registro "envelope" da ata, não um item individual).
 * Items de ata TÊM documento_pai_id preenchido e devem ser contados.
 */
function excludeAtaParents(delibs) {
  return delibs.filter(isFinalDecisionRecord);
}

function allVotos(delibs) {
  const result = [];
  for (const d of delibs) {
    for (const v of d.votos ?? []) {
      result.push({ ...v, delib: d });
    }
  }
  return result;
}

// ─── 19. extractDirectors ────────────────────────────────────────────────────

function extractDirectors(delibs) {
  const map = new Map();
  for (const d of delibs) {
    for (const v of d.votos ?? []) {
      if (!map.has(v.diretor_id)) {
        map.set(v.diretor_id, {
          id: v.diretor_id,
          nome: v.diretor_nome ?? v.diretor_id,
          agencia_id: d.agencia_id ?? "",
        });
      }
    }
  }
  return [...map.values()];
}

// ─── 1. computeOverview ──────────────────────────────────────────────────────

function computeOverview(delibs, agenciaId) {
  const rows = excludeAtaParents(filterByAgencia(delibs, agenciaId));
  const total = rows.length;
  const deferidos = rows.filter((r) => isResultadoPositivo(r.resultado)).length;
  const indeferidos = rows.filter((r) => r.resultado === "Indeferido").length;
  const sem_resultado = rows.filter((r) => !r.resultado).length;

  const withConf = rows.filter((r) => r.extraction_confidence != null);
  const avg_confidence = withConf.length > 0
    ? withConf.reduce((s, r) => s + (r.extraction_confidence ?? 0), 0) / withConf.length
    : 0;

  const reunioes_unicas = new Set(rows.map((r) => r.data_reuniao).filter(Boolean)).size;

  const temaCount = new Map();
  for (const r of rows) {
    if (r.microtema) temaCount.set(r.microtema, (temaCount.get(r.microtema) ?? 0) + 1);
  }
  const top_microtema = temaCount.size > 0
    ? [...temaCount.entries()].sort((a, b) => b[1] - a[1])[0][0]
    : null;

  const autoClassified = rows.filter((r) => r.auto_classified).length;
  const pauta_interna_count = rows.filter((r) => r.pauta_interna).length;

  return {
    total_deliberacoes: total,
    deferidos,
    indeferidos,
    sem_resultado,
    taxa_deferimento: total > 0 ? ((deferidos / total) * 100).toFixed(1) : "0",
    reunioes_unicas,
    avg_confidence,
    top_microtema,
    auto_classified_pct: total > 0 ? Math.round((autoClassified / total) * 100) : 0,
    pauta_externa: total - pauta_interna_count,
    pauta_interna_count,
  };
}

// ─── 2. computeMicrotemas ────────────────────────────────────────────────────

function computeMicrotemas(delibs, agenciaId) {
  const rows = excludeAtaParents(filterByAgencia(delibs, agenciaId));
  const stats = new Map();
  for (const d of rows) {
    const m = d.microtema ?? "outros";
    if (!stats.has(m)) stats.set(m, { total: 0, deferido: 0, indeferido: 0 });
    const s = stats.get(m);
    s.total++;
    if (isResultadoPositivo(d.resultado)) s.deferido++;
    else if (d.resultado === "Indeferido") s.indeferido++;
  }
  return [...stats.entries()]
    .map(([microtema, s]) => ({
      microtema,
      total: s.total,
      deferido: s.deferido,
      indeferido: s.indeferido,
      pct_deferido: s.total > 0 ? (s.deferido / s.total) * 100 : 0,
      pct_indeferido: s.total > 0 ? (s.indeferido / s.total) * 100 : 0,
    }))
    .sort((a, b) => b.total - a.total);
}

// ─── 3. computeMicrotemasEvolution ───────────────────────────────────────────

function computeMicrotemasEvolution(delibs, agenciaId) {
  const rows = excludeAtaParents(filterByAgencia(delibs, agenciaId));
  const groups = new Map();
  for (const d of rows) {
    const period = (d.data_reuniao ?? "").slice(0, 7);
    if (!period) continue;
    if (!groups.has(period)) groups.set(period, new Map());
    const pm = groups.get(period);
    const m = d.microtema ?? "outros";
    pm.set(m, (pm.get(m) ?? 0) + 1);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, temas]) => ({ period, ...Object.fromEntries(temas) }));
}

// ─── 4. computeDiretoresOverview ─────────────────────────────────────────────

function computeDiretoresOverview(delibs, agenciaId) {
  const rows = filterByAgencia(delibs, agenciaId);
  const map = new Map();

  for (const d of rows) {
    for (const v of d.votos ?? []) {
      if (!v.diretor_id) continue;
      if (!map.has(v.diretor_id)) {
        map.set(v.diretor_id, {
          diretor_id: v.diretor_id,
          diretor_nome: v.diretor_nome ?? v.diretor_id,
          total: 0, favoravel: 0, desfavoravel: 0, divergente: 0,
          nominais: 0, inferidos: 0,
        });
      }
      const s = map.get(v.diretor_id);
      s.total++;
      if (v.tipo_voto === "Favoravel") s.favoravel++;
      else s.desfavoravel++;
      if (v.is_divergente) s.divergente++;
      if (v.is_nominal) s.nominais++; else s.inferidos++;
    }
  }

  return [...map.values()]
    .map((s) => ({
      ...s,
      pct_favor: s.total > 0 ? Math.round((s.favoravel / s.total) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.total - a.total);
}

// ─── 5. computeReunioesCalendar ──────────────────────────────────────────────

function computeReunioesCalendar(delibs, agenciaId) {
  const rows = filterByAgencia(delibs, agenciaId);
  const counts = new Map();
  for (const d of rows) {
    if (d.data_reuniao) counts.set(d.data_reuniao, (counts.get(d.data_reuniao) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count }));
}

// ─── 6. computeReunioesStats ─────────────────────────────────────────────────

function computeReunioesStats(delibs, agenciaId) {
  const rows = excludeAtaParents(filterByAgencia(delibs, agenciaId));
  const byMonth = new Map();
  for (const d of rows) {
    const period = (d.data_reuniao ?? "").slice(0, 7);
    if (!period) continue;
    if (!byMonth.has(period)) byMonth.set(period, { total: 0, deferido: 0, indeferido: 0 });
    const s = byMonth.get(period);
    s.total++;
    if (isResultadoPositivo(d.resultado)) s.deferido++;
    else if (d.resultado === "Indeferido") s.indeferido++;
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, s]) => ({ period, ...s }));
}

// ─── 7. computeDelibList ─────────────────────────────────────────────────────

function computeDelibList(delibs, params) {
  const page = params?.page ?? 1;
  const limit = params?.limit ?? 20;

  let items = [...delibs];
  if (params?.agencia_id) items = items.filter((d) => d.agencia_id === params.agencia_id);
  if (params?.microtema)  items = items.filter((d) => d.microtema === params.microtema);
  if (params?.resultado)  items = items.filter((d) => d.resultado === params.resultado);
  if (params?.year)       items = items.filter((d) => (d.data_reuniao ?? "").startsWith(params.year));
  if (params?.search) {
    const q = params.search.toLowerCase();
    items = items.filter((d) =>
      d.interessado?.toLowerCase().includes(q) ||
      d.processo?.toLowerCase().includes(q) ||
      d.numero_deliberacao?.toLowerCase().includes(q)
    );
  }

  items.sort((a, b) => (b.data_reuniao ?? "").localeCompare(a.data_reuniao ?? ""));

  const total = items.length;
  const offset = (page - 1) * limit;
  return { data: items.slice(offset, offset + limit), total, page, limit, pages: Math.ceil(total / limit) };
}

// ─── 8. computeDelibById ─────────────────────────────────────────────────────

function computeDelibById(delibs, id) {
  return delibs.find((d) => d.id === id) ?? null;
}

// ─── 9. computeVotacaoMatrix ─────────────────────────────────────────────────

function computeVotacaoMatrix(delibs, agenciaId) {
  const rows = filterByAgencia(delibs, agenciaId);
  const map = new Map();

  for (const d of rows) {
    for (const v of d.votos ?? []) {
      if (!v.diretor_id) continue;
      if (!map.has(v.diretor_id)) {
        map.set(v.diretor_id, {
          diretor_id: v.diretor_id,
          diretor_nome: v.diretor_nome ?? v.diretor_id,
          total: 0, favoravel: 0, desfavoravel: 0, abstencao: 0, divergente: 0,
        });
      }
      const s = map.get(v.diretor_id);
      s.total++;
      if (v.tipo_voto === "Favoravel") s.favoravel++;
      else if (v.tipo_voto === "Abstencao") s.abstencao++;
      else s.desfavoravel++;
      if (v.is_divergente) s.divergente++;
    }
  }

  return [...map.values()].sort((a, b) => b.total - a.total);
}

// ─── 10. computeVotacaoDistribution ──────────────────────────────────────────

function computeVotacaoDistribution(delibs, agenciaId) {
  const rows = filterByAgencia(delibs, agenciaId);
  const counts = new Map();
  let totalVotos = 0;

  for (const d of rows) {
    for (const v of d.votos ?? []) {
      counts.set(v.tipo_voto, (counts.get(v.tipo_voto) ?? 0) + 1);
      totalVotos++;
    }
  }

  return [...counts.entries()]
    .map(([tipo_voto, count]) => ({
      tipo_voto,
      count,
      pct: totalVotos > 0 ? ((count / totalVotos) * 100).toFixed(1) : "0",
    }))
    .sort((a, b) => b.count - a.count);
}

// ─── 11. computeVotacaoFidelidade ────────────────────────────────────────────

// ─── Reuniões (agrupamento de deliberações) ──────────────────────────────────
function reuniaoKey(d) {
  return `${d.agencia_id ?? "-"}__${d.data_reuniao ?? "-"}__${d.numero_reuniao ?? "-"}`;
}

function computeReunioesList(delibs, agenciaId) {
  const rows = filterByAgencia(delibs, agenciaId).filter((d) => d.data_reuniao && isFinalDecisionRecord(d));
  const map = new Map();
  for (const d of rows) {
    const key = reuniaoKey(d);
    let e = map.get(key);
    if (!e) {
      e = {
        agencia_id: d.agencia_id ?? null, agencia_sigla: d.agencia?.sigla ?? null,
        data_reuniao: d.data_reuniao, numero_reuniao: d.numero_reuniao ?? null, tipo_reuniao: d.tipo_reuniao ?? null,
        total_itens: 0, total_votos: 0, votos_nominais: 0, votos_inferidos: 0, divergencias: 0,
      };
      map.set(key, e);
    }
    e.total_itens++;
    const votos = d.votos ?? [];
    e.total_votos += votos.length;
    e.votos_nominais += votos.filter((v) => v.is_nominal).length;
    e.votos_inferidos += votos.filter((v) => !v.is_nominal).length;
    if (votos.some((v) => v.is_divergente)) e.divergencias++;
  }
  return [...map.entries()]
    .map(([slug, e]) => ({
      slug, ...e,
      pct_consenso: e.total_itens > 0 ? Math.round(((e.total_itens - e.divergencias) / e.total_itens) * 1000) / 10 : 0,
    }))
    .sort((a, b) => (b.data_reuniao ?? "").localeCompare(a.data_reuniao ?? ""));
}

function computeReuniaoDetalhe(delibs, key) {
  const rows = delibs.filter((d) =>
    isFinalDecisionRecord(d) &&
    (d.agencia_id ?? null) === key.agenciaId &&
    (d.data_reuniao ?? null) === key.dataReuniao &&
    (d.numero_reuniao ?? null) === (key.numeroReuniao ?? null),
  );
  if (rows.length === 0) return null;

  let deferidos = 0, indeferidos = 0, divergencias = 0, votos_nominais = 0, votos_inferidos = 0;
  const dirMap = new Map();
  const itens = rows.map((d) => {
    if (isResultadoPositivo(d.resultado)) deferidos++;
    else if (d.resultado === "Indeferido") indeferidos++;
    if ((d.votos ?? []).some((v) => v.is_divergente)) divergencias++;
    for (const v of d.votos ?? []) {
      if (v.is_nominal) votos_nominais++; else votos_inferidos++;
      if (!v.diretor_id) continue;
      let e = dirMap.get(v.diretor_id);
      if (!e) { e = { id: v.diretor_id, nome: v.diretor_nome ?? v.diretor_id, favoravel: 0, desfavoravel: 0, divergente: 0, nominais: 0, inferidos: 0 }; dirMap.set(v.diretor_id, e); }
      if (v.tipo_voto === "Favoravel") e.favoravel++;
      else if (v.tipo_voto === "Desfavoravel") e.desfavoravel++;
      if (v.is_divergente) e.divergente++;
      if (v.is_nominal) e.nominais++; else e.inferidos++;
    }
    return {
      deliberacao_id: d.id,
      numero_deliberacao: d.numero_deliberacao,
      interessado: d.interessado,
      microtema: d.microtema,
      resultado: d.resultado,
      votos: (d.votos ?? []).map((v) => ({
        diretor_id: v.diretor_id, diretor_nome: v.diretor_nome, tipo_voto: v.tipo_voto, is_divergente: v.is_divergente, is_nominal: v.is_nominal,
      })),
    };
  });

  const first = rows[0];
  return {
    cabecalho: {
      agencia_id: first.agencia_id ?? null,
      agencia_sigla: first.agencia?.sigla ?? null,
      data_reuniao: first.data_reuniao,
      numero_reuniao: first.numero_reuniao ?? null,
      tipo_reuniao: first.tipo_reuniao ?? null,
    },
    resumo: {
      total_itens: rows.length, deferidos, indeferidos, divergencias,
      votos_nominais, votos_inferidos,
      pct_consenso: rows.length > 0 ? Math.round(((rows.length - divergencias) / rows.length) * 1000) / 10 : 0,
    },
    itens,
    diretores: [...dirMap.values()].sort((a, b) => (b.favoravel + b.desfavoravel) - (a.favoravel + a.desfavoravel)),
  };
}

function computeConsensoTimeline(delibs, agenciaId) {
  const rows = filterByAgencia(delibs, agenciaId).filter((d) => d.data_reuniao && isFinalDecisionRecord(d));
  const byMonth = new Map();
  for (const d of rows) {
    const period = (d.data_reuniao ?? "").slice(0, 7);
    if (!period) continue;
    const m = byMonth.get(period) ?? { total: 0, divergentes: 0, com_voto_nominal: 0 };
    m.total++;
    if ((d.votos ?? []).some((v) => v.is_divergente)) m.divergentes++;
    if ((d.votos ?? []).some((v) => v.is_nominal)) m.com_voto_nominal++;
    byMonth.set(period, m);
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, m]) => ({
      period,
      total_itens: m.total,
      consensuais: m.total - m.divergentes,
      divergentes: m.divergentes,
      pct_consenso: m.total > 0 ? Math.round(((m.total - m.divergentes) / m.total) * 1000) / 10 : 0,
      // % de itens com ao menos um voto nominal — o consenso só é confiável onde há base nominal.
      cobertura_nominal: m.total > 0 ? Math.round((m.com_voto_nominal / m.total) * 1000) / 10 : 0,
    }));
}

function computeVotacaoFidelidade(delibs, agenciaId) {
  const rows = filterByAgencia(delibs, agenciaId);
  const map = new Map();

  for (const d of rows) {
    for (const v of d.votos ?? []) {
      if (!v.diretor_id) continue;
      if (!map.has(v.diretor_id)) {
        map.set(v.diretor_id, {
          diretor_id: v.diretor_id,
          diretor_nome: v.diretor_nome ?? v.diretor_id,
          total_votos: 0, votos_nominais: 0, votos_divergentes: 0,
        });
      }
      const s = map.get(v.diretor_id);
      s.total_votos++;
      if (v.is_nominal) s.votos_nominais++;
      if (v.is_divergente) s.votos_divergentes++;
    }
  }

  return [...map.values()].map((s) => ({
    ...s,
    taxa_fidelidade: s.total_votos > 0
      ? ((1 - s.votos_divergentes / s.total_votos) * 100).toFixed(1)
      : "100.0",
  }));
}

// ─── 12. computeVotacaoSectors ───────────────────────────────────────────────

function computeVotacaoSectors(delibs, agenciaId) {
  const rows = filterByAgencia(delibs, agenciaId);
  const counts = new Map();
  for (const d of rows) {
    const m = d.microtema ?? "outros";
    const votosCount = (d.votos ?? []).length;
    counts.set(m, (counts.get(m) ?? 0) + (votosCount || 1));
  }
  return [...counts.entries()]
    .map(([microtema, count]) => ({ microtema, count }))
    .sort((a, b) => b.count - a.count);
}

// ─── 13. computeMandatos ─────────────────────────────────────────────────────

function computeMandatos(delibs, agenciaId, statusFilter) {
  const rows = filterByAgencia(delibs, agenciaId);
  const dirs = extractDirectors(rows);

  // Build a date range per director from deliberação dates
  const dateRange = new Map();
  for (const d of rows) {
    for (const v of d.votos ?? []) {
      const date = d.data_reuniao ?? "";
      if (!date) continue;
      const r = dateRange.get(v.diretor_id);
      if (!r) {
        dateRange.set(v.diretor_id, { earliest: date, latest: date });
      } else {
        if (date < r.earliest) r.earliest = date;
        if (date > r.latest) r.latest = date;
      }
    }
  }

  const mandatos = dirs.map((dir, i) => {
    const range = dateRange.get(dir.id);
    return {
      id: `synced-m-${i}`,
      diretor_id: dir.id,
      diretor_nome: dir.nome,
      cargo: "Diretor(a)",
      agencia_id: dir.agencia_id,
      data_inicio: range?.earliest ?? "",
      data_fim: null,
      status: "Ativo",
    };
  });

  if (statusFilter) {
    return mandatos.filter((m) => m.status === statusFilter);
  }
  return mandatos;
}

// ─── 14. computeMandatosStats ────────────────────────────────────────────────

function computeMandatosStats(delibs, agenciaId) {
  const rows = filterByAgencia(delibs, agenciaId);
  const dirs = extractDirectors(rows);
  const total = rows.length;

  const comDivergencia = rows.filter((d) =>
    (d.votos ?? []).some((v) => v.is_divergente)
  ).length;
  const taxa_consenso = total > 0
    ? (((total - comDivergencia) / total) * 100).toFixed(1) + "%"
    : "100%";

  return {
    diretores_ativos: dirs.length,
    participacoes_colegiadas: total * dirs.length,
    taxa_consenso,
    total_deliberacoes: total,
  };
}

// ─── 15. computeMandatosAnalytics ────────────────────────────────────────────

function computeMandatosAnalytics(delibs, agenciaId) {
  const rows = filterByAgencia(delibs, agenciaId);
  const total = rows.length;

  const comLitigio = rows.filter((d) =>
    (d.votos ?? []).some((v) => v.is_divergente)
  ).length;
  const taxa_litigio = total > 0 ? `${((comLitigio / total) * 100).toFixed(1)}%` : "0%";
  const taxa_consenso = total > 0 ? `${(((total - comLitigio) / total) * 100).toFixed(1)}%` : "0%";

  const sancao = rows.filter((d) =>
    d.microtema === "multa" || d.resultado === "Indeferido"
  ).length;
  const taxa_sancao = total > 0 ? `${((sancao / total) * 100).toFixed(1)}%` : "0%";

  const resultadoCount = new Map();
  for (const d of rows) {
    const r = d.resultado ?? "Sem resultado";
    resultadoCount.set(r, (resultadoCount.get(r) ?? 0) + 1);
  }
  const distribuicao_decisao = [...resultadoCount.entries()]
    .map(([resultado, count]) => ({
      resultado,
      count,
      pct: total > 0 ? Math.round((count / total) * 100) : 0,
    }))
    .sort((a, b) => b.count - a.count);

  const byMonth = new Map();
  for (const d of rows) {
    const period = (d.data_reuniao ?? "").slice(0, 7);
    if (!period) continue;
    if (!byMonth.has(period)) byMonth.set(period, { total: 0, deferido: 0, indeferido: 0 });
    const s = byMonth.get(period);
    s.total++;
    if (isResultadoPositivo(d.resultado)) s.deferido++;
    else if (d.resultado === "Indeferido") s.indeferido++;
  }
  const evolucao_mensal = [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, s]) => ({ period, ...s }));

  return { total_deliberacoes: total, taxa_litigio, taxa_consenso, taxa_sancao, distribuicao_decisao, evolucao_mensal };
}

// ─── 16. computeDiretores ────────────────────────────────────────────────────

function computeDiretores(delibs, agenciaId) {
  const rows = filterByAgencia(delibs, agenciaId);
  const dirs = extractDirectors(rows);
  return dirs.map((d) => ({
    id: d.id,
    nome: d.nome,
    agencia_id: d.agencia_id,
    cargo: "Diretor(a)",
    needs_review: false,
    ativo: true,
    created_at: new Date().toISOString(),
  }));
}

// ─── 17. computeDiretorProfile ───────────────────────────────────────────────

function computeDiretorProfile(delibs, dirId) {
  const allDirs = extractDirectors(delibs);
  const diretor = allDirs.find((d) => d.id === dirId);
  if (!diretor) return null;

  let favoravel = 0, desfavoravel = 0, abstencao = 0, divergente = 0;
  const microtemaCount = new Map();
  const historico = [];

  for (const d of delibs) {
    const meuVoto = (d.votos ?? []).find((v) => v.diretor_id === dirId);
    if (!meuVoto) continue;

    if (meuVoto.tipo_voto === "Favoravel") favoravel++;
    else if (meuVoto.tipo_voto === "Abstencao") abstencao++;
    else desfavoravel++;
    if (meuVoto.is_divergente) divergente++;
    if (d.microtema) microtemaCount.set(d.microtema, (microtemaCount.get(d.microtema) ?? 0) + 1);

    historico.push({
      deliberacao_id: d.id,
      numero_deliberacao: d.numero_deliberacao,
      data_reuniao: d.data_reuniao,
      interessado: d.interessado,
      microtema: d.microtema,
      resultado: d.resultado,
      tipo_voto: meuVoto.tipo_voto,
      is_divergente: meuVoto.is_divergente,
    });
  }
  historico.sort((a, b) => (b.data_reuniao ?? "").localeCompare(a.data_reuniao ?? ""));

  const total = favoravel + desfavoravel + abstencao;
  const pct_favoravel = total > 0 ? (favoravel / total) * 100 : 0;
  const pct_divergente = total > 0 ? (divergente / total) * 100 : 0;

  const perfil =
    pct_divergente < 5 ? "Consensual"
    : pct_divergente < 15 ? "Moderadamente divergente"
    : "Divergente";

  const microtema_dominante = microtemaCount.size > 0
    ? [...microtemaCount.entries()].sort((a, b) => b[1] - a[1])[0][0]
    : null;

  const taxa_aprovacao = total > 0 ? `${pct_favoravel.toFixed(1)}%` : "—";
  const descricao = total > 0
    ? (pct_divergente < 5
        ? `Vota com a maioria em ${(100 - pct_divergente).toFixed(0)}% dos casos`
        : `Apresentou voto divergente em ${pct_divergente.toFixed(1)}% das deliberações`)
    : "Sem histórico de votos registrado";

  return {
    id: diretor.id,
    nome: diretor.nome,
    cargo: "Diretor(a)",
    agencia_id: diretor.agencia_id,
    agencia_sigla: null,
    mandato: {
      data_inicio: historico.length > 0 ? historico[historico.length - 1].data_reuniao ?? "" : "",
      data_fim: null,
      status: "Ativo",
      dias_restantes: null,
    },
    stats: { total_votos: total, favoravel, desfavoravel, abstencao, divergente, pct_favoravel, pct_divergente },
    por_microtema: [...microtemaCount.entries()]
      .map(([microtema, t]) => ({ microtema, total: t }))
      .sort((a, b) => b.total - a.total),
    historico,
    tendencias: { perfil, microtema_dominante, taxa_aprovacao, descricao },
  };
}

// ─── 18. computeEmpresas ─────────────────────────────────────────────────────

function computeEmpresas(delibs, agenciaId) {
  const rows = filterByAgencia(delibs, agenciaId).filter((d) => d.interessado && isFinalDecisionRecord(d));
  const map = new Map();

  for (const d of rows) {
    if (!d.interessado) continue;
    if (isOrgaoInterno(d.interessado)) continue; // órgão interno não é empresa regulada
    const key = canonicalizeEmpresa(d.interessado) || d.interessado;
    let entry = map.get(key);
    if (!entry) {
      entry = { nome: d.interessado, delibs: [], microtemas: new Set(), agencia: d.agencia_id ?? "" };
      map.set(key, entry);
    }
    if (d.interessado.length > entry.nome.length) entry.nome = d.interessado;
    entry.delibs.push(d);
    if (d.microtema) entry.microtemas.add(d.microtema);
  }

  return [...map.values()]
    .map((s) => {
      const nome = s.nome;
      const microtemas = [...s.microtemas];
      const total = s.delibs.length;
      const deferido = s.delibs.filter((d) => isResultadoPositivo(d.resultado)).length;
      const indeferido = s.delibs.filter((d) => d.resultado === "Indeferido").length;
      const pct_deferido = total > 0 ? (deferido / total) * 100 : 0;
      const ultima = s.delibs
        .map((d) => d.data_reuniao ?? "")
        .filter(Boolean)
        .sort()
        .at(-1) ?? "";

      // Tendência: primeira vs segunda metade do histórico
      const sorted = [...s.delibs].sort((a, b) => (a.data_reuniao ?? "").localeCompare(b.data_reuniao ?? ""));
      const mid = Math.floor(sorted.length / 2);
      const ant = sorted.slice(0, mid);
      const rec = sorted.slice(mid);
      const pct_ant = ant.length > 0 ? (ant.filter((d) => isResultadoPositivo(d.resultado)).length / ant.length) * 100 : pct_deferido;
      const pct_rec = rec.length > 0 ? (rec.filter((d) => isResultadoPositivo(d.resultado)).length / rec.length) * 100 : pct_deferido;
      const diff = pct_rec - pct_ant;
      const tendencia_direcao =
        diff > 5 ? "melhorando" : diff < -5 ? "piorando" : "estavel";

      const risco_regulatorio =
        pct_deferido < 40 ? "alto" : pct_deferido < 70 ? "medio" : "baixo";

      return {
        nome,
        total_deliberacoes: total,
        deferidos: deferido,
        indeferidos: indeferido,
        pct_deferido,
        ultima_deliberacao: ultima || null,
        microtemas,
        microtema_principal: microtemas[0] ?? null,
        agencia_id: s.agencia,
        risco_regulatorio,
        tendencia_direcao,
      };
    })
    .sort((a, b) => b.total_deliberacoes - a.total_deliberacoes);
}

// ─── 20. computeEmpresaDetalhe ───────────────────────────────────────────────

function computeEmpresaDetalhe(delibs, empresaNome) {
  const alvo = canonicalizeEmpresa(empresaNome) || empresaNome;
  const rows = delibs.filter(
    (d) => d.interessado != null && (canonicalizeEmpresa(d.interessado) || d.interessado) === alvo && isFinalDecisionRecord(d),
  );
  if (rows.length === 0) return null;

  const total = rows.length;
  const deferidos = rows.filter((d) => isResultadoPositivo(d.resultado)).length;
  const indeferidos = rows.filter((d) => d.resultado === "Indeferido").length;
  const pct_deferido = total > 0 ? (deferidos / total) * 100 : 0;

  const ultima = rows
    .map((d) => d.data_reuniao ?? "")
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;

  // Risco regulatório
  const risco_regulatorio =
    pct_deferido < 40 ? "alto" : pct_deferido < 70 ? "medio" : "baixo";

  // Tendência: metade mais antiga vs. metade mais recente
  const sorted = [...rows].sort((a, b) => (a.data_reuniao ?? "").localeCompare(b.data_reuniao ?? ""));
  const mid = Math.floor(sorted.length / 2);
  const ant = sorted.slice(0, mid);
  const rec = sorted.slice(mid);
  const pct_anterior = ant.length > 0 ? (ant.filter((d) => isResultadoPositivo(d.resultado)).length / ant.length) * 100 : pct_deferido;
  const pct_recente = rec.length > 0 ? (rec.filter((d) => isResultadoPositivo(d.resultado)).length / rec.length) * 100 : pct_deferido;
  const diff = pct_recente - pct_anterior;
  const direcao =
    diff > 5 ? "melhorando" : diff < -5 ? "piorando" : "estavel";

  // Evolução mensal
  const byMonth = new Map();
  for (const d of rows) {
    const period = (d.data_reuniao ?? "").slice(0, 7);
    if (!period) continue;
    if (!byMonth.has(period)) byMonth.set(period, { total: 0, positivo: 0, negativo: 0 });
    const s = byMonth.get(period);
    s.total++;
    if (isResultadoPositivo(d.resultado)) s.positivo++;
    else if (d.resultado === "Indeferido") s.negativo++;
  }
  const evolucao_mensal = [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, s]) => ({ period, ...s }));

  // Microtemas breakdown
  const microtemaCount = new Map();
  for (const d of rows) {
    const m = d.microtema ?? "outros";
    microtemaCount.set(m, (microtemaCount.get(m) ?? 0) + 1);
  }
  const microtemas_breakdown = [...microtemaCount.entries()]
    .map(([microtema, count]) => ({ microtema, count }))
    .sort((a, b) => b.count - a.count);

  // Diretores que votaram em deliberações desta empresa
  const dirMap = new Map();
  for (const d of rows) {
    for (const v of d.votos ?? []) {
      if (!v.diretor_id) continue;
      if (!dirMap.has(v.diretor_id)) {
        dirMap.set(v.diretor_id, { id: v.diretor_id, nome: v.diretor_nome ?? v.diretor_id, total: 0, favoravel: 0, desfavoravel: 0, abstencao: 0, divergente: 0 });
      }
      const dir = dirMap.get(v.diretor_id);
      dir.total++;
      if (v.tipo_voto === "Favoravel") dir.favoravel++;
      else if (v.tipo_voto === "Desfavoravel") dir.desfavoravel++;
      else if (v.tipo_voto === "Abstencao") dir.abstencao++;
      if (v.is_divergente) dir.divergente++;
    }
  }
  const diretores = [...dirMap.values()]
    .map((d) => ({
      ...d,
      pct_favoravel: d.total > 0 ? (d.favoravel / d.total) * 100 : 0,
      pct_divergente: d.total > 0 ? (d.divergente / d.total) * 100 : 0,
    }))
    .sort((a, b) => b.total - a.total);

  // Alertas ativos
  const alertas = [];
  const iso90 = isoDateDaysAgo(90);
  const negativas90 = rows.filter((d) => d.resultado === "Indeferido" && (d.data_reuniao ?? "") >= iso90).length;
  if (negativas90 >= 2) alertas.push(`${negativas90} indeferimentos nos últimos 90 dias`);
  if (risco_regulatorio === "alto" && total >= 3) alertas.push("Taxa de aprovação abaixo de 40%");
  if (direcao === "piorando" && total >= 4) alertas.push("Tendência de queda na taxa de aprovação");

  return {
    nome: empresaNome,
    total_deliberacoes: total,
    deferidos,
    indeferidos,
    pct_deferido,
    ultima_deliberacao: ultima,
    agencia_id: rows[0].agencia_id ?? null,
    risco_regulatorio,
    tendencia: { pct_anterior, pct_recente, direcao },
    evolucao_mensal,
    microtemas_breakdown,
    diretores,
    historico: rows.sort((a, b) => (b.data_reuniao ?? "").localeCompare(a.data_reuniao ?? "")),
    alertas,
  };
}

// ─── 21. computeAlertas ──────────────────────────────────────────────────────

function computeAlertas(delibs, agenciaId) {
  const rows = filterByAgencia(delibs, agenciaId).filter(isFinalDecisionRecord);
  const alertas = [];

  const now = new Date().toISOString();
  const iso90 = isoDateDaysAgo(90);

  // ── 1. Empresas com ≥ 3 indeferimentos nos últimos 90 dias ────────────
  const empresaNeg = new Map();
  for (const d of rows) {
    if (d.resultado === "Indeferido" && (d.data_reuniao ?? "") >= iso90 && d.interessado) {
      empresaNeg.set(d.interessado, (empresaNeg.get(d.interessado) ?? 0) + 1);
    }
  }
  for (const [empresa, count] of empresaNeg) {
    if (count >= 3) {
      alertas.push({
        id: `empresa_risco_${empresa.slice(0, 30).replace(/\s+/g, "_")}`,
        tipo: "empresa_risco",
        severity: "high",
        titulo: "Empresa em risco regulatório",
        mensagem: `${empresa} recebeu ${count} indeferimentos nos últimos 90 dias`,
        entidade: empresa,
        created_at: now,
      });
    }
  }

  // ── 2. Tema emergente: crescimento > 20% no último trimestre ──────────
  const iso3m = isoMonthAgo(3);
  const iso6m = isoMonthAgo(6);
  const temaRec = new Map();
  const temaAnt = new Map();

  for (const d of rows) {
    const period = (d.data_reuniao ?? "").slice(0, 7);
    const tema = d.microtema;
    if (!period || !tema) continue;
    if (period >= iso3m) temaRec.set(tema, (temaRec.get(tema) ?? 0) + 1);
    else if (period >= iso6m) temaAnt.set(tema, (temaAnt.get(tema) ?? 0) + 1);
  }

  for (const [tema, countRec] of temaRec) {
    const countAnt = temaAnt.get(tema) ?? 0;
    if (countAnt > 0 && countRec >= 3) {
      const crescimento = ((countRec - countAnt) / countAnt) * 100;
      if (crescimento > 20) {
        alertas.push({
          id: `tema_emergente_${tema}`,
          tipo: "tema_emergente",
          severity: "medium",
          titulo: "Tema em crescimento",
          mensagem: `Microtema "${tema}" cresceu ${crescimento.toFixed(0)}% no último trimestre (${countAnt} → ${countRec})`,
          entidade: tema,
          created_at: now,
        });
      }
    }
  }

  // ── 3. Diretor com divergência > 30% (mínimo 5 votos) ────────────────
  const dirStats = computeVotacaoMatrix(rows);
  for (const dir of dirStats) {
    if (dir.total >= 5) {
      const pctDiv = (dir.divergente / dir.total) * 100;
      if (pctDiv > 30) {
        alertas.push({
          id: `diretor_divergente_${dir.diretor_id}`,
          tipo: "diretor_divergente",
          severity: "medium",
          titulo: "Perfil divergente ativo",
          mensagem: `${dir.diretor_nome} votou divergentemente em ${pctDiv.toFixed(1)}% dos casos (${dir.divergente}/${dir.total})`,
          entidade: dir.diretor_id,
          created_at: now,
        });
      }
    }
  }

  return alertas.sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return order[a.severity] - order[b.severity];
  });
}

module.exports = {
  extractDirectors,
  computeOverview,
  computeMicrotemas,
  computeMicrotemasEvolution,
  computeDiretoresOverview,
  computeReunioesCalendar,
  computeReunioesStats,
  computeDelibList,
  computeDelibById,
  computeVotacaoMatrix,
  computeVotacaoDistribution,
  computeReunioesList,
  computeReuniaoDetalhe,
  computeConsensoTimeline,
  computeVotacaoFidelidade,
  computeVotacaoSectors,
  computeMandatos,
  computeMandatosStats,
  computeMandatosAnalytics,
  computeDiretores,
  computeDiretorProfile,
  computeEmpresas,
  computeEmpresaDetalhe,
  computeAlertas,
};
