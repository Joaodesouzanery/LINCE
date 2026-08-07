// M27 — "Score de Patrocinador" (Eventos F-EVT4). Sourcing + rubrica DETERMINISTICA
// (100 pts, so dado publico) com EVIDENCIA obrigatoria + cap de confianca.
// Compartilhado pelo endpoint (pontuacao inline) e por scripts/score-sponsors.js
// (screening externo em lote / re-score). Ver docs/patrocinio-score.md.
//
// Principios (da co-design com o usuario): o EIXO do fit e o contrato-com-orgao-alvo
// (a aresta que ninguem tem); CNAE e sinal menor/ruidoso; relacionamento NAO pontua
// (entra como override manual de tier, no backend). Evidencia obrigatoria por categoria:
// categoria sem evidencia -> nao pontua e vira `capped` (confianca menor). Snapshot de
// evidencia (as_of) p/ re-pontuar sobre o MESMO dado. NUNCA lanca: retorna { ok, ... }.
const { onlyDigits } = require("./text");

const CONTRACT_SCAN_CAP = 8000;   // teto do scan de contratos por run (sem corte silencioso -> flag truncado)
const ENRICH_CAP = 120;           // quantas empresas (ranqueadas por Sigma-contrato) enriquecer/pontuar

const DEFAULT_WEIGHTS = { fit_contrato: 30, fit_cnae: 15, sinal_valor: 20, sinal_recencia: 10, propensao_doacao: 15, propensao_grafo: 10 };
const DEFAULT_TIERS = [{ tier: 1, min: 80 }, { tier: 2, min: 55 }, { tier: 3, min: 30 }];
const DEFAULT_COTA_BANDS = [{ min: 80, rank: 1 }, { min: 55, rank: 2 }, { min: 0, rank: 3 }];

const DIA = 86400000;
function toDate(s) { return s ? new Date(String(s).slice(0, 10) + "T12:00:00Z") : null; }
function daysSince(dateStr, refMs) { const d = toDate(dateStr); return d ? Math.round((refMs - d.getTime()) / DIA) : null; }

// Formatos possiveis de um CNPJ p/ casar com donor_document (o loader grava 14 digitos).
function cnpjVariants(digits) {
  const d = onlyDigits(digits);
  if (d.length !== 14) return d ? [d] : [];
  const fmt = d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
  return [d, fmt];
}

