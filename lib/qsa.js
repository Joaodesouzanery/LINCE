// M11 - Persistencia do quadro societario (QSA) vindo do CNPJ.ws (ao vivo).
// Transforma a resposta de api/cnpj.js em nos (companies/people) + arestas
// (relationships 'socio') para alimentar o grafo de vinculo societario.
//
// LGPD: nao persiste CPF. O CNPJ.ws ja entrega o CPF de socio PF mascarado
// (ex.: "***456789**"); guardamos apenas esse valor mascarado em metadata.
// CNPJ de socio PJ e dado publico e pode ser guardado inteiro.
//
// Padrao do projeto: sempre retorna { ok, ... }, nunca lanca para o caller.
const { getSupabase } = require("./supabase");
const { normalizeName, normalizeNameKey, onlyDigits } = require("./text");

// Extrai o primeiro valor definido dentre varios caminhos possiveis (a resposta
// do CNPJ.ws varia um pouco entre estabelecimento/raiz).
function pick(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

function isPessoaJuridica(socio) {
  const tipo = String(socio?.tipo || socio?.identificador_de_socio || "").toLowerCase();
  if (tipo.includes("jurid")) return true;
  const doc = onlyDigits(socio?.cpf_cnpj_socio || socio?.cnpj_cpf_do_socio || socio?.documento);
  return doc.length === 14;
}

// Documento seguro p/ armazenar: CNPJ (14) inteiro; CPF fica mascarado como veio.
function safeDoc(raw) {
  const value = String(raw || "").trim();
  const digits = onlyDigits(value);
  if (digits.length === 14) return digits; // CNPJ publico
  return value; // CPF PF ja vem mascarado do CNPJ.ws; nao expandir
}

// Normaliza a lista de socios da resposta CNPJ.ws para um shape estavel.
function normalizeSocios(data) {
  const raw = data?.socios || data?.qsa || data?.socios_administradores || [];
  if (!Array.isArray(raw)) return [];
  return raw.map((s) => {
    const nome = pick(s.nome, s.nome_socio, s.nome_do_socio) || "";
    const qual = s.qualificacao_socio || s.qualificacao || {};
    const role = pick(typeof qual === "object" ? qual.descricao : qual, s.qualificacao_do_socio, "Socio");
    return {
      nome,
      normalized_name: normalizeName(nome),
      normalized_key: normalizeNameKey(nome),
      pj: isPessoaJuridica(s),
      doc: safeDoc(s.cpf_cnpj_socio || s.cnpj_cpf_do_socio || s.documento),
      role: role || "Socio",
      data_entrada: pick(s.data_entrada, s.data_entrada_sociedade) || null,
      faixa_etaria: pick(s.faixa_etaria) || null
    };
  }).filter((s) => s.nome);
}

// Extrai os campos cadastrais da empresa-alvo.
function extractCompany(data) {
  const est = data?.estabelecimento || {};
  const cnpj = onlyDigits(pick(est.cnpj, data?.cnpj, data?.cnpj_raiz));
  const atividade = est.atividade_principal || data?.atividade_principal || {};
  return {
    cnpj,
    legal_name: pick(data?.razao_social, est.razao_social, `CNPJ ${cnpj}`),
    trade_name: pick(est.nome_fantasia, data?.nome_fantasia),
    cnae: pick(atividade.subclasse, atividade.id, atividade.codigo, atividade.descricao),
    registration_status: pick(est.situacao_cadastral, data?.situacao_cadastral),
    size_label: pick(data?.porte?.descricao, data?.porte, est.porte)
  };
}

// Acha uma pessoa existente por chave normalizada; se nao houver e createPeople,
// cria um no minimo (sem CPF). Retorna id ou null.
async function resolvePerson(supabase, socio, createPeople) {
  const key = socio.normalized_key;
  if (!key) return null;
  const { data: found } = await supabase
    .from("people")
    .select("id")
    .eq("normalized_key", key)
    .limit(1)
    .maybeSingle();
  if (found?.id) return found.id;
  if (!createPeople) return null;
  const { data: created } = await supabase
    .from("people")
    .insert({
      full_name: socio.nome,
      normalized_name: socio.normalized_name,
      normalized_key: socio.normalized_key,
      role: socio.role,
      bio: { source: "receita_qsa" }
    })
    .select("id")
    .single();
  return created?.id || null;
}

// Upsert de empresa por CNPJ. Retorna id.
async function upsertCompany(supabase, fields) {
  const { data } = await supabase
    .from("companies")
    .upsert(fields, { onConflict: "cnpj" })
    .select("id")
    .single();
  return data?.id || null;
}

// Cria aresta socio se ainda nao existir (dedupe por from/to/relationship).
async function ensureSocioEdge(supabase, fromKind, fromId, companyId, meta) {
  const { data: exists } = await supabase
    .from("relationships")
    .select("id")
    .eq("from_kind", fromKind)
    .eq("from_id", fromId)
    .eq("to_kind", "company")
    .eq("to_id", companyId)
    .eq("relationship", "socio")
    .maybeSingle();
  if (exists) return false;
  await supabase.from("relationships").insert({
    from_kind: fromKind,
    from_id: fromId,
    to_kind: "company",
    to_id: companyId,
    relationship: "socio",
    confidence_score: 1,
    metadata: { ...meta, source: "receita_qsa" }
  });
  return true;
}

// Persiste o QSA de uma resposta do CNPJ.ws. `data` = objeto `data` de api/cnpj.js.
// createPeople=true cria nos de pessoa para socios PF que ainda nao existem
// (necessario para o grafo mostrar a rede completa de uma empresa investigada).
async function persistCnpj(data, { createPeople = true } = {}) {
  try {
    const company = extractCompany(data);
    if (!company.cnpj || company.cnpj.length !== 14) {
      return { ok: false, error: "CNPJ ausente ou invalido no payload." };
    }
    const socios = normalizeSocios(data);
    const supabase = getSupabase();

    const companyId = await upsertCompany(supabase, {
      cnpj: company.cnpj,
      legal_name: company.legal_name,
      trade_name: company.trade_name,
      cnae: company.cnae,
      registration_status: company.registration_status,
      size_label: company.size_label,
      shareholding: socios.map((s) => ({
        nome: s.nome, tipo: s.pj ? "PJ" : "PF", doc: s.doc,
        role: s.role, data_entrada: s.data_entrada
      }))
    });
    if (!companyId) return { ok: false, error: "Falha ao gravar empresa." };

    let edges = 0, people = 0, companiesLinked = 0;
    for (const socio of socios) {
      const meta = { role: socio.role, data_entrada: socio.data_entrada, doc: socio.doc };
      if (socio.pj) {
        // Socio PJ: garante no de empresa e aresta company->company.
        const socioCnpj = onlyDigits(socio.doc);
        if (socioCnpj.length !== 14) continue;
        const socioCompanyId = await upsertCompany(supabase, {
          cnpj: socioCnpj, legal_name: socio.nome
        });
        if (!socioCompanyId || socioCompanyId === companyId) continue;
        if (await ensureSocioEdge(supabase, "company", socioCompanyId, companyId, meta)) {
          edges++; companiesLinked++;
        }
      } else {
        // Socio PF: resolve/cria pessoa e aresta person->company.
        const personId = await resolvePerson(supabase, socio, createPeople);
        if (!personId) continue;
        const before = edges;
        if (await ensureSocioEdge(supabase, "person", personId, companyId, meta)) edges++;
        if (edges > before) people++;
      }
    }

    return {
      ok: true,
      company_id: companyId,
      cnpj: company.cnpj,
      socios: socios.length,
      edges_created: edges,
      people_linked: people,
      companies_linked: companiesLinked
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

module.exports = { persistCnpj, normalizeSocios, extractCompany };
