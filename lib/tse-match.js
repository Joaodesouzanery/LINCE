// Helpers compartilhados dos loaders do TSE (bens/partido). O match com a base
// local `people` e SO por nome (a tabela nao tem CPF — LGPD), entao a
// desambiguacao por homonimia e critica: nomes que apontam para 2+ pessoas sao
// descartados (melhor perder um match do que imputar dado sensivel a quem nao e).
const { normalizeNameKey } = require("./text");

// Le TODAS as pessoas paginando (o PostgREST corta cada resposta em 1000 linhas;
// a base tem milhares -> sem paginar, so as 1000 primeiras entrariam no indice).
// Lanca em erro (o caller trata via main().catch -> exit 1).
async function fetchAllPeople(supabase) {
  const all = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("people")
      .select("id, full_name")
      // created_at NAO e unico (inserts em lote compartilham now()); sem um
      // desempate estavel, o OFFSET pode PULAR/duplicar linhas entre paginas e
      // furar a protecao anti-homonimo. `id` (uuid, unico) estabiliza a ordem.
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Erro lendo people: ${error.message}`);
    all.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return all;
}

// Indice chave-de-nome -> person_id, DESCARTANDO chaves ambiguas (mesmo nome
// normalizado para 2+ pessoas distintas). Retorna { byNameKey, ambiguous }.
function buildPeopleNameIndex(people) {
  const byNameKey = new Map();
  const ambiguous = new Set();
  for (const p of people || []) {
    const key = normalizeNameKey(p.full_name);
    if (!key || ambiguous.has(key)) continue;
    const prev = byNameKey.get(key);
    if (prev && prev !== p.id) { byNameKey.delete(key); ambiguous.add(key); }
    else byNameKey.set(key, p.id);
  }
  return { byNameKey, ambiguous };
}

module.exports = { fetchAllPeople, buildPeopleNameIndex };
