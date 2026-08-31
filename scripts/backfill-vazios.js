// Backfill FASE A — só os dias úteis que fecharam com ZERO atos no acervo.
//
// POR QUE ESTA FASE EXISTE SEPARADA DA FASE B:
// Dia vazio nao tem colisao possivel. Ele cai na Camada 1 (particionamento temporal),
// que e 100% confiavel e trivial — nada de guarda textual, fila de revisao ou dedupe
// entre fontes. Por isso a maior parte da cobertura perdida volta com risco ZERO.
//
// Os dias PARCIAIS (Fase B) sao o caso dificil: recolher um dia ja servido pelo INLABS
// reconhece 0 de 225 por content_hash, e titulo normalizado nao e chave (colide dentro
// da propria fonte). Esses ficam de fora ate a Camada 3 estar a 100% — e persistDou
// recusa toca-los (PARTICAO_VIOLADA).
//
// Uso: node scripts/backfill-vazios.js [--de=YYYY-MM-DD] [--ate=YYYY-MM-DD] [--dry-run] [--limit=N]
require("dotenv").config();
const { getSupabase } = require("../lib/supabase");
const { collectDouPublico } = require("../lib/dou-publico");
const { persistDou } = require("../lib/dou-persist");
const { loadActiveMonitors } = require("../lib/ingest");

const arg = (n, p) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : p;
};
const dryRun = process.argv.includes("--dry-run");

const FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit"
});

function diasUteis(de, ate) {
  const out = [];
  const cur = new Date(`${de}T12:00:00Z`), fim = new Date(`${ate}T12:00:00Z`);
  while (cur <= fim) {
    const w = cur.getUTCDay();
    if (w !== 0 && w !== 6) out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

// Paginado: o acervo passa de 34 mil linhas e o teto do PostgREST e 1000.
async function contarPorDia(supabase) {
  const porDia = {};
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("documents").select("published_at")
      .eq("source_name", "DOU").order("published_at").range(from, from + 999);
    if (error) throw error;
    for (const d of data || []) porDia[d.published_at] = (porDia[d.published_at] || 0) + 1;
    if (!data || data.length < 1000) break;
  }
  return porDia;
}

async function main() {
  const supabase = getSupabase();
  const hoje = FMT.format(new Date());
  const de = arg("de", "2026-02-13");
  const ate = arg("ate", hoje);
  const limite = Number(arg("limit", 0)) || Infinity;

  const { data: agencies, error: agErr } = await supabase
    .from("agencies").select("id, acronym, name").eq("sector", "regulatory");
  if (agErr) { console.error(`ERRO ao ler agencias: ${agErr.message}`); process.exit(1); }

  const porDia = await contarPorDia(supabase);
  const uteis = diasUteis(de, ate);
  const vazios = uteis.filter((d) => !porDia[d]);
  const ocupados = uteis.length - vazios.length;

  console.log(`=== Backfill Fase A (dias vazios) ===`);
  console.log(`Intervalo    : ${de} -> ${ate}`);
  console.log(`Dias uteis   : ${uteis.length}`);
  console.log(`Ocupados     : ${ocupados} (NAO tocados — sao a Fase B)`);
  console.log(`VAZIOS       : ${vazios.length}${limite < Infinity ? ` (processando ${Math.min(limite, vazios.length)})` : ""}\n`);
  if (!vazios.length) { console.log("Nenhum dia vazio. Nada a fazer."); return; }

  const monitores = await loadActiveMonitors(supabase);
  const alvos = vazios.slice(0, limite);
  let inseridos = 0, semEdicao = 0, falhas = 0;

  for (let i = 0; i < alvos.length; i++) {
    const dia = alvos[i];
    process.stdout.write(`[${i + 1}/${alvos.length}] ${dia} ... `);
    try {
      // No dry-run so interessa a contagem: pular o texto integral economiza ~200
      // fetches por dia e deixa o levantamento rodar em segundos.
      const records = await collectDouPublico(dia, agencies || [], { comTextoIntegral: !dryRun });
      if (records.semEdicao) { semEdicao++; console.log("sem edicao"); continue; }
      // Feriado com edicao minima: publicou pouco, nada de agencia. Nao e falha.
      if (records.edicaoMinima) { semEdicao++; console.log(`edicao minima (${records.totalPublicados} atos, 0 de agencia)`); continue; }
      if (records.matcherSuspeito) {
        falhas++;
        console.log(`FALHA: ${records.totalPublicados} publicados, 0 casaram (matcher?)`);
        continue;
      }
      if (dryRun) {
        console.log(`${records.length} atos (dry-run, nada gravado)`);
        if (i < 3) {
          for (const r of records.slice(0, 3)) console.log(`      ${r.agency_acronym} · ${r.title.slice(0, 58)}`);
        }
        continue;
      }
      // comAlertas: false — sao fatos VELHOS. Gerar alerta "novo" para ato de 3 meses
      // atras afogaria os alertas do dia com ruido historico.
      const r = await persistDou(supabase, records, {
        analisar: null, comPessoas: false, comAlertas: false, monitores
      });
      inseridos += r.inserted;
      console.log(`+${r.inserted} atos${r.skipped ? `, ${r.skipped} ja existiam` : ""}`);
    } catch (e) {
      falhas++;
      console.log(`ERRO: ${e.code === "PARTICAO_VIOLADA" ? "dia ja servido por outra fonte (Fase B)" : e.message}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  console.log(`\n=== Fase A concluida ===`);
  console.log(`Dias processados : ${alvos.length}`);
  console.log(`Sem edicao       : ${semEdicao}`);
  console.log(`Falhas           : ${falhas}`);
  console.log(`Atos inseridos   : ${inseridos}`);
  if (dryRun) console.log(`\n(dry-run: nenhuma gravacao realizada)`);

  const tentados = alvos.length - semEdicao;
  if (tentados > 0 && falhas === tentados) {
    console.error(`\nERRO: todos os ${tentados} dias falharam.`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
