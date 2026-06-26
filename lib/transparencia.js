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

module.exports = { findServidoresByName };
