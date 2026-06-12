// Coletor do Diario Oficial da Uniao via INLABS (Imprensa Nacional).
// Login gratuito em https://inlabs.in.gov.br/ -> credenciais em env vars
// INLABS_EMAIL / INLABS_SENHA. Baixa o ZIP de XMLs por secao/data e faz parse.
const crypto = require("crypto");
const AdmZip = require("adm-zip");

const BASE = "https://inlabs.in.gov.br";
// Secao 1 = normas/atos | Secao 2 = pessoal (nomeacoes) | Secao 3 = contratos
const SECTIONS = { 1: "DO1", 2: "DO2", 3: "DO3" };

function attr(block, name) {
  const m = block.match(new RegExp(`${name}="([^"]*)"`, "i"));
  return m ? m[1] : "";
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
  if (!m) return "";
  return m[1]
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// Autentica no INLABS e devolve o cookie de sessao.
async function login() {
  const email = process.env.INLABS_EMAIL;
  const senha = process.env.INLABS_SENHA;
  if (!email || !senha) {
    throw new Error("INLABS_EMAIL e INLABS_SENHA precisam estar configuradas.");
  }
  const body = new URLSearchParams({ email, password: senha }).toString();
  const res = await fetch(`${BASE}/logar.php`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual"
  });
  const cookie = res.headers.get("set-cookie") || "";
  const session = cookie.match(/inlabs_session_cookie=([^;]+)/);
  if (!session) {
    throw new Error("Falha no login do INLABS (cookie nao retornado).");
  }
  return `inlabs_session_cookie=${session[1]}`;
}

// Baixa e descompacta o ZIP de uma secao em uma data (YYYY-MM-DD).
async function downloadSection(cookie, date, section) {
  const file = `${date}-${SECTIONS[section]}.zip`;
  const url = `${BASE}/index.php?p=${date}&dl=${file}`;
  const res = await fetch(url, { headers: { Cookie: cookie } });
  if (!res.ok) return [];
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 200) return []; // sem edicao nesse dia/secao
  let entries;
  try {
    entries = new AdmZip(buffer).getEntries();
  } catch {
    return [];
  }
  return entries.filter((e) => e.entryName.endsWith(".xml"));
}

// Converte um XML de artigo do INLABS num registro normalizado.
function parseArticle(xml, date, section) {
  const article = xml.match(/<article[\s\S]*?<\/article>/i)?.[0] || xml;
  const id = attr(article, "id") || attr(article, "idOficio");
  const title =
    tag(article, "Identifica") ||
    attr(article, "name") ||
    "Ato sem titulo";
  const text = [tag(article, "Ementa"), tag(article, "Titulo"), tag(article, "Texto")]
    .filter(Boolean)
    .join("\n");
  const orgao = attr(article, "artCategory") || attr(article, "pubName");
  return {
    external_id: id,
    section,
    title,
    orgao,
    published_at: date,
    extracted_text: text,
    source_url: `https://www.in.gov.br/web/dou/-/${id}`,
    content_hash: hash(`${id}|${title}|${date}`)
  };
}

// Tenta casar o orgao do ato com uma das agencias (por sigla no texto/categoria).
function matchAgency(record, agencies) {
  const haystack = `${record.orgao} ${record.title} ${record.extracted_text}`.toUpperCase();
  return agencies.find((a) => new RegExp(`\\b${a.acronym}\\b`).test(haystack)) || null;
}

// Coleta os atos das agencias para uma data. agencies = [{id, acronym}].
async function collectDou(date, agencies, { sections = [1, 2, 3] } = {}) {
  const cookie = await login();
  const out = [];
  for (const section of sections) {
    const files = await downloadSection(cookie, date, section);
    for (const file of files) {
      const record = parseArticle(file.getData().toString("utf8"), date, section);
      const agency = matchAgency(record, agencies);
      if (agency) out.push({ ...record, agency_id: agency.id, agency_acronym: agency.acronym });
    }
  }
  return out;
}

module.exports = { collectDou, parseArticle, matchAgency };
