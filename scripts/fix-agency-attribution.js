// Corrige a mis-atribuicao de atos DOU a agencias por SIGLA CURTA ambigua (o bug
// "ANA = 739 diretores": \bANA\b casava o prenome "Ana" e jogava atos do governo
// inteiro na ANA). Re-roda o matchAgency CORRIGIDO (lib/dou.js) nos documentos das
// agencias ambiguas e:
//   - RE-ATRIBUI os que casam com OUTRA agencia reguladora (doc + mandates + rels).
//   - REMOVE os ORFAOS (nao casam com nenhuma) — doc + mandates + rels + alerts.
// Depois expurga people sem nenhum mandato restante.
//
// Uso: node scripts/fix-agency-attribution.js            (DRY-RUN)
//      node scripts/fix-agency-attribution.js --commit   (aplica)
//
// DELETE/UPDATE em producao -> rode o dry-run e revise antes do --commit. SEM IA.
require("dotenv").config();
const { getSupabase } = require("../lib/supabase");
const { matchAgency } = require("../lib/dou");

const AMBIG = ["ANA", "ANP", "ANM", "ANS"]; // as siglas curtas ambiguas

async function paginate(supabase, table, columns, apply) {
  const all = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from(table).select(columns).order("id", { ascending: true }).range(from, from + PAGE - 1);
    if (apply) q = apply(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    all.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return all;
}

async function main() {
  const commit = process.argv.includes("--commit");
  const supabase = getSupabase();

  const { data: agencies } = await supabase.from("agencies").select("id, acronym, name").eq("sector", "regulatory");
  const agById = new Map((agencies || []).map((a) => [a.id, a]));
  const ambigIds = (agencies || []).filter((a) => AMBIG.includes(a.acronym)).map((a) => a.id);
  if (!ambigIds.length) { console.log("Nenhuma agencia ambigua encontrada."); return; }

  // Docs DOU atribuidos a uma agencia ambigua.
  const docs = await paginate(supabase, "documents",
    "id, agency_id, title, extracted_text, metadata",
    (q) => q.eq("source_name", "DOU").in("agency_id", ambigIds));
  console.log(`Docs DOU em agencias ambiguas (${AMBIG.join("/")}): ${docs.length}`);

  const reattribute = []; // { docId, from, to }
  const orphan = [];      // { docId, from }
  let kept = 0;
  for (const d of docs) {
    const rec = { orgao: d.metadata?.orgao || "", title: d.title, extracted_text: d.extracted_text };
    const match = matchAgency(rec, agencies || []);
    if (match && match.id === d.agency_id) { kept++; continue; }
    if (match) reattribute.push({ docId: d.id, from: d.agency_id, to: match.id });
    else orphan.push({ docId: d.id, from: d.agency_id });
  }
  const fmt = (id) => agById.get(id)?.acronym || id;
  console.log(`\nMantidos (ainda casam): ${kept}`);
  console.log(`Re-atribuir (casam OUTRA agencia): ${reattribute.length}`);
  console.log(`Orfaos (nao casam nenhuma -> remover): ${orphan.length}`);
  const byFrom = {};
  for (const o of [...reattribute, ...orphan]) byFrom[fmt(o.from)] = (byFrom[fmt(o.from)] || 0) + 1;
  console.log(`Por agencia de origem: ${JSON.stringify(byFrom)}`);
  const sampleRe = reattribute.slice(0, 8).map((r) => `${fmt(r.from)}->${fmt(r.to)}`);
  if (sampleRe.length) console.log(`Amostra re-atribuicao: ${sampleRe.join(", ")}`);

  if (!commit) {
    console.log(`\n(DRY-RUN) Rode com --commit para aplicar.`);
    return;
  }

  // ── Aplicar ──────────────────────────────────────────────────────────────
  const CHUNK = 200;
  let docUpd = 0, mandUpd = 0, relUpd = 0, docDel = 0, mandDel = 0, relDel = 0, alertDel = 0;

  // 1) RE-ATRIBUIR: agrupa por (from,to) e atualiza doc/mandates/relationships.
  const groups = new Map(); // `${from}|${to}` -> [docIds]
  for (const r of reattribute) {
    const k = `${r.from}|${r.to}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r.docId);
  }
  for (const [k, ids] of groups) {
    const [from, to] = k.split("|");
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const u1 = await supabase.from("documents").update({ agency_id: to }).in("id", slice).select("id");
      if (!u1.error) docUpd += (u1.data || []).length;
      const u2 = await supabase.from("mandates").update({ agency_id: to }).in("source_document_id", slice).select("id");
      if (!u2.error) mandUpd += (u2.data || []).length;
      // aresta agencia->pessoa (from_kind='agency', from_id=agencia antiga).
      const u3 = await supabase.from("relationships").update({ from_id: to })
        .eq("from_kind", "agency").eq("from_id", from).in("source_document_id", slice).select("id");
      if (!u3.error) relUpd += (u3.data || []).length;
    }
  }

  // 2) ORFAOS: remove mandates/relationships/alerts do doc, depois o doc.
  const orphanIds = orphan.map((o) => o.docId);
  for (let i = 0; i < orphanIds.length; i += CHUNK) {
    const slice = orphanIds.slice(i, i + CHUNK);
    const m = await supabase.from("mandates").delete({ count: "exact" }).in("source_document_id", slice);
    if (!m.error) mandDel += m.count || 0;
    const r = await supabase.from("relationships").delete({ count: "exact" }).in("source_document_id", slice);
    if (!r.error) relDel += r.count || 0;
    const a = await supabase.from("alerts").delete({ count: "exact" }).in("source_document_id", slice);
    if (!a.error) alertDel += a.count || 0;
    const d = await supabase.from("documents").delete({ count: "exact" }).in("id", slice);
    if (!d.error) docDel += d.count || 0;
  }

  console.log(`\n=== Aplicado ===`);
  console.log(`Re-atribuidos: ${docUpd} docs, ${mandUpd} mandatos, ${relUpd} arestas`);
  console.log(`Removidos (orfaos): ${docDel} docs, ${mandDel} mandatos, ${relDel} arestas, ${alertDel} alertas`);
  console.log(`\nDica: rode 'npm run clean:people' depois para expurgar people sem mandato.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
