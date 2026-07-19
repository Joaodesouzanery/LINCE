// Entity resolution de pessoas no Supabase: encontra por CPF ou nome
// normalizado; cria se nao existir. Devolve o registro da pessoa.
const { normalizeName, normalizeNameKey, onlyDigits } = require("./text");

async function upsertPerson(supabase, { full_name, cpf, role, agency_id, source_profile_url, external_ids, uf, strictExternal }) {
  const normalized = normalizeName(full_name);
  const nameKey = normalizeNameKey(full_name);
  const cpfDigits = cpf ? onlyDigits(cpf) : null;
  const extIds = external_ids && typeof external_ids === "object" ? external_ids : null;

  let found = null;
  let strongMatch = false; // match por id externo/CPF (nao por nome) -> confiavel
  // 0a tentativa: id externo da casa (Camara/Senado). Mais forte que nome e sem
  // CPF (LGPD) — e o que torna o match de parlamentar estavel. So age quando vem.
  if (extIds) {
    for (const [src, extId] of Object.entries(extIds)) {
      if (extId == null || extId === "") continue;
      const { data } = await supabase.from("people").select("*").contains("external_ids", { [src]: String(extId) }).limit(1);
      if (data && data.length) { found = data[0]; strongMatch = true; break; }
    }
  }
  if (!found && cpfDigits) {
    const { data } = await supabase.from("people").select("*").eq("cpf", cpfDigits).maybeSingle();
    if (data) { found = data; strongMatch = true; }
  }
  // Match por NOME so quando NAO for strictExternal. Parlamentar usa strictExternal:
  // casar por nome poderia conflar duas identidades OFICIAIS distintas (homonimo
  // deputado x senador, ou parlamentar x diretor) numa so pessoa — e, ao carimbar
  // o external_id na linha errada, o erro viraria "id oficial", difícil de desfazer.
  if (!found && !strictExternal && normalized) {
    const { data } = await supabase.from("people").select("*").eq("normalized_name", normalized).maybeSingle();
    found = data || null;
  }
  if (!found && !strictExternal && nameKey) {
    const { data } = await supabase.from("people").select("*").eq("normalized_key", nameKey).maybeSingle();
    found = data || null;
  }

  if (found) {
    // Enriquece campos vazios sem sobrescrever o que ja existe.
    const patch = {};
    if (cpfDigits && !found.cpf) patch.cpf = cpfDigits;
    if (role && !found.role) patch.role = role;
    if (agency_id && !found.agency_id) patch.agency_id = agency_id;
    if (nameKey && !found.normalized_key) patch.normalized_key = nameKey;
    if (uf && !found.uf) patch.uf = uf;
    // external_ids: so CARIMBA num match FORTE (external_id/CPF). Nunca promove um
    // match por NOME a id oficial (senao conflaria homonimos permanentemente).
    if (extIds && strongMatch && Object.keys(extIds).length) {
      const cur = found.external_ids && typeof found.external_ids === "object" ? found.external_ids : {};
      const merged = { ...cur };
      for (const [k, v] of Object.entries(extIds)) if (v != null && v !== "" && cur[k] == null) merged[k] = String(v);
      if (Object.keys(merged).length !== Object.keys(cur).length) patch.external_ids = merged;
    }
    if (Object.keys(patch).length) {
      const { data } = await supabase.from("people").update(patch).eq("id", found.id).select("*").single();
      return data || found;
    }
    return found;
  }

  // Normaliza external_ids p/ strings (o GIN/contains casa por igualdade de valor).
  const extForInsert = extIds
    ? Object.fromEntries(Object.entries(extIds).filter(([, v]) => v != null && v !== "").map(([k, v]) => [k, String(v)]))
    : {};
  const { data, error } = await supabase
    .from("people")
    .insert({ full_name, normalized_name: normalized, normalized_key: nameKey, cpf: cpfDigits, role, agency_id, source_profile_url, external_ids: extForInsert, uf: uf || null })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

module.exports = { upsertPerson };
