// F-INT1 (Fase 1): preenche normalized_name/normalized_key das pessoas que estao com
// NULL. Medido em producao: 475 de 1200 pessoas sem chave — e 258 delas TEM MANDATO.
// A resolucao de entidade (lib/people.upsertPerson) busca exatamente por essas colunas:
// sem elas, cada QSA/DOU novo cria uma DUPLICATA do mesmo diretor, a aresta aponta para
// a duplicata e o mandato para a original -> porta-giratoria nunca casa.
// PRE-REQUISITO do backfill-socio-edges.
//
// Uso: node scripts/backfill-people-keys.js [--commit] [--limit N]
//      (sem --commit e DRY-RUN: mostra o que faria e nao grava)
require("dotenv").config();
const { getSupabase } = require("../lib/supabase");
const { normalizeName, normalizeNameKey } = require("../lib/text");

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }

async function main() {
  const commit = process.argv.includes("--commit");
  const limit = Math.max(1, Number(arg("--limit")) || 100000);
  const supabase = getSupabase();

  // Pagina TODAS as pessoas (o filtro de NULL fica no JS: `or` com is.null em duas
  // colunas + paginacao estavel e mais fragil que varrer 1-2k linhas).
  const rows = [];
  for (let from = 0; from < 100000; from += 1000) {
    const { data, error } = await supabase.from("people")
      .select("id, full_name, normalized_name, normalized_key")
      .order("id", { ascending: true }).range(from, from + 999);
    if (error) { console.error("Erro ao ler people:", error.message); process.exit(1); }
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }

  const pendentes = [];
  for (const p of rows) {
    const nome = String(p.full_name || "").trim();
    if (!nome) continue;
    const nn = normalizeName(nome);
    const nk = normalizeNameKey(nome);
    if (!nn && !nk) continue;
    if (p.normalized_name === nn && p.normalized_key === nk) continue; // ja correto
    pendentes.push({ id: p.id, full_name: p.full_name, normalized_name: nn, normalized_key: nk });
  }

  console.log(`Pessoas: ${rows.length} | sem chave/desatualizadas: ${pendentes.length}`);
  // Colisao de chave = homonimo dentro da propria base: nao e erro, mas o operador
  // precisa saber (e o sinal de que ha 2 registros que talvez sejam a MESMA pessoa).
  const porChave = new Map();
  for (const p of pendentes) if (p.normalized_key) porChave.set(p.normalized_key, (porChave.get(p.normalized_key) || 0) + 1);
  const colisoes = [...porChave.entries()].filter(([, n]) => n > 1);
  if (colisoes.length) console.log(`⚠ ${colisoes.length} chave(s) repetida(s) entre as pendentes (possiveis homonimos/duplicatas): ${colisoes.slice(0, 5).map(([k, n]) => `${k} (${n})`).join(", ")}`);

  const alvo = pendentes.slice(0, limit);
  for (const p of alvo.slice(0, 5)) console.log(`  ex.: ${p.full_name} -> key "${p.normalized_key}"`);
  if (!commit) { console.log(`\nDRY-RUN — nada gravado. Rode com --commit para aplicar em ${alvo.length} pessoa(s).`); return; }

  let ok = 0, falhas = 0;
  for (let i = 0; i < alvo.length; i += 200) {
    const chunk = alvo.slice(i, i + 200);
    const { error } = await supabase.from("people").upsert(chunk, { onConflict: "id" });
    if (error) { console.error(`  x lote ${i}: ${error.message}`); falhas += chunk.length; continue; }
    ok += chunk.length;
  }
  console.log(`\n=== backfill:people-keys concluido ===`);
  console.log(`Atualizadas: ${ok} | falhas: ${falhas}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
