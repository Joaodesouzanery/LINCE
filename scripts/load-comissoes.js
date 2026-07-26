// M21 (stakeholder "sem erros") — Popula `body_memberships` com as comissoes/orgaos
// dos DEPUTADOS federais (Camara Dados Abertos: /deputados/{id}/orgaos). O perfil de
// stakeholder ganha a aba "Comissoes" (o NOMOS mostra isso). SEM IA, fonte gratis.
//
// Re-sync LIMPO por parlamentar: delete-by-person + insert (remove vinculo encerrado,
// nao acumula duplicata). Idempotente por definicao.
//
// Uso: node scripts/load-comissoes.js [--dry-run]
//
// Roda no GitHub Actions (Vercel Hobby ja esta no limite de crons/funcoes).
// (Senadores: a estrutura de comissoes do Senado difere — fica p/ uma proxima rodada.)
require("dotenv").config();
const { getSupabase } = require("../lib/supabase");
const { fetchOrgaosDeputado } = require("../lib/legislativo");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Deputados com external_ids.camara (os que tem endpoint de orgaos na Camara).
async function loadDeputados(supabase) {
  const out = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from("people")
      .select("id, full_name, external_ids").eq("role", "deputado")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`people: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out.filter((p) => p.external_ids && p.external_ids.camara);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const supabase = getSupabase();

  const deputados = await loadDeputados(supabase);
  console.log(`Deputados com id Camara: ${deputados.length}`);
  if (!deputados.length) { console.error("Nenhum deputado com external_ids.camara — rode load:parlamentares antes."); process.exit(1); }

  let synced = 0, memberships = 0, apiFailed = 0, dbFailed = 0;
  for (let i = 0; i < deputados.length; i++) {
    const p = deputados[i];
    const camaraId = p.external_ids.camara;

    let res = await fetchOrgaosDeputado(camaraId);
    if (!res.ok) { await sleep(300); res = await fetchOrgaosDeputado(camaraId); }
    if (!res.ok) { apiFailed++; console.error(`  ! orgaos dep ${camaraId} (${p.full_name}): ${res.error} — pulado, mantem o que ja tinha.`); await sleep(120); continue; }

    // Dedup por (external_org_id, cargo). cargo/external_org_id NUNCA null: o unique
    // e o upsert onConflict exigem valores concretos ('' quando ausente).
    const seen = new Set();
    const rows = [];
    for (const o of res.items) {
      const external_org_id = o.externalOrgId || "";
      const cargo = o.cargo || "";
      const key = `${external_org_id}|${cargo}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ person_id: p.id, casa: "Camara", orgao_sigla: o.sigla, orgao_nome: o.nome, cargo, external_org_id });
    }

    if (dryRun) { console.log(`  [dry] ${p.full_name}: ${rows.length} comissao(oes)`); await sleep(80); continue; }

    // Re-sync SEGURO (nao zera numa janela): UPSERT o conjunto fresco primeiro, depois
    // remove por id so os vinculos OBSOLETOS que nao vieram desta coleta. Se o upsert
    // falhar, nada foi apagado antes -> os dados antigos ficam intactos.
    const { data: existing, error: exErr } = await supabase.from("body_memberships")
      .select("id, external_org_id, cargo").eq("person_id", p.id);
    if (exErr) { dbFailed++; console.error(`  x read ${camaraId}: ${exErr.message}`); await sleep(120); continue; }
    if (rows.length) {
      const up = await supabase.from("body_memberships").upsert(rows, { onConflict: "person_id,external_org_id,cargo" });
      if (up.error) { dbFailed++; console.error(`  x upsert ${camaraId}: ${up.error.message}`); await sleep(120); continue; }
    }
    const freshKeys = new Set(rows.map((r) => `${r.external_org_id}|${r.cargo}`));
    const staleIds = (existing || [])
      .filter((e) => !freshKeys.has(`${e.external_org_id ?? ""}|${e.cargo ?? ""}`))
      .map((e) => e.id);
    if (staleIds.length) {
      const del = await supabase.from("body_memberships").delete().in("id", staleIds);
      if (del.error) { dbFailed++; console.error(`  x delete-stale ${camaraId}: ${del.error.message}`); await sleep(120); continue; }
    }
    synced++; memberships += rows.length;
    if (i && i % 50 === 0) console.log(`  ...${i}/${deputados.length}`);
    await sleep(120); // gentileza com a API
  }

  console.log(`\n=== Comissoes concluido ===`);
  console.log(`Sincronizados: ${synced} | vinculos gravados: ${memberships} | API falhou: ${apiFailed} | DB falhou: ${dbFailed}`);
  if (dryRun) console.log("(dry-run: nada gravado)");
}

main().catch((e) => { console.error(e); process.exit(1); });
