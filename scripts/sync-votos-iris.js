// Seed do modulo "Voto dos Diretores": LE o Supabase do IRIS (agencias/diretores/
// mandatos/deliberacoes/votos) e faz UPSERT no LINCE (people/mandates/deliberations/
// votes). O pipeline de PDF/coleta fica no IRIS; o LINCE consome o resultado. SEM IA.
// Re-executavel (idempotente). Requer, alem das creds do LINCE (.env):
//   IRIS_SUPABASE_URL, IRIS_SUPABASE_SERVICE_KEY   (do projeto Supabase do IRIS)
//
// Uso: node scripts/sync-votos-iris.js [--dry-run]
//
// Mapeamento diretor->people: por NOME normalizado (+ nome_variantes). Homonimo
// ambiguo na base local -> cria um novo people (nao arrisca atribuir a errada).
// LGPD: diretores nao tem CPF; nada de CPF e persistido.
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const { getSupabase } = require("../lib/supabase");
const { normalizeNameKey } = require("../lib/text");
const { fetchAllPeople, buildPeopleNameIndex } = require("../lib/tse-match");

// Le TODAS as linhas de uma tabela do LINCE paginando (PostgREST corta em 1000).
async function fetchAllLince(client, table, columns) {
  const all = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client.from(table).select(columns)
      .order("id", { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new Error(`LINCE ${table}: ${error.message}`);
    all.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return all;
}

const dryRun = process.argv.includes("--dry-run");

function irisClient() {
  const url = process.env.IRIS_SUPABASE_URL;
  const key = process.env.IRIS_SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error("Faltam IRIS_SUPABASE_URL / IRIS_SUPABASE_SERVICE_KEY no .env (creds do Supabase do IRIS).");
    process.exit(1);
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

// Le TODAS as linhas de uma tabela paginando (PostgREST corta em 1000).
async function fetchAll(client, table, columns = "*") {
  const all = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client.from(table).select(columns)
      .order("id", { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new Error(`IRIS ${table}: ${error.message}`);
    all.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return all;
}

async function main() {
  const iris = irisClient();
  const lince = getSupabase();

  // ── 1) Agencias: casa por sigla<->acronym; cria a que faltar (ex.: ARTESP). ──
  const irisAgencias = await fetchAll(iris, "agencias", "id, sigla, nome, nome_completo");
  const { data: linceAgencies } = await lince.from("agencies").select("id, acronym, name");
  const agByAcr = new Map((linceAgencies || []).map((a) => [(a.acronym || "").toUpperCase(), a.id]));
  const agMap = new Map(); // iris agencia_id -> lince agency_id
  let agCreated = 0;
  for (const a of irisAgencias) {
    const acr = (a.sigla || "").toUpperCase();
    let lid = agByAcr.get(acr);
    if (!lid && !dryRun) {
      const { data, error } = await lince.from("agencies")
        .insert({ acronym: acr, name: a.nome || acr, sector: "regulatory" }).select("id").single();
      if (error) { console.error(`  agencia ${acr}: ${error.message}`); continue; }
      lid = data.id; agByAcr.set(acr, lid); agCreated++;
    }
    if (lid) agMap.set(a.id, lid);
  }
  console.log(`Agencias: ${irisAgencias.length} no IRIS | ${agCreated} criadas no LINCE`);

  // ── 2) Diretores -> people (por nome + variantes; cria se faltar). ──
  // Paginado (people tem milhares) + descarte de homonimos — ver lib/tse-match.
  const lincePeople = await fetchAllPeople(lince);
  const { byNameKey: byKey, ambiguous } = buildPeopleNameIndex(lincePeople);
  const irisDiretores = await fetchAll(iris, "diretores", "id, nome, nome_variantes, agencia_id, cargo");
  const dirMap = new Map(); // iris diretor_id -> lince person_id
  let dirMatched = 0, dirCreated = 0;
  for (const d of irisDiretores) {
    const candidates = [d.nome, ...(Array.isArray(d.nome_variantes) ? d.nome_variantes : [])];
    let pid = null;
    for (const nm of candidates) {
      const key = normalizeNameKey(nm);
      if (key && byKey.has(key)) { pid = byKey.get(key); break; }
    }
    if (pid) { dirMatched++; }
    else if (!dryRun) {
      const { data, error } = await lince.from("people")
        .insert({ full_name: d.nome, role: d.cargo || "Diretor", agency_id: agMap.get(d.agencia_id) || null }).select("id").single();
      if (error) { console.error(`  diretor "${d.nome}": ${error.message}`); continue; }
      pid = data.id; dirCreated++;
      const key = normalizeNameKey(d.nome);
      if (key && !ambiguous.has(key)) byKey.set(key, pid);
    }
    if (pid) dirMap.set(d.id, pid);
  }
  console.log(`Diretores: ${irisDiretores.length} | casados: ${dirMatched} | criados: ${dirCreated}`);

  // ── 3) Mandatos -> mandates (dedup por person+agency+started_at). ──
  const irisMandatos = await fetchAll(iris, "mandatos", "id, diretor_id, data_inicio, data_fim, cargo");
  let mandIns = 0;
  for (const m of irisMandatos) {
    const pid = dirMap.get(m.diretor_id);
    const dir = irisDiretores.find((d) => d.id === m.diretor_id);
    const aid = dir ? agMap.get(dir.agencia_id) : null;
    if (!pid || !aid || dryRun) continue;
    const { data: ex } = await lince.from("mandates").select("id")
      .eq("person_id", pid).eq("agency_id", aid).eq("started_at", m.data_inicio).limit(1);
    if (ex && ex.length) continue;
    const { error } = await lince.from("mandates").insert({
      person_id: pid, agency_id: aid, role: m.cargo || null,
      started_at: m.data_inicio || null, ended_at: m.data_fim || null,
      appointment_act: `IRIS mandato ${m.id}`, confidence_score: 1
    });
    if (error) console.error(`  mandato: ${error.message}`); else mandIns++;
  }
  console.log(`Mandatos: ${irisMandatos.length} | inseridos: ${mandIns}`);

  // ── 4) Deliberacoes -> deliberations (idempotente por evidence.iris_id). ──
  const existingDelibs = await fetchAllLince(lince, "deliberations", "id, evidence"); // paginado
  const delibByIris = new Map();
  for (const d of existingDelibs || []) {
    const iid = d.evidence && !Array.isArray(d.evidence) ? d.evidence.iris_id : null;
    if (iid) delibByIris.set(iid, d.id);
  }
  const irisDelibs = await fetchAll(iris, "deliberacoes",
    "id, agencia_id, numero_deliberacao, reuniao_ordinaria, data_reuniao, interessado, processo, microtema, resultado, pauta_interna, resumo_pleito, extraction_confidence, auto_classified, raw_text");
  const delibMap = new Map(); // iris delib_id -> lince delib_id
  let delibIns = 0;
  for (const d of irisDelibs) {
    const aid = agMap.get(d.agencia_id);
    if (!aid) continue;
    let lid = delibByIris.get(d.id);
    if (lid) { delibMap.set(d.id, lid); continue; }
    if (dryRun) { delibMap.set(d.id, `dry:${d.id}`); continue; }
    const title = d.interessado || d.resumo_pleito || (d.numero_deliberacao ? `Deliberação ${d.numero_deliberacao}` : "Deliberação");
    const { data, error } = await lince.from("deliberations").insert({
      agency_id: aid, deliberation_number: d.numero_deliberacao || null, process_number: d.processo || null,
      title: String(title).slice(0, 500), theme: d.microtema || null, result: d.resultado || null,
      data_reuniao: d.data_reuniao || null, reuniao_ordinaria: d.reuniao_ordinaria || null,
      interessado: d.interessado || null, pauta_interna: !!d.pauta_interna,
      auto_classified: !!d.auto_classified, raw_text: d.raw_text || null,
      confidence_score: d.extraction_confidence != null ? d.extraction_confidence : 0,
      evidence: { source: "iris", iris_id: d.id }
    }).select("id").single();
    if (error) { console.error(`  delib ${d.numero_deliberacao}: ${error.message}`); continue; }
    lid = data.id; delibIns++; delibByIris.set(d.id, lid);
    delibMap.set(d.id, lid);
  }
  console.log(`Deliberacoes: ${irisDelibs.length} | inseridas: ${delibIns} | ja existiam: ${irisDelibs.length - delibIns}`);

  // ── 5) Votos -> votes (upsert por deliberation_id+voter_person_id). ──
  const irisVotos = await fetchAll(iris, "votos", "id, deliberacao_id, diretor_id, tipo_voto, is_divergente, is_nominal");
  const rows = [];
  let skipped = 0;
  for (const v of irisVotos) {
    const did = delibMap.get(v.deliberacao_id);
    const pid = dirMap.get(v.diretor_id);
    if (!did || !pid || String(did).startsWith("dry:")) { skipped++; continue; }
    rows.push({
      deliberation_id: did, voter_person_id: pid, vote_direction: v.tipo_voto,
      is_dissent: !!v.is_divergente, is_nominal: !!v.is_nominal, confidence_score: v.is_nominal ? 0.95 : 0.7,
      evidence: { source: "iris" }
    });
  }
  let votesUp = 0;
  if (!dryRun && rows.length) {
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const { error, count } = await lince.from("votes")
        .upsert(rows.slice(i, i + CHUNK), { onConflict: "deliberation_id,voter_person_id", count: "exact" });
      if (error) console.error(`  votos batch: ${error.message}`); else votesUp += count || 0;
    }
  }
  console.log(`Votos: ${irisVotos.length} no IRIS | mapeados: ${rows.length} | upsert: ${votesUp} | sem match: ${skipped}`);
  console.log(`\n=== Sync IRIS->LINCE concluido ===${dryRun ? " (dry-run)" : ""}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
