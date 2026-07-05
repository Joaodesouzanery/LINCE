// Logica compartilhada de pos-processamento de atos do DOU:
// cria diretores (people), mandatos (mandates) e conexoes (relationships)
// a partir dos atos de pessoal (Secao 2), combinando regex + entidades de IA.
// Tambem: matcher de monitores de vigilancia (usado pelo cron E pelo runner local).
const { extractPeopleFromAto } = require("./dou");
const { upsertPerson } = require("./people");
const { normalizeName } = require("./text");

// Processa um ato de pessoal ja gravado em `documents`.
// doc = { id, agency_id, agency_acronym, published_at, title, text, aiEntities }
// Retorna { people, mandates, relationships } (contagens).
async function processPeopleFromDoc(supabase, doc) {
  // 1) Pessoas via regex (sempre disponivel, conf 0.6)
  const regexPeople = extractPeopleFromAto(doc.text).map((p) => ({ ...p, confidence: 0.6 }));
  // 2) Pessoas via IA (quando houver, conf 0.9) - merge por nome
  const aiPeople = (doc.aiEntities || [])
    .filter((e) => e.kind === "person" && e.name)
    .map((e) => ({ name: e.name, role: e.role || "Dirigente", action: "nomeacao", confidence: 0.9 }));

  const byName = new Map();
  for (const p of [...regexPeople, ...aiPeople]) {
    const key = p.name.toUpperCase();
    const prev = byName.get(key);
    if (!prev || p.confidence > prev.confidence) byName.set(key, p);
  }

  let people = 0, mandates = 0, rels = 0;
  const relsToInsert = [];

  for (const p of byName.values()) {
    const person = await upsertPerson(supabase, {
      full_name: p.name,
      role: p.role,
      agency_id: doc.agency_id
    });
    people++;

    // Mandato (idempotente por person+agency+ato)
    const { data: existing } = await supabase
      .from("mandates")
      .select("id")
      .eq("person_id", person.id)
      .eq("agency_id", doc.agency_id)
      .eq("appointment_act", doc.title)
      .maybeSingle();
    if (!existing) {
      await supabase.from("mandates").insert({
        person_id: person.id,
        agency_id: doc.agency_id,
        role: p.role,
        started_at: p.action === "nomeacao" ? doc.published_at : null,
        ended_at: p.action === "exoneracao" ? doc.published_at : null,
        appointment_act: doc.title,
        source_document_id: doc.id,
        confidence_score: p.confidence
      });
      mandates++;
    }

    relsToInsert.push({
      from_kind: "agency",
      from_id: doc.agency_id,
      to_kind: "person",
      to_id: person.id,
      relationship: "employs",
      source_document_id: doc.id,
      confidence_score: p.confidence,
      metadata: { action: p.action, role: p.role }
    });

    // Alertas por regra (sem IA): nomeacao/exoneracao -> alert
    if (p.action === "nomeacao" || p.action === "exoneracao") {
      await supabase.from("alerts").upsert({
        alert_type: p.action,
        severity: "info",
        target_kind: "person",
        target_id: person.id,
        title: `${p.action === "nomeacao" ? "Nomeação" : "Exoneração"}: ${p.name}`,
        body: `${p.role} na ${doc.agency_acronym || "agência"}. Ato: ${(doc.title || "").slice(0, 120)}`,
        source_document_id: doc.id,
        metadata: { agency_id: doc.agency_id, agency_acronym: doc.agency_acronym }
      }, { onConflict: "source_document_id,target_id,alert_type", ignoreDuplicates: true });
    }
  }

  if (relsToInsert.length) {
    // ON CONFLICT DO NOTHING: evita duplicatas se relationships tiver constraint unique
    await supabase.from("relationships").upsert(relsToInsert, {
      onConflict: "from_kind,from_id,to_kind,to_id,relationship",
      ignoreDuplicates: true
    });
    rels = relsToInsert.length;
  }

  // Alertas de sanção por palavra-chave no texto do ato
  const textLower = (doc.text || "").toLowerCase();
  const SANCAO_KW = ["sanção", "sancao", "multa", "infração", "infraçao", "autuação", "autuacao", "embargo", "interdição"];
  if (SANCAO_KW.some((kw) => textLower.includes(kw))) {
    await supabase.from("alerts").upsert({
      alert_type: "sancao",
      severity: "high",
      target_kind: "agency",
      target_id: doc.agency_id,
      title: `Ato sancionatório: ${doc.agency_acronym || "agência"}`,
      body: (doc.title || "").slice(0, 200),
      source_document_id: doc.id,
      metadata: { agency_id: doc.agency_id }
    }, { onConflict: "source_document_id,target_id,alert_type", ignoreDuplicates: true });
  }

  return { people, mandates, relationships: rels };
}