// ── Sourcing: agrega contratos dos orgaos-alvo por empresa (chave = CNPJ normalizado) ──
// Retorna buckets [{ empresa_key, cnpj, company_id, nome, soma, count, max_signed_at, contratos[] }].
// empresa_key = SEMPRE o CNPJ normalizado; fallback `cid:<id>` so p/ quem nao tem CNPJ.
async function sourceCandidates(supabase, orgaos, cap = CONTRACT_SCAN_CAP) {
  const buckets = new Map();       // key -> bucket
  const cidOnly = new Map();       // company_id (sem cnpj no contrato) -> key temporaria `cid:<id>`
  let scanned = 0, truncado = false;
  for (let from = 0; from < cap; from += 1000) {
    const { data, error } = await supabase
      .from("contracts")
      .select("supplier_cnpj, supplier_company_id, supplier_name, value, signed_at, agency_id, pncp_id")
      .in("agency_id", orgaos)
      .order("signed_at", { ascending: false, nullsFirst: false })
      .range(from, from + 999);
    if (error) return { ok: false, error: `contracts: ${error.message}` };
    for (const c of data || []) {
      scanned++;
      const digits = onlyDigits(c.supplier_cnpj);
      let key;
      if (digits.length >= 8) key = digits;
      else if (c.supplier_company_id) { key = `cid:${c.supplier_company_id}`; cidOnly.set(c.supplier_company_id, key); }
      else continue; // sem cnpj e sem empresa -> nao da p/ deduplicar/suprimir com seguranca
      let b = buckets.get(key);
      if (!b) { b = { empresa_key: key, cnpj: digits.length >= 8 ? digits : null, company_id: c.supplier_company_id || null, nome: c.supplier_name || null, soma: 0, count: 0, max_signed_at: null, contratos: [] }; buckets.set(key, b); }
      const v = Number(c.value) || 0;
      b.soma += v; b.count++;
      if (!b.company_id && c.supplier_company_id) b.company_id = c.supplier_company_id;
      if (!b.nome && c.supplier_name) b.nome = c.supplier_name;
      if (c.signed_at && (!b.max_signed_at || c.signed_at > b.max_signed_at)) b.max_signed_at = c.signed_at;
      if (b.contratos.length < 6) b.contratos.push({ pncp_id: c.pncp_id || null, value: v, signed_at: c.signed_at || null, agency_id: c.agency_id || null });
    }
    if (!data || data.length < 1000) break;
  }
  if (scanned >= cap) truncado = true;

  // Resolve CNPJ das empresas que so vieram por company_id e MERGE no bucket de CNPJ
  // (evita a mesma empresa em duas chaves entre runs -> duplicata silenciosa).
  const cidList = [...cidOnly.keys()];
  if (cidList.length) {
    for (let i = 0; i < cidList.length; i += 300) {
      const slice = cidList.slice(i, i + 300);
      const { data, error } = await supabase.from("companies").select("id, cnpj, legal_name").in("id", slice);
      if (error) return { ok: false, error: `companies(resolve): ${error.message}` };  // nao tratar erro de DB como "sem empresa" (quebraria dedup/supressao)
      for (const co of data || []) {
        const tmpKey = cidOnly.get(co.id);
        const tmp = buckets.get(tmpKey);
        if (!tmp) continue;
        const digits = onlyDigits(co.cnpj);
        if (digits.length >= 8) {
          buckets.delete(tmpKey);
          let real = buckets.get(digits);
          if (!real) { real = { empresa_key: digits, cnpj: digits, company_id: co.id, nome: tmp.nome || co.legal_name, soma: 0, count: 0, max_signed_at: null, contratos: [] }; buckets.set(digits, real); }
          real.soma += tmp.soma; real.count += tmp.count;
          if (!real.company_id) real.company_id = co.id;
          if (!real.nome) real.nome = tmp.nome || co.legal_name;
          if (tmp.max_signed_at && (!real.max_signed_at || tmp.max_signed_at > real.max_signed_at)) real.max_signed_at = tmp.max_signed_at;
          for (const ct of tmp.contratos) if (real.contratos.length < 6) real.contratos.push(ct);
        } else if (!tmp.nome && co.legal_name) { tmp.nome = co.legal_name; }
      }
    }
  }
  return { ok: true, buckets: [...buckets.values()], n_candidates: buckets.size, truncado };
}

