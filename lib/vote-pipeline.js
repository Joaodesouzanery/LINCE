// Esteira "Voto dos Diretores": PDF/texto -> deliberacao + votos, no LINCE.
// COMPARTILHADA pelo upload manual (api/intelligence ?type=upload_deliberacao) e
// pelo auto-coletor (GitHub Actions). Reusa as libs portadas do IRIS. SEM IA.
//
// Depende de um ROSTER de diretores no LINCE: people com mandate na agencia. Sem
// isso, o match nominal falha (nenhum voto nominal). Semear via sync-votos-iris
// ou cadastro manual dos diretores+mandatos da agencia.
const { extractFields } = require("./nlp-extractor");
const { classifyMicrotema } = require("./vote-classifier");
const { buildVotoRows, shouldInferVotesFromMandate } = require("./vote-inference");

// pdf-parse: importar o lib interno evita o bloco de debug que le um PDF de teste
// no require quando rodado direto.
function loadPdfParse() {
  try { return require("pdf-parse/lib/pdf-parse.js"); }
  catch { return require("pdf-parse"); }
}

// Roster da agencia: todos com mandato + os ATIVOS na data da reuniao. Shape que
// o vote-inference espera ({ id, nome, nome_variantes }).
async function loadDiretores(supabase, agencyId, dataReuniao) {
  const { data: mand, error } = await supabase.from("mandates")
    .select("person_id, started_at, ended_at").eq("agency_id", agencyId);
  if (error) throw new Error(`mandates: ${error.message}`);
  const ids = [...new Set((mand || []).map((m) => m.person_id).filter(Boolean))];
  const nameById = new Map();
  for (let i = 0; i < ids.length; i += 300) {
    const { data, error: pErr } = await supabase.from("people").select("id, full_name").in("id", ids.slice(i, i + 300));
    if (pErr) throw new Error(`people: ${pErr.message}`); // nao engolir -> roster vazio silencioso viraria "0 votos ok"
    for (const p of data || []) nameById.set(p.id, p.full_name);
  }
  const all = new Map(), active = new Map();
  for (const m of mand || []) {
    const nome = nameById.get(m.person_id);
    if (!nome) continue;
    const rec = { id: m.person_id, nome, nome_variantes: [] };
    all.set(m.person_id, rec);
    if (dataReuniao && m.started_at && m.started_at <= dataReuniao && (!m.ended_at || m.ended_at >= dataReuniao)) {
      active.set(m.person_id, rec);
    }
  }
  return { diretoresList: [...all.values()], activeDiretoresList: [...active.values()] };
}

