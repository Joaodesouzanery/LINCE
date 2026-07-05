// Portal da Transparencia - enriquecimento de servidores (SIAPE).
// Requer PORTAL_TRANSPARENCIA_API_KEY (gratuita). Doc: api.portaldatransparencia.gov.br
const BASE = "https://api.portaldatransparencia.gov.br/api-de-dados";

async function call(path, params) {
  const key = process.env.PORTAL_TRANSPARENCIA_API_KEY;
  if (!key) return { ok: false, error: "PORTAL_TRANSPARENCIA_API_KEY ausente" };
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}${path}?${qs}`, { headers: { "chave-api-dados": key, accept: "application/json" } });
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  return { ok: true, data: await res.json() };
}

// Busca servidores por nome. Retorna lista normalizada (cargo, orgao, vinculo).
async function findServidoresByName(nome) {
  const r = await call("/servidores", { nome, pagina: 1 });
  if (!r.ok) return r;
  const items = (r.data || []).map((s) => ({
    full_name: s?.servidor?.pessoa?.nome || nome,
    cpf: s?.servidor?.pessoa?.cpfFormatado || null,
    cargo: s?.cargo?.descricao || s?.situacao || null,
    orgao: s?.lotacao?.orgaoSuperiorLotacao || s?.orgaoServidorLotacao?.nome || null,
    raw: s
  }));
  return { ok: true, items };
}

// ── Screening PEP / sancoes ─────────────────────────────────────────────────
// Consulta so a pagina 1 de cada lista: screening precisa do sinal "ha registros",
// nao da lista exaustiva. `truncated` avisa quando havia mais.
const PAGE_SIZE = 15;

async function runScreening(calls) {
  const settled = await Promise.allSettled(
    calls.map((c) => call(c.path, { ...c.params, pagina: 1 }))
  );
  const sources = {};
  settled.forEach((r, i) => {
    const name = calls[i].source;
    if (r.status !== "fulfilled" || !r.value.ok) {
      sources[name] = { ok: false, error: r.status === "fulfilled" ? r.value.error : r.reason?.message };
    } else {
      const items = Array.isArray(r.value.data) ? r.value.data : [];
      sources[name] = { ok: true, total: items.length, truncated: items.length >= PAGE_SIZE, items };
    }
  });
  return sources;
}

function screeningFlags(sources) {
  const total = (s) => (sources[s]?.ok ? sources[s].total : 0);
  return {
    is_pep: total("peps") > 0,
    has_sanctions: total("ceis") + total("cnep") + total("cepim") + total("ceaf") > 0,
    is_servidor: total("servidores") > 0
  };
}

function requiresKey() {
  return !process.env.PORTAL_TRANSPARENCIA_API_KEY;
}

async function screeningByName(nome) {
  if (requiresKey()) return { ok: false, status: "requires_key" };
  const sources = await runScreening([
    { source: "peps", path: "/peps", params: { nome } },
    { source: "ceis", path: "/ceis", params: { nomeSancionado: nome } },
    { source: "cnep", path: "/cnep", params: { nomeSancionado: nome } },
    { source: "cepim", path: "/cepim", params: { nomeSancionado: nome } },
    { source: "ceaf", path: "/ceaf", params: { nomeSancionado: nome } },
    { source: "servidores", path: "/servidores", params: { nome } }
  ]);
  return { ok: true, sources, flags: screeningFlags(sources) };
}

async function screeningByCpf(cpf) {
  if (requiresKey()) return { ok: false, status: "requires_key" };
  const sources = await runScreening([
    { source: "peps", path: "/peps", params: { cpf } },
    { source: "ceaf", path: "/ceaf", params: { cpfSancionado: cpf } },
    { source: "servidores", path: "/servidores", params: { cpf } },
    { source: "ceis", path: "/ceis", params: { codigoSancionado: cpf } },
    { source: "cnep", path: "/cnep", params: { codigoSancionado: cpf } }
  ]);
  return { ok: true, sources, flags: screeningFlags(sources) };
}

async function screeningByCnpj(cnpj) {
  if (requiresKey()) return { ok: false, status: "requires_key" };
  const sources = await runScreening([
    { source: "ceis", path: "/ceis", params: { codigoSancionado: cnpj } },
    { source: "cnep", path: "/cnep", params: { codigoSancionado: cnpj } },
    { source: "cepim", path: "/cepim", params: { cnpjSancionado: cnpj } }
  ]);
  return { ok: true, sources, flags: screeningFlags(sources) };
}

module.exports = { findServidoresByName, screeningByName, screeningByCpf, screeningByCnpj };