// Enriquecimento (companies + doacoes PJ + grafo) SO das top-N empresas por Sigma-contrato.
async function enrichCandidates(supabase, buckets) {
  const cnpjs = buckets.map((b) => b.cnpj).filter(Boolean);
  const companyIds = buckets.map((b) => b.company_id).filter(Boolean);

  // companies (cnae/porte/situacao) por cnpj e por id
  const compByCnpj = new Map(), compById = new Map();
  // Erro de DB no enriquecimento NAO pode virar "sem dado" (corromperia o score em
  // silencio). Lanca -> runScore propaga -> o endpoint marca o run como failed.
  const fetchIn = async (col, vals, set) => {
    for (let i = 0; i < vals.length; i += 300) {
      const { data, error } = await supabase.from("companies").select("id, cnpj, cnae, size_label, registration_status, legal_name").in(col, vals.slice(i, i + 300));
      if (error) throw new Error(`companies: ${error.message}`);
      for (const c of data || []) set(c);
    }
  };
  if (cnpjs.length) await fetchIn("cnpj", [...new Set(cnpjs.flatMap(cnpjVariants))], (c) => { const d = onlyDigits(c.cnpj); if (d) compByCnpj.set(d, c); });
  if (companyIds.length) await fetchIn("id", [...new Set(companyIds)], (c) => compById.set(c.id, c));

  // doacoes PJ agregadas por doador (donor_document = 14 digitos, PJ)
  const donAgg = new Map();
  if (cnpjs.length) {
    const variants = [...new Set(cnpjs.flatMap(cnpjVariants))];
    for (let i = 0; i < variants.length; i += 300) {
      const { data, error } = await supabase.from("campaign_donations")
        .select("donor_document, amount, reference_year")
        .eq("donor_type", "PJ").in("donor_document", variants.slice(i, i + 300));
      if (error) throw new Error(`campaign_donations: ${error.message}`);
      for (const d of data || []) {
        const k = onlyDigits(d.donor_document);
        const a = donAgg.get(k) || { soma: 0, count: 0, sample: [] };
        a.soma += Number(d.amount) || 0; a.count++;
        if (a.sample.length < 3) a.sample.push({ amount: Number(d.amount) || 0, year: d.reference_year || null });
        donAgg.set(k, a);
      }
    }
  }

  // grafo: arestas company<->* (proximidade). Conta por company_id.
  const edgeCount = new Map();
  if (companyIds.length) {
    const ids = [...new Set(companyIds)];
    for (const [col] of [["from"], ["to"]]) {
      for (let i = 0; i < ids.length; i += 300) {
        const slice = ids.slice(i, i + 300);
        const { data, error } = await supabase.from("relationships")
          .select(`${col}_id`).eq(`${col}_kind`, "company").in(`${col}_id`, slice);
        if (error) throw new Error(`relationships: ${error.message}`);
        for (const r of data || []) { const id = r[`${col}_id`]; edgeCount.set(id, (edgeCount.get(id) || 0) + 1); }
      }
    }
  }

  for (const b of buckets) {
    const comp = (b.cnpj && compByCnpj.get(b.cnpj)) || (b.company_id && compById.get(b.company_id)) || null;
    if (comp && !b.company_id) b.company_id = comp.id;
    if (comp && (!b.cnpj) && comp.cnpj) b.cnpj = onlyDigits(comp.cnpj);
    b._enrich = {
      company: comp ? { cnae: comp.cnae || null, size_label: comp.size_label || null, registration_status: comp.registration_status || null, legal_name: comp.legal_name || null } : null,
      doacoes: (b.cnpj && donAgg.get(b.cnpj)) || { soma: 0, count: 0, sample: [] },
      edges: (b.company_id && edgeCount.get(b.company_id)) || 0
    };
  }
  return buckets;
}

