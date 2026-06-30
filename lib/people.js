// Entity resolution de pessoas no Supabase: encontra por CPF ou nome
// normalizado; cria se nao existir. Devolve o registro da pessoa.
const { normalizeName, normalizeNameKey, onlyDigits } = require("./text");

async function upsertPerson(supabase, { full_name, cpf, role, agency_id, source_profile_url }) {
  const normalized = normalizeName(full_name);
  const nameKey = normalizeNameKey(full_name);
  const cpfDigits = cpf ? onlyDigits(cpf) : null;

  let found = null;
  if (cpfDigits) {
    const { data } = await supabase.from("people").select("*").eq("cpf", cpfDigits).maybeSingle();
    found = data || null;
  }
  if (!found && normalized) {
    const { data } = await supabase
      .from("people")
      .select("*")
      .eq("normalized_name", normalized)
      .maybeSingle();
    found = data || null;
  }
  // 3a tentativa: chave por token ordenado (pega variacoes de ordem/conectivo).
  if (!found && nameKey) {
    const { data } = await supabase
      .from("people")
      .select("*")
      .eq("normalized_key", nameKey)
      .maybeSingle();
    found = data || null;
  }

  if (found) {
    // Enriquece campos vazios sem sobrescrever o que ja existe.
    const patch = {};
    if (cpfDigits && !found.cpf) patch.cpf = cpfDigits;
    if (role && !found.role) patch.role = role;
    if (agency_id && !found.agency_id) patch.agency_id = agency_id;
    if (nameKey && !found.normalized_key) patch.normalized_key = nameKey;
    if (Object.keys(patch).length) {
      const { data } = await supabase.from("people").update(patch).eq("id", found.id).select("*").single();
      return data || found;
    }
    return found;
  }

  const { data, error } = await supabase
    .from("people")
    .insert({ full_name, normalized_name: normalized, normalized_key: nameKey, cpf: cpfDigits, role, agency_id, source_profile_url })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

module.exports = { upsertPerson };