// Processa UM documento (buffer PDF ou texto ja extraido) -> deliberacao + votos.
// Retorna { ok, delibId, numero, votos, ... } | { ok:false, error }.
async function processPdfToVotos(supabase, input) {
  const { buffer, agencyId: agIn, agencyAcronym, filename } = input || {};
  let raw = input && input.text;
  if (!raw && buffer) {
    const pdfParse = loadPdfParse();
    const r = await pdfParse(buffer).catch((e) => ({ text: "", _err: e.message }));
    raw = r.text || "";
  }
  if (!raw || raw.trim().length < 40) return { ok: false, error: "PDF sem texto extraivel (escaneado? precisa OCR)" };

  // Resolve agencia (id direto ou por sigla).
  let aid = agIn || null;
  if (!aid && agencyAcronym) {
    const { data } = await supabase.from("agencies").select("id").eq("acronym", String(agencyAcronym).toUpperCase()).maybeSingle();
    aid = data ? data.id : null;
  }
  if (!aid) return { ok: false, error: "agencia nao resolvida (passe agencyId ou agencyAcronym)" };

  const f = extractFields(raw);
  const microtema = f.microtema || (classifyMicrotema(raw) || {}).microtema || null;
  if (!f.numero_deliberacao) return { ok: false, error: "numero de deliberacao nao encontrado no texto", fields: f };

  // Deliberacao (dedup por agency + numero). Checar erro do SELECT (senao um
  // erro transiente faria delibId=null -> insert duplicado). Se ja existe,
  // ATUALIZA a metadata (re-processo com extracao melhor).
  const delibPayload = {
    agency_id: aid, deliberation_number: f.numero_deliberacao, process_number: f.processo || null,
    title: String(f.interessado || f.resumo_pleito || `Deliberação ${f.numero_deliberacao}`).slice(0, 500),
    theme: microtema, result: f.resultado || null, data_reuniao: f.data_reuniao || null,
    reuniao_ordinaria: f.reuniao_ordinaria || null, interessado: f.interessado || null,
    pauta_interna: !!f.pauta_interna, auto_classified: true, raw_text: String(raw).slice(0, 200000),
    confidence_score: 0.7, evidence: { source: input.source || "upload", filename: filename || null }
  };
  const { data: exists, error: selErr } = await supabase.from("deliberations").select("id")
    .eq("agency_id", aid).eq("deliberation_number", f.numero_deliberacao).limit(1);
  if (selErr) return { ok: false, error: `dedup deliberacao: ${selErr.message}` };
  let delibId = exists && exists.length ? exists[0].id : null;
  if (delibId) {
    const { error } = await supabase.from("deliberations").update(delibPayload).eq("id", delibId);
    if (error) return { ok: false, error: `update deliberacao: ${error.message}` };
  } else {
    const { data, error } = await supabase.from("deliberations").insert(delibPayload).select("id").single();
    if (error) return { ok: false, error: `insert deliberacao: ${error.message}` };
    delibId = data.id;
  }

  // Roster + inferencia conservadora + construcao dos votos (nominal + inferido).
  const { diretoresList, activeDiretoresList } = await loadDiretores(supabase, aid, f.data_reuniao);
  const inferFromMandate = shouldInferVotesFromMandate({
    resultado: f.resultado, tipo_documento: "deliberacao", unanimidadeDetectada: f.unanimidade_detectada,
    nomes: f.nomes_votacao, nomesContra: f.nomes_votacao_contra, nomesAbstencao: f.nomes_votacao_abstencao,
    dataReuniao: f.data_reuniao
  });
  const votoRows = buildVotoRows({
    deliberacao_id: delibId,
    nomes: [...new Set([...(f.nomes_votacao || []), ...(f.nomes_votacao_favor || [])])],
    nomesContra: f.nomes_votacao_contra || [],
    nomesAusente: f.nomes_votacao_ausente || [],
    nomesAbstencao: f.nomes_votacao_abstencao || [],
    diretoresList, activeDiretoresList, inferFromMandate, resultado: f.resultado
  });

  const rows = votoRows.map((v) => ({
    deliberation_id: v.deliberacao_id, voter_person_id: v.diretor_id,
    vote_direction: v.tipo_voto, is_dissent: v.is_divergente, is_nominal: v.is_nominal,
    confidence_score: v.is_nominal ? 0.9 : 0.6, evidence: { source: input.source || "upload" }
  }));
  let votos = 0;
  if (rows.length) {
    // Substitui os votos da deliberacao: re-processo (extracao melhor) nao deixa
    // votos stale de uma rodada anterior. So limpa quando HA novos votos.
    const { error: delErr } = await supabase.from("votes").delete().eq("deliberation_id", delibId);
    if (delErr) return { ok: false, error: `limpar votos: ${delErr.message}`, delibId };
    const { error, count } = await supabase.from("votes").insert(rows, { count: "exact" });
    if (error) return { ok: false, error: `insert votos: ${error.message}`, delibId };
    votos = count != null ? count : rows.length;
  }
  return {
    ok: true, delibId, numero: f.numero_deliberacao, resultado: f.resultado || null,
    microtema, votos, diretores_no_roster: diretoresList.length,
    nominais: rows.filter((r) => r.is_nominal).length
  };
}

module.exports = { processPdfToVotos, loadDiretores };