// ── Rubrica: pontua UMA empresa (PURA). Retorna o registro de score. ──
function scoreOne(b, ctx) {
  const W = { ...DEFAULT_WEIGHTS, ...(ctx.weights || {}) };
  const en = b._enrich || { company: null, doacoes: { soma: 0, count: 0, sample: [] }, edges: 0 };
  const refMs = ctx.asOfMs;
  const sub = {};

  // fit (EIXO = contrato com orgao-alvo; CNAE menor)
  const factor = b.count >= 3 ? 1 : b.count === 2 ? 0.83 : 0.67;
  sub.fit_contrato = Math.round(W.fit_contrato * factor);
  const cnaePrefixes = Array.isArray(ctx.sectorCnae) ? ctx.sectorCnae : [];
  const cnae = (en.company && en.company.cnae) ? String(en.company.cnae) : "";
  const cnaeHit = cnaePrefixes.length > 0 && cnae && cnaePrefixes.some((p) => cnae.replace(/\D/g, "").startsWith(String(p).replace(/\D/g, "")));
  sub.fit_cnae = cnaeHit ? W.fit_cnae : 0;

  // sinal / porte (Sigma-valor + recencia)
  const soma = b.soma || 0;
  sub.sinal_valor = Math.round(W.sinal_valor * (soma >= 5e6 ? 1 : soma >= 1e6 ? 0.8 : soma >= 1e5 ? 0.55 : soma >= 1e4 ? 0.3 : soma > 0 ? 0.15 : 0));
  const rec = daysSince(b.max_signed_at, refMs);
  sub.sinal_recencia = rec == null ? 0 : Math.round(W.sinal_recencia * (rec <= 365 ? 1 : rec <= 730 ? 0.6 : rec <= 1095 ? 0.3 : 0.1));

  // propensao (doacoes PJ + grafo)
  const dsoma = en.doacoes.soma || 0;
  sub.propensao_doacao = Math.round(W.propensao_doacao * (dsoma >= 1e5 ? 1 : dsoma > 0 ? 0.55 : 0));
  sub.propensao_grafo = Math.round(W.propensao_grafo * (en.edges >= 3 ? 1 : en.edges >= 1 ? 0.5 : 0));

  // Evidencia por MACRO-categoria (fit/sinal/propensao) + cap de confianca.
  const capped = [];
  const fitEv = b.count > 0;                                   // contrato (sourced) -> sempre ha
  const sinalEv = soma > 0 || b.max_signed_at != null;
  const propEv = (en.doacoes.count || 0) > 0 || en.edges > 0;
  if (!propEv) capped.push("propensao");
  if (!cnaeHit) capped.push("fit_cnae");                       // dimensao CNAE nao usada (sem sector_cnae ou sem match)
  const macrosComEvidencia = [fitEv, sinalEv, propEv].filter(Boolean).length;

  let total = Object.values(sub).reduce((s, x) => s + x, 0);
  // Guarda: nao alcanca tier-1 (confianca alta) apoiado em UMA so dimensao.
  if (macrosComEvidencia <= 1 && total > 60) { total = 60; capped.push("total"); }
  total = Math.max(0, Math.min(100, total));

  const tiers = (Array.isArray(ctx.tiers) && ctx.tiers.length ? ctx.tiers : DEFAULT_TIERS).slice().sort((a, z) => z.min - a.min);
  let tier = null;
  for (const t of tiers) if (total >= t.min) { tier = t.tier; break; }

  // cota sugerida (deterministica): band do score -> rank -> cota do catalogo do evento.
  let cota_sugerida = null;
  if (tier != null) {
    const bands = (Array.isArray(ctx.cotaBands) && ctx.cotaBands.length ? ctx.cotaBands : DEFAULT_COTA_BANDS).slice().sort((a, z) => z.min - a.min);
    const band = bands.find((x) => total >= x.min) || bands[bands.length - 1];
    const rank = (band && band.rank) || tiers.length;
    const cotas = Array.isArray(ctx.cotas) ? ctx.cotas.filter((c) => c && c.nome) : [];
    if (cotas.length) {
      const sorted = cotas.slice().sort((a, z) => (Number(z.valor) || 0) - (Number(a.valor) || 0));
      const c = sorted[Math.min(rank - 1, sorted.length - 1)];
      cota_sugerida = c ? (c.nome + (c.valor != null ? ` (R$ ${Number(c.valor).toLocaleString("pt-BR")})` : "")) : `Cota ${rank}`;
    } else { cota_sugerida = `Cota ${rank}`; }
  }

  // timing (camada de acao): semana-alvo por tier + janela + ciclo orcamentario BR.
  const semanaAlvoPorTier = { 1: 10, 2: 8, 3: 4 };
  const timing = { semana_alvo: semanaAlvoPorTier[tier] || 6, semanas_para_evento: null, janela: null, ciclo_orcamentario: false };
  if (ctx.dataEvento) {
    const ev = toDate(ctx.dataEvento);
    if (ev) {
      const semanas = Math.round((ev.getTime() - refMs) / (7 * DIA));
      timing.semanas_para_evento = semanas;
      timing.janela = semanas < 0 ? "passou" : (semanas <= timing.semana_alvo ? "abrir" : "esperar");
      const now = new Date(refMs);
      timing.ciclo_orcamentario = (now.getUTCMonth() + 1) >= 10 && (ev.getUTCMonth() + 1) <= 6;
    }
  }

  const evidence = {
    contratos: b.contratos, soma_contratos: soma, n_contratos: b.count, max_signed_at: b.max_signed_at,
    cnae: cnae || null, porte: (en.company && en.company.size_label) || null, situacao: (en.company && en.company.registration_status) || null,
    doacoes: en.doacoes.sample, soma_doacoes: en.doacoes.soma, n_doacoes: en.doacoes.count, arestas: en.edges
  };

  return {
    empresa_key: b.empresa_key, cnpj: b.cnpj, company_id: b.company_id, nome: b.nome || "(sem nome)",
    total, tier, subscores: sub, evidence, capped, cota_sugerida, timing
  };
}

