// Backfill "ao vivo" da rede societaria (QSA), SEM baixar o dump gigante da
// Receita. Itera as empresas ja no banco, consulta o CNPJ.ws e persiste o QSA
// (companies + relationships 'socio') reusando lib/qsa.js.
//
// Uso:
//   node scripts/backfill-qsa.js [--limit N] [--only-empty] [--dry-run]
//     --limit N      processa no maximo N empresas (default 50)
//     --only-empty   so empresas que ainda nao tem socios no grafo
//     --dry-run      nao grava; so mostra o que faria
//
// Rate limit: o publica.cnpj.ws gratuito e ~3 req/min. Por padrao esperamos
// ~21s entre chamadas (THROTTLE_MS) para nao tomar bloqueio. Ajuste se tiver
// plano pago. Idempotente: rodar de novo nao duplica arestas (lib/qsa dedupe).
require("dotenv").config();
const { getSupabase } = require("../lib/supabase");
const { persistCnpj } = require("../lib/qsa");

const THROTTLE_MS = Number(process.env.CNPJWS_THROTTLE_MS || 21000);

function onlyDigits(v) { return String(v || "").replace(/\D/g, ""); }
function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const onlyEmpty = process.argv.includes("--only-empty");
  const limit = Math.max(1, Number(arg("--limit")) || 50);

  const supabase = getSupabase();

  // Empresas com CNPJ completo (14 digitos) — o CNPJ.ws precisa do numero cheio.
  // Pagina em blocos de 1000 (o PostgREST limita cada resposta), senao empresas
  // alem da 1000a nunca receberiam QSA.
  // qsa_checked_at pode nao existir ainda (migracao aplicada a mao pelo operador).
  // Degrada em vez de quebrar: sem a coluna o script volta ao comportamento antigo.
  let temColunaQsa = true;
  const companies = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const cols = temColunaQsa ? "id, cnpj, legal_name, qsa_checked_at" : "id, cnpj, legal_name";
    const { data, error } = await supabase
      .from("companies")
      .select(cols)
      .not("cnpj", "is", null)
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      if (temColunaQsa && /qsa_checked_at/.test(error.message)) {
        console.warn("! coluna qsa_checked_at ausente — rode a migracao para a fila parar de reciclar empresas ja consultadas.");
        temColunaQsa = false;
        from -= PAGE; // refaz esta pagina sem a coluna
        continue;
      }
      console.error("Erro ao listar empresas:", error.message);
      process.exit(1);
    }
    companies.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }

  // CNPJ de 14 digitos: o PNCP injeta `niFornecedor` cru, e vem fornecedor
  // estrangeiro ("EXANVS016") e CPF de 11. Eles nunca serao consultaveis, entao
  // ficavam presos na fila para sempre.
  let candidates = companies.filter((c) => onlyDigits(c.cnpj).length === 14);

  // Ja consultada nao volta para a fila, mesmo que tenha voltado SEM socios (MEI,
  // empresario individual). Antes so se olhava a ausencia de aresta 'socio', entao
  // essas eram reconsultadas 2x/dia indefinidamente.
  const antesDoFiltro = candidates.length;
  candidates = candidates.filter((c) => !c.qsa_checked_at);
  if (antesDoFiltro !== candidates.length) {
    console.log(`Ignoradas ${antesDoFiltro - candidates.length} ja consultadas (qsa_checked_at).`);
  }

  // --only-empty: descarta empresas que ja tem alguma aresta 'socio' apontando p/ elas.
  // Chunka o .in() (o PostgREST limita a resposta) e ABORTA se a query falhar,
  // para nao anular silenciosamente o filtro reprocessando tudo.
  if (onlyEmpty && candidates.length) {
    const ids = candidates.map((c) => c.id);
    const withSocios = new Set();
    const CHUNK = 300;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const { data: rels, error: relErr } = await supabase
        .from("relationships")
        .select("to_id")
        .eq("to_kind", "company")
        .eq("relationship", "socio")
        .in("to_id", ids.slice(i, i + CHUNK));
      if (relErr) { console.error("Erro ao checar relationships:", relErr.message); process.exit(1); }
      for (const r of rels || []) withSocios.add(r.to_id);
    }
    candidates = candidates.filter((c) => !withSocios.has(c.id));
  }

  candidates = candidates.slice(0, limit);
  console.log(`Empresas elegiveis: ${candidates.length} (limit=${limit}${onlyEmpty ? ", only-empty" : ""})`);
  if (!candidates.length) return;

  let ok = 0, edges = 0, failed = 0, avisouColuna = false;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const cnpj = onlyDigits(c.cnpj);
    if (dryRun) { console.log(`  [dry] ${cnpj} ${c.legal_name || ""}`); continue; }

    try {
      const resp = await fetch(`https://publica.cnpj.ws/cnpj/${cnpj}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15000) });
      if (!resp.ok) { failed++; console.log(`  x ${cnpj} HTTP ${resp.status}`); }
      else {
        const data = await resp.json().catch(() => null);
        const r = data ? await persistCnpj(data) : { ok: false, error: "json vazio" };
        if (r.ok) {
          ok++; edges += r.edges_created || 0;
          // Marca a consulta MESMO quando volta sem socios: e justamente esse caso
          // (MEI, empresario individual) que ficava reciclando na fila para sempre.
          const { error: eMark } = await supabase
            .from("companies").update({ qsa_checked_at: new Date().toISOString() }).eq("id", c.id);
          // Coluna ausente (migracao nao aplicada): avisa uma vez e segue — sem ela o
          // script volta ao comportamento antigo, que funciona, so nao economiza quota.
          if (eMark && !avisouColuna) { avisouColuna = true; console.warn(`  ! qsa_checked_at indisponivel (${eMark.message}) — rode a migracao para a fila parar de reciclar.`); }
          console.log(`  + ${cnpj} ${c.legal_name || ""} -> ${r.socios} socios, ${r.edges_created} aresta(s)`);
        }
        else { failed++; console.log(`  x ${cnpj} ${r.error}`); }
      }
    } catch (e) { failed++; console.log(`  x ${cnpj} ${e.message}`); }

    // Throttle (menos na ultima).
    if (i < candidates.length - 1) await sleep(THROTTLE_MS);
  }

  console.log(`\n=== Backfill QSA concluido ===`);
  console.log(`Processadas: ${candidates.length} | OK: ${ok} | novas arestas: ${edges} | falhas: ${failed}`);
  if (dryRun) console.log(`(dry-run: nada gravado)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
