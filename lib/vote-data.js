// Camada de dados do modulo "Voto dos Diretores": busca deliberations+votes+people
// do LINCE, MAPEIA para o shape que as funcoes puras de lib/vote-metrics.js
// esperam (nomes de campo do IRIS) e despacha a metrica por ?type=votos_*.
// Sem IA. As funcoes de metrica sao porte fiel do analytics-engine do IRIS.
const M = require("./vote-metrics");

// Metricas (delibs, agenciaId) — o grosso do painel.
const BY_AGENCY = {
  votos_overview: M.computeOverview,
  votos_microtemas: M.computeMicrotemas,
  votos_microtemas_evolution: M.computeMicrotemasEvolution,
  votos_diretores_overview: M.computeDiretoresOverview,
  votos_matrix: M.computeVotacaoMatrix,
  votos_distribution: M.computeVotacaoDistribution,
  votos_fidelidade: M.computeVotacaoFidelidade,
  votos_sectors: M.computeVotacaoSectors,
  votos_consenso: M.computeConsensoTimeline,
  votos_reunioes: M.computeReunioesList,
  votos_reunioes_stats: M.computeReunioesStats,
  votos_reunioes_calendar: M.computeReunioesCalendar,
  votos_mandatos: M.computeMandatos,
  votos_mandatos_stats: M.computeMandatosStats,
  votos_mandatos_analytics: M.computeMandatosAnalytics,
  votos_diretores: M.computeDiretores,
  votos_empresas: M.computeEmpresas,
  votos_alertas: M.computeAlertas,
  votos_delib_list: M.computeDelibList,
};

async function paginate(supabase, table, columns, eq) {
  const all = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from(table).select(columns).order("id", { ascending: true }).range(from, from + PAGE - 1);
    if (eq) q = q.eq(eq[0], eq[1]);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    all.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return all;
}

// Le e MAPEIA as deliberacoes do LINCE para o shape do IRIS (Deliberacao[]).
// CRITICO: tipo_documento="deliberacao" p/ passar no isFinalDecisionRecord do
// analytics (senao toda deliberacao seria excluida das contagens).
async function loadDeliberacoes(supabase, agencyId) {
  const delibsRaw = await paginate(
    supabase, "deliberations",
    "id, agency_id, deliberation_number, reuniao_ordinaria, data_reuniao, interessado, process_number, theme, result, pauta_interna, auto_classified, confidence_score",
    agencyId ? ["agency_id", agencyId] : null
  );
  if (!delibsRaw.length) return [];

  const votesRaw = await paginate(
    supabase, "votes",
    "deliberation_id, voter_person_id, vote_direction, is_dissent, is_nominal"
  );
  const personIds = [...new Set(votesRaw.map((v) => v.voter_person_id).filter(Boolean))];
  const nameById = new Map();
  for (let i = 0; i < personIds.length; i += 300) {
    const { data } = await supabase.from("people").select("id, full_name").in("id", personIds.slice(i, i + 300));
    for (const p of data || []) nameById.set(p.id, p.full_name);
  }

  const votesByDelib = new Map();
  for (const v of votesRaw) {
    if (!v.deliberation_id) continue;
    if (!votesByDelib.has(v.deliberation_id)) votesByDelib.set(v.deliberation_id, []);
    votesByDelib.get(v.deliberation_id).push({
      diretor_id: v.voter_person_id,
      diretor_nome: nameById.get(v.voter_person_id) || v.voter_person_id,
      tipo_voto: v.vote_direction,
      is_divergente: !!v.is_dissent,
      is_nominal: !!v.is_nominal,
    });
  }

  return delibsRaw.map((d) => ({
    id: d.id,
    tipo_documento: "deliberacao", // <- faz passar no isFinalDecisionRecord
    agencia_id: d.agency_id,
    numero_deliberacao: d.deliberation_number,
    reuniao_ordinaria: d.reuniao_ordinaria,
    data_reuniao: d.data_reuniao,
    interessado: d.interessado,
    processo: d.process_number,
    microtema: d.theme,
    resultado: d.result,
    pauta_interna: !!d.pauta_interna,
    auto_classified: !!d.auto_classified,
    extraction_confidence: d.confidence_score != null ? d.confidence_score : null,
    votos: votesByDelib.get(d.id) || [],
  }));
}

// Resolve a sigla da agencia -> id (filtro opcional). Retorna undefined se sigla
// desconhecida (o caller responde vazio).
async function resolveAgency(supabase, acronym) {
  if (!acronym) return { agencyId: null };
  const { data } = await supabase.from("agencies").select("id").eq("acronym", String(acronym).toUpperCase()).maybeSingle();
  if (!data) return { agencyId: null, unknown: true };
  return { agencyId: data.id };
}

// Serve uma metrica de votos. Retorna { ok, type, data } | { ok:false, error }.
async function serveVoteMetric(supabase, type, query) {
  const { agencyId, unknown } = await resolveAgency(supabase, query.agency);
  if (unknown) return { ok: true, type, data: null, note: "agencia desconhecida" };
  const delibs = await loadDeliberacoes(supabase, agencyId);

  // Metricas parametrizadas por id (perfil de diretor / detalhe).
  if (type === "votos_diretor" && query.id) return { ok: true, type, data: M.computeDiretorProfile(delibs, String(query.id)) };
  if (type === "votos_delib" && query.id) return { ok: true, type, data: M.computeDelibById(delibs, String(query.id)) };

  const fn = BY_AGENCY[type];
  if (!fn) return { ok: false, error: `metrica de voto invalida: ${type}` };
  return { ok: true, type, data: fn(delibs, agencyId) };
}

module.exports = { serveVoteMetric, loadDeliberacoes };