// Combina sourcing + enriquecimento + rubrica. asOf (YYYY-MM-DD) = corte do snapshot.
async function runScore(supabase, opts) {
  const orgaos = (opts.orgaos || []).filter(Boolean);
  if (!orgaos.length) return { ok: false, error: "Informe ao menos um orgao-alvo." };
  const asOf = opts.asOf || new Date().toISOString().slice(0, 10);
  const asOfMs = toDate(asOf).getTime();

  const src = await sourceCandidates(supabase, orgaos, opts.scanCap || CONTRACT_SCAN_CAP);
  if (!src.ok) return src;
  // Ranqueia por Sigma-contrato e pontua so as top-N (o resto fica registrado no run como remainder).
  const ranked = src.buckets.sort((a, z) => z.soma - a.soma);
  const enrichN = Math.min(opts.enrichCap || ENRICH_CAP, ranked.length);
  const top = ranked.slice(0, enrichN);
  await enrichCandidates(supabase, top);

  const ctx = {
    weights: opts.weights, tiers: opts.tiers, cotaBands: opts.cotaBands, sectorCnae: opts.sectorCnae,
    cotas: opts.cotas, dataEvento: opts.dataEvento, asOf, asOfMs
  };
  const suppressed = opts.suppressed instanceof Set ? opts.suppressed : new Set();
  const scored = top.map((b) => scoreOne(b, ctx))
    .filter((s) => s.tier != null)                       // fora do shortlist (abaixo do menor tier) nao entra
    .filter((s) => !suppressed.has(s.empresa_key))       // supressao entre eventos
    .sort((a, z) => z.total - a.total);

  return {
    ok: true, as_of: asOf,
    n_candidates: src.n_candidates, n_scored: scored.length,
    n_enriched: enrichN, remainder: Math.max(0, src.n_candidates - enrichN), truncado: src.truncado,
    scored
  };
}

// Re-pontua a partir do SNAPSHOT de evidencia gravado (sem re-consultar contratos):
// isola o efeito da RUBRICA do crescimento do banco. asOf = o do snapshot original
// (recencia estavel). ctx = { weights, tiers, cotaBands, sectorCnae, cotas, dataEvento }.
function scoreFromSnapshot(scoreRow, ctx) {
  const ev = scoreRow.evidence || {};
  const b = {
    empresa_key: scoreRow.empresa_key, cnpj: scoreRow.cnpj, company_id: scoreRow.company_id, nome: scoreRow.nome,
    soma: Number(ev.soma_contratos) || 0, count: Number(ev.n_contratos) || 0, max_signed_at: ev.max_signed_at || null,
    contratos: Array.isArray(ev.contratos) ? ev.contratos : [],
    _enrich: {
      company: { cnae: ev.cnae || null, size_label: ev.porte || null, registration_status: ev.situacao || null, legal_name: null },
      doacoes: { soma: Number(ev.soma_doacoes) || 0, count: Number(ev.n_doacoes) || 0, sample: Array.isArray(ev.doacoes) ? ev.doacoes : [] },
      edges: Number(ev.arestas) || 0
    }
  };
  const asOf = scoreRow.as_of || new Date().toISOString().slice(0, 10);
  return scoreOne(b, { ...ctx, asOf, asOfMs: toDate(asOf).getTime() });
}

module.exports = { runScore, sourceCandidates, enrichCandidates, scoreOne, scoreFromSnapshot, cnpjVariants, DEFAULT_WEIGHTS, DEFAULT_TIERS, CONTRACT_SCAN_CAP, ENRICH_CAP };
