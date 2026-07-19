// M20 — Enriquece as proposicoes JA persistidas (dos 17 termos curados de
// load-proposicoes.js): autores estruturados (-> proposicao_autores, clicaveis),
// situacao de tramitacao e tema (classifyThemes, DETERMINISTICO, sem IA).
// Bounded (~centenas de proposicoes). Roda no GitHub Actions.
//
// Camara: /proposicoes/{id}/autores (autor deputado casa por external_ids.camara)
//         + /proposicoes/{id} (situacao). Senado: autor textual -> match por nome.
//
// Uso: node scripts/backfill-proposicao-detalhe.js [--dry-run]
require("dotenv").config();
const { getSupabase } = require("../lib/supabase");
const { normalizeNameKey } = require("../lib/text");
const { fetchAutores, fetchSituacaoCamara } = require("../lib/legislativo");
const { classifyThemes } = require("../lib/themes");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGE = 1000;

async function paginate(supabase, table, select, tweak) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from(table).select(select).range(from, from + PAGE - 1);
    if (tweak) q = tweak(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const supabase = getSupabase();

  const props = await paginate(supabase, "proposicoes", "id, casa, titulo, ementa, autor", (q) => q.order("id"));
  console.log(`Proposicoes: ${props.length}`);

  // Indices de match, SO de parlamentares (upsertPerson usa strictExternal -> todo
  // parlamentar e uma linha propria com role deputado/senador): camaraId -> person_id
  // (id-based, forte, p/ autor da Camara); nome -> person_id (homonimo-seguro, p/ autor
  // textual do Senado). Escopar a parlamentares evita casar autor do Senado com um
  // diretor homonimo que nao e parlamentar.
  const parls = await paginate(supabase, "people", "id, full_name, external_ids", (q) => q.in("role", ["deputado", "senador"]));
  const camaraMap = new Map();
  const byNameKey = new Map(); const ambiguous = new Set();
  for (const p of parls) {
    const cid = p.external_ids && p.external_ids.camara;
    if (cid) camaraMap.set(String(cid), p.id);
    const key = normalizeNameKey(p.full_name);
    if (!key || ambiguous.has(key)) continue;
    const prev = byNameKey.get(key);
    if (prev && prev !== p.id) { byNameKey.delete(key); ambiguous.add(key); } else byNameKey.set(key, p.id);
  }
  console.log(`Parlamentares: ${parls.length} | por id Camara: ${camaraMap.size} | nomes unicos: ${byNameKey.size}`);

  let autoresIns = 0, situUpd = 0, themesUpd = 0, failed = 0, apiFailed = 0;

  for (let i = 0; i < props.length; i++) {
    const p = props[i];
    if (i && i % 25 === 0) console.log(`  ${i}/${props.length}...`);

    const themes = classifyThemes(p.titulo || "", p.ementa || "");
    const autores = [];
    let situacao = null;

    if (p.id.startsWith("camara:")) {
      const camId = p.id.slice("camara:".length);
      const [aut, sit] = await Promise.all([fetchAutores(camId), fetchSituacaoCamara(camId)]);
      // Falha de API NAO e silenciosa: sinaliza (o autor/situacao ficam de fora nesta
      // rodada e sao retentados na proxima — o backfill e idempotente).
      if (!aut.ok) { apiFailed++; console.error(`  ! autores ${p.id}: ${aut.error || "falha"}`); }
      else {
        for (const a of aut.items) {
          const pid = a.camaraId ? (camaraMap.get(String(a.camaraId)) || null) : null;
          autores.push({ autor_nome: a.nome, person_id: pid, tipo: a.tipo, ordem: a.ordem, external_author_id: a.camaraId || null });
        }
      }
      if (sit.ok) situacao = sit.situacao;
      else { apiFailed++; console.error(`  ! situacao ${p.id}: ${sit.error || "falha"}`); }
      await sleep(150); // rate limit da Camara (1-2 calls por proposicao)
    } else if (p.id.startsWith("senado:") && p.autor) {
      // Senado: autor veio como texto na carga -> match por nome (fraco, homonimo-seguro).
      const key = normalizeNameKey(p.autor);
      const pid = key && !ambiguous.has(key) ? (byNameKey.get(key) || null) : null;
      autores.push({ autor_nome: p.autor, person_id: pid, tipo: "senador", ordem: 1, external_author_id: null });
    }

    if (dryRun) {
      console.log(`  [dry] ${p.id} temas=${themes.join(",") || "-"} situacao=${situacao || "-"} autores=${autores.map((a) => a.autor_nome + (a.person_id ? "*" : "")).join("; ") || "-"}`);
      continue;
    }

    const upd = {};
    if (themes.length) upd.themes = themes;
    if (situacao) upd.situacao = situacao;
    if (Object.keys(upd).length) {
      const { error } = await supabase.from("proposicoes").update(upd).eq("id", p.id);
      if (error) { failed++; console.error(`  x update ${p.id}: ${error.message}`); }
      else { if (upd.themes) themesUpd++; if (upd.situacao) situUpd++; }
    }

    for (const a of autores) {
      const { error } = await supabase.from("proposicao_autores").upsert({
        proposicao_id: p.id, person_id: a.person_id, autor_nome: a.autor_nome,
        tipo: a.tipo, ordem: a.ordem, external_author_id: a.external_author_id
      }, { onConflict: "proposicao_id,autor_nome" });
      if (error) { failed++; console.error(`  x autor ${p.id}/${a.autor_nome}: ${error.message}`); }
      else autoresIns++;
    }
  }

  console.log(`\n=== Backfill proposicao detalhe concluido ===`);
  console.log(`Autores gravados: ${autoresIns} | situacao: ${situUpd} | themes: ${themesUpd} | falhas DB: ${failed} | falhas API: ${apiFailed}`);
  if (dryRun) console.log("(dry-run: nada gravado)");
}

main().catch((e) => { console.error(e); process.exit(1); });
