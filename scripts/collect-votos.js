// Auto-coletor de deliberacoes/atas (modulo Voto dos Diretores). Roda no GITHUB
// ACTIONS (nao no Vercel — puppeteer + agendamento nao cabem no Hobby). Carrega
// as paginas de "reunioes da diretoria" das agencias, acha os PDFs recentes,
// baixa e joga na ESTEIRA compartilhada (lib/vote-pipeline.processPdfToVotos).
// Dedup por hash do arquivo (upload_jobs.file_hash). SEM IA.
//
// Env (secrets do Actions): SUPABASE_URL, SUPABASE_SERVICE_KEY.
// puppeteer e instalado SO no Actions (nao vai no package.json -> nao incha o Vercel).
//
// v1: pega PDFs LINKADOS na pagina de listagem. Sites que escondem os PDFs atras
// de sub-paginas (ex.: ANTT reuniao->processo->doc) precisam de navegacao
// especifica — refino incremental conforme a 1a rodada mostrar o que falta.
require("dotenv").config();
const crypto = require("crypto");
const { getSupabase } = require("../lib/supabase");
const { processPdfToVotos } = require("../lib/vote-pipeline");

const SITES = [
  { sigla: "ANTT", url: "https://portal.antt.gov.br/web/guest/reunioes-da-diretoria" },
  { sigla: "ANM", url: "https://www.gov.br/anm/pt-br/composicao/diretoria-colegiada/reunioes-da-diretoria-colegiada" },
  { sigla: "ARTESP", url: "https://www.artesp.sp.gov.br/artesp/transparencia/reunioes-diretoria" },
];

const YEARS = [String(new Date().getFullYear()), String(new Date().getFullYear() - 1)];
const KEYWORDS = /(delibera|\bata\b|reuni[aã]o|colegiad|diretoria)/i;
const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MAX_PDFS_PER_SITE = Number(process.env.COLLECTOR_MAX_PER_SITE || 25);

// Extrai links de PDF (absolutos) + texto da pagina renderizada.
async function discoverPdfLinks(page, baseUrl) {
  return page.evaluate((base) => {
    const out = [];
    for (const a of Array.from(document.querySelectorAll("a[href]"))) {
      let href = a.getAttribute("href") || "";
      const text = (a.textContent || "").replace(/\s+/g, " ").trim();
      if (!/\.pdf($|\?)/i.test(href)) continue;
      try { href = new URL(href, base).href; } catch { continue; }
      out.push({ href, text });
    }
    return out;
  }, baseUrl);
}

async function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function main() {
  let puppeteer;
  try { puppeteer = require("puppeteer"); }
  catch { console.error("puppeteer nao instalado (rode no GitHub Actions ou `npm i puppeteer`)."); process.exit(1); }

  const supabase = getSupabase();
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  let totalDelibs = 0, totalVotos = 0, totalPdfs = 0, skipped = 0, failed = 0;

  for (const site of SITES) {
    console.log(`\n=== ${site.sigla}: ${site.url}`);
    let links = [];
    try {
      const page = await browser.newPage();
      await page.setUserAgent("Mozilla/5.0 (compatible; LINCE-collector/1.0)");
      await page.goto(site.url, { waitUntil: "networkidle2", timeout: 45000 });
      links = await discoverPdfLinks(page, site.url);
      await page.close();
    } catch (e) { console.error(`  falha ao carregar: ${e.message}`); failed++; continue; }

    // Filtra por palavra-chave e ano (no href ou no texto do link).
    const cand = links.filter((l) => {
      const hay = `${l.href} ${l.text}`;
      return KEYWORDS.test(hay) && YEARS.some((y) => hay.includes(y));
    }).slice(0, MAX_PDFS_PER_SITE);
    console.log(`  ${links.length} PDFs na pagina | ${cand.length} candidatos (deliberacao/ata, ano recente)`);

    for (const l of cand) {
      try {
        const r = await fetch(l.href, { signal: AbortSignal.timeout(30000) });
        if (!r.ok) { console.log(`  x ${r.status} ${l.href}`); failed++; continue; }
        const ab = await r.arrayBuffer();
        if (ab.byteLength > MAX_PDF_BYTES) { console.log(`  x grande demais ${l.href}`); skipped++; continue; }
        const buffer = Buffer.from(ab);
        const hash = await sha256(buffer);
        totalPdfs++;

        // Dedup por hash (upload_jobs).
        const { data: seen } = await supabase.from("upload_jobs").select("id").eq("file_hash", hash).limit(1);
        if (seen && seen.length) { skipped++; continue; }
        const { data: job } = await supabase.from("upload_jobs")
          .insert({ filename: l.text.slice(0, 200) || l.href.split("/").pop(), file_hash: hash, status: "processing", metadata: { url: l.href, sigla: site.sigla } })
          .select("id").single();

        const out = await processPdfToVotos(supabase, { buffer, agencyAcronym: site.sigla, filename: l.text.slice(0, 200), source: "collector" });
        if (job) await supabase.from("upload_jobs").update({ status: out.ok ? "done" : "failed", error_message: out.ok ? null : String(out.error).slice(0, 500) }).eq("id", job.id);
        if (out.ok) { totalDelibs++; totalVotos += out.votos || 0; console.log(`  + delib ${out.numero}: ${out.votos} voto(s) [${out.nominais} nominais]`); }
        else { console.log(`  ~ ${out.error}`); }
      } catch (e) { console.error(`  x ${l.href}: ${e.message}`); failed++; }
    }
  }

  await browser.close();
  console.log(`\n=== Coleta concluida ===`);
  console.log(`PDFs baixados: ${totalPdfs} | deliberacoes: ${totalDelibs} | votos: ${totalVotos} | pulados(dedup): ${skipped} | falhas: ${failed}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
