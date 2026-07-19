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
  const delibIds = delibsRaw.map((d) => d.id);

  // Votos SO das deliberacoes carregadas (nao varre a tabela votes inteira).
  const votesRaw = [];
  for (let i = 0; i < delibIds.length; i += 200) {
    const { data, error } = await supabase.from("votes")
      .select("deliberation_id, voter_person_id, vote_direction, is_dissent, is_nominal")
      .in("deliberation_id", delibIds.slice(i, i + 200));
    if (error) throw new Error(`votes: ${error.message}`);
    votesRaw.push(...(data || []));
  }
  const personIds = [...new Set(votesRaw.map((v) => v.voter_person_id).filter(Boolean))];
  const nameById = new Map();
  for (let i = 0; i < personIds.length; i += 300) {
    const { data } = await supabase.from("people").select("id, full_name").in("id", personIds.slice(i, i + 300));
    for (const p of data || []) nameById.set(p.id, p.full_name);
  }
  // Siglas das agencias (p/ o campo agencia.sigla que computeReunioes* le).
  const agIds = [...new Set(delibsRaw.map((d) => d.agency_id).filter(Boolean))];
  const siglaById = new Map();
  for (let i = 0; i < agIds.length; i += 300) {
    const { data } = await supabase.from("agencies").select("id, acronym").in("id", agIds.slice(i, i + 300));
    for (const a of data || []) siglaById.set(a.id, a.acronym);
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
    agencia: { sigla: siglaById.get(d.agency_id) || null }, // computeReunioes* le agencia.sigla
    numero_deliberacao: d.deliberation_number,
    numero_reuniao: d.reuniao_ordinaria,   // computeReunioesList agrupa por numero_reuniao
    tipo_reuniao: null,
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

// === M20.2: votacao legislativa nominal — reusa as MESMAS funcoes de vote-metrics ===

// Traduz o voto CRU legislativo p/ as strings IRIS EXATAS (Favoravel/Desfavoravel/
// Abstencao). Critico: computeVotacaoFidelidade so conta "Desfavoravel" exato.
function mapVotoLeg(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (v === "sim") return "Favoravel";
  if (v === "nao" || v === "não") return "Desfavoravel";
  return "Abstencao"; // Abstencao, Obstrucao, Art.17, ausente — nao-posicional
}

// Le legislative_votacoes + legislative_votes e MAPEIA p/ o shape IRIS (Deliberacao[]).
async function loadVotacoesLeg(supabase) {
  const votacoes = await paginate(
    supabase, "legislative_votacoes",
    "id, proposicao_id, casa, descricao, data_votacao, resultado"
  );
  if (!votacoes.length) return [];
  const votIds = votacoes.map((v) => v.id);

  const votesRaw = [];
  for (let i = 0; i < votIds.length; i += 200) {
    const { data, error } = await supabase.from("legislative_votes")
      .select("votacao_id, person_id, parlamentar_nome, external_person_id, voto, orientacao, partido")
      .in("votacao_id", votIds.slice(i, i + 200));
    if (error) throw new Error(`legislative_votes: ${error.message}`);
    votesRaw.push(...(data || []));
  }

  const votesByVot = new Map();
  for (const vt of votesRaw) {
    if (!votesByVot.has(vt.votacao_id)) votesByVot.set(vt.votacao_id, []);
    const votoMapped = mapVotoLeg(vt.voto);
    const orientMapped = vt.orientacao ? mapVotoLeg(vt.orientacao) : null;
    const liberado = !vt.orientacao || /liber/i.test(vt.orientacao);
    votesByVot.get(vt.votacao_id).push({
      // diretor_id = person_id quando resolvido (p/ o perfil por pessoa casar).
      diretor_id: vt.person_id || vt.external_person_id || vt.parlamentar_nome,
      diretor_nome: vt.parlamentar_nome || vt.person_id,
      tipo_voto: votoMapped,
      // divergente = votou contra a orientacao do PROPRIO partido (fidelidade).
      is_divergente: !!(!liberado && orientMapped && votoMapped !== orientMapped),
      is_nominal: true,
    });
  }

  return votacoes.map((v) => ({
    id: v.id,
    tipo_documento: "deliberacao", // <- passa no isFinalDecisionRecord
    agencia_id: null,
    agencia: { sigla: v.casa || "Congresso" },
    numero_deliberacao: null,
    numero_reuniao: (v.data_votacao || "").slice(0, 7) || null, // proxy de "reuniao" (mes)
    reuniao_ordinaria: null,
    data_reuniao: v.data_votacao,
    interessado: null,
    processo: v.proposicao_id,
    microtema: null,
    resultado: v.resultado,
    pauta_interna: false,
    auto_classified: false,
    extraction_confidence: null,
    votos: votesByVot.get(v.id) || [],
  }));
}

// Serve uma metrica de votacao LEGISLATIVA (type = "votos_leg_*"). Reusa o mesmo
// BY_AGENCY (mapeando o prefixo) e as funcoes puras — zero mudanca em vote-metrics.
async function serveLegVoteMetric(supabase, type, query) {
  const delibs = await loadVotacoesLeg(supabase);
  const baseType = type.replace("votos_leg_", "votos_");
  if (baseType === "votos_diretor" && query.id) return { ok: true, type, data: M.computeDiretorProfile(delibs, String(query.id)) };
  if (baseType === "votos_delib" && query.id) return { ok: true, type, data: M.computeDelibById(delibs, String(query.id)) };
  const fn = BY_AGENCY[baseType];
  if (!fn) return { ok: false, error: `metrica de voto legislativa invalida: ${type}` };
  return { ok: true, type, data: fn(delibs, null) };
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

module.exports = { serveVoteMetric, loadDeliberacoes, serveLegVoteMetric, loadVotacoesLeg };