// ── Monitores de vigilância ────────────────────────────────────────────────
// Roda a cada ingestao: cada doc novo e testado contra os monitores ativos e
// gera alerts com alert_type='monitor' (dedupe por doc+monitor via onConflict).

async function loadActiveMonitors(supabase) {
  const { data } = await supabase.from("monitors").select("*").eq("active", true);
  return data || [];
}

// Regex tolerante a pontuacao para CPF/CNPJ no texto do ato.
// Nao usar onlyDigits(texto inteiro): concatenar todos os digitos do ato cria
// falsos positivos entre numeros vizinhos.
function docNumberRegex(digits) {
  return new RegExp(digits.split("").join("[.\\/\\- ]?"));
}

// Puro/sincrono (testavel): monitores x contexto de um doc -> alertas a emitir.
// docCtx = { docId, title, text, agencyId, agencyAcronym, publishedAt, aiEntities }
function matchMonitorsForDoc(monitors, docCtx) {
  if (!monitors.length) return [];
  const haystack = normalizeName(`${docCtx.title || ""} ${(docCtx.text || "").slice(0, 20000)}`);
  const entityKeys = new Set(
    (docCtx.aiEntities || []).map((e) => normalizeName(e?.name || "")).filter(Boolean)
  );
  const hits = [];
  for (const m of monitors) {
    let matched = null;
    if (m.kind === "agency") {
      matched = m.agency_id && m.agency_id === docCtx.agencyId ? "agency" : null;
    } else if (m.kind === "keyword") {
      matched = haystack.includes(m.normalized_pattern) ? "text" : null;
    } else {
      // person | company
      if (m.cpf_cnpj && docNumberRegex(m.cpf_cnpj).test(docCtx.text || "")) matched = "document_number";
      else if (haystack.includes(m.normalized_pattern)) matched = "text";
      else if (entityKeys.has(m.normalized_pattern)) matched = "ai_entity";
    }
    if (!matched) continue;
    hits.push({
      monitorId: m.id,
      alert: {
        alert_type: "monitor",
        severity: m.severity || "medium",
        target_kind: "monitor",
        target_id: m.id,
        title: `Monitor: ${m.label}`,
        body: (docCtx.title || "").slice(0, 200),
        source_document_id: docCtx.docId,
        metadata: {
          monitor_id: m.id,
          monitor_kind: m.kind,
          pattern: m.pattern,
          matched,
          agency_acronym: docCtx.agencyAcronym || null,
          published_at: docCtx.publishedAt || null
        }
      }
    });
  }
  return hits;
}

// Grava os alertas (dedupe) e atualiza hit_count/last_hit_at dos monitores.
// monitorHits = Map(monitorId -> n de hits nesta rodada).
async function flushMonitorAlerts(supabase, alertRows, monitorHits) {
  if (!alertRows.length) return 0;
  await supabase.from("alerts").upsert(alertRows, {
    onConflict: "source_document_id,target_id,alert_type",
    ignoreDuplicates: true
  });
  const now = new Date().toISOString();
  for (const [monitorId, n] of monitorHits) {
    // Read-modify-write e seguro: o cron e o unico escritor destes campos.
    const { data: cur } = await supabase.from("monitors").select("hit_count").eq("id", monitorId).maybeSingle();
    await supabase.from("monitors")
      .update({ hit_count: (cur?.hit_count || 0) + n, last_hit_at: now })
      .eq("id", monitorId);
  }
  return alertRows.length;
}

module.exports = { processPeopleFromDoc, loadActiveMonitors, matchMonitorsForDoc, flushMonitorAlerts };
