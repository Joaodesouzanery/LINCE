// F-INT1 (Fase 1): materializa as arestas de SOCIO a partir do companies.shareholding
// JA GRAVADO no banco. Nao faz rede (o QSA ja foi baixado) -> sem throttle.
//
// POR QUE ISSO EXISTE: o ramo de socio PF do lib/qsa.persistCnpj falhava em SILENCIO
// (o insert em `people` descartava o `error`, retornava null e o chamador fazia
// `continue`; e o ensureSocioEdge retornava `true` sempre, entao o log dizia sucesso).
// Resultado medido em producao: 207 empresas com QSA no jsonb e ZERO arestas
// pessoa->empresa no grafo. Isso deixa vazios: grafo societario, dossie de empresa,
// lib/counterparty (due diligence), type=holdings e a rede societaria do political_risk.
//
// EXPECTATIVA HONESTA: isto NAO acende sozinho porta-giratoria/correlacoes — o overlap
// medido entre os socios PF do QSA e as pessoas COM MANDATO e zero. Para isso e preciso
// vir pelo lado inverso (do diretor para as empresas dele).
//
// Uso: node scripts/backfill-socio-edges.js [--commit] [--limit N]
//      (sem --commit e DRY-RUN)
require("dotenv").config();
const { getSupabase } = require("../lib/supabase");
const { upsertPerson } = require("../lib/people");
const { ensureSocioEdge, upsertCompany } = require("../lib/qsa");
const { onlyDigits } = require("../lib/text");

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }

// Guarda minima contra lixo virar "pessoa" no grafo (o QSA traz nome cru).
function isLikelyPersonName(nome) {
  const s = String(nome || "").trim();
  if (s.length < 6) return false;
  const tokens = s.split(/\s+/).filter((t) => t.length >= 2);
  return tokens.length >= 2;
}

async function main() {
  const commit = process.argv.includes("--commit");
  const limit = Math.max(1, Number(arg("--limit")) || 100000);
  const supabase = getSupabase();

  const companies = [];
  for (let from = 0; from < 100000; from += 1000) {
    const { data, error } = await supabase.from("companies")
      .select("id, cnpj, legal_name, shareholding")
      .order("id", { ascending: true }).range(from, from + 999);
    if (error) { console.error("Erro ao ler companies:", error.message); process.exit(1); }
    companies.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const comQsa = companies.filter((c) => Array.isArray(c.shareholding) && c.shareholding.length);
  const totalPf = comQsa.reduce((s, c) => s + c.shareholding.filter((x) => x.tipo !== "PJ").length, 0);
  const totalPj = comQsa.reduce((s, c) => s + c.shareholding.filter((x) => x.tipo === "PJ").length, 0);
  console.log(`Empresas: ${companies.length} | com QSA: ${comQsa.length} | socios PF: ${totalPf} | PJ: ${totalPj}`);

  if (!commit) {
    const ignorados = comQsa.flatMap((c) => c.shareholding.filter((x) => x.tipo !== "PJ" && !isLikelyPersonName(x.nome)).map((x) => x.nome));
    console.log(`\nDRY-RUN — nada gravado.`);
    console.log(`Criaria/garantiria ate ${totalPf} aresta(s) pessoa->empresa e ${totalPj} empresa->empresa.`);
    if (ignorados.length) console.log(`${ignorados.length} nome(s) descartado(s) por nao parecerem pessoa: ${ignorados.slice(0, 5).join(" | ")}`);
    for (const c of comQsa.slice(0, 3)) console.log(`  ex.: ${c.legal_name} -> ${c.shareholding.map((s) => `${s.nome} (${s.tipo})`).slice(0, 3).join(", ")}`);
    console.log(`\nRode com --commit para aplicar.`);
    return;
  }

  let arestasPf = 0, arestasPj = 0, jaExistiam = 0, pessoas = 0, ignorados = 0, falhas = 0;
  let n = 0;
  for (const c of comQsa) {
    if (n >= limit) break;
    n++;
    for (const s of c.shareholding) {
      const meta = { role: String(s.role || "").trim() || "Socio", data_entrada: s.data_entrada || null, doc: s.doc || null };
      try {
        if (s.tipo === "PJ") {
          const cnpj = onlyDigits(s.doc);
          if (cnpj.length !== 14) { ignorados++; continue; }
          const socioCompanyId = await upsertCompany(supabase, { cnpj, legal_name: s.nome });
          if (!socioCompanyId || socioCompanyId === c.id) { ignorados++; continue; }
          if (await ensureSocioEdge(supabase, "company", socioCompanyId, c.id, meta)) arestasPj++; else jaExistiam++;
        } else {
          if (!isLikelyPersonName(s.nome)) { ignorados++; continue; }
          const person = await upsertPerson(supabase, { full_name: s.nome, role: meta.role });
          if (!person?.id) { ignorados++; continue; }
          pessoas++;
          if (await ensureSocioEdge(supabase, "person", person.id, c.id, meta)) arestasPf++; else jaExistiam++;
        }
      } catch (e) {
        falhas++;
        console.error(`  x ${c.legal_name} / ${s.nome}: ${e.message}`);
      }
    }
    if (n % 25 === 0) console.log(`  ${n}/${comQsa.length} empresas — ${arestasPf + arestasPj} aresta(s) novas`);
  }

  console.log(`\n=== backfill:socio-edges concluido ===`);
  console.log(`Empresas processadas: ${n} | pessoas resolvidas: ${pessoas}`);
  console.log(`Arestas NOVAS: ${arestasPf} pessoa->empresa + ${arestasPj} empresa->empresa | ja existiam: ${jaExistiam}`);
  console.log(`Ignorados: ${ignorados} | falhas: ${falhas}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
