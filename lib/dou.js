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

// Extrai pessoas (nomeacoes/exoneracoes) de um ato de pessoal via regex.
// No DOU os nomes vem em CAIXA ALTA (ex: "RICARDO LEME DA SILVA FONSECA").
// Retorna [{name, action, role}] onde action = 'nomeacao' | 'exoneracao'.
const NOMEAR = /\b(nomear|designar|reconduzir|prorrogar a nomea[çc][ãa]o)\b/i;
const EXONERAR = /\b(exonerar|dispensar|tornar sem efeito a nomea[çc][ãa]o)\b/i;
// Sequencia em CAIXA ALTA: 2-6 tokens (palavras 2+ letras ou conectores DA/DE/DO).
const CAPS_RE = /\b([A-ZÀ-Ý]{2,}(?:\s+(?:D[AEO]S?|E|[A-ZÀ-Ý]{2,})){1,5})\b/g;
const ROLE_RE = /\b(Diretor(?:-Geral|-Presidente|a)?|Presidente|Superintendente|Procurador(?:-Geral)?|Ouvidor|Secret[áa]rio(?:-Geral)?|Chefe de Gabinete)\b/i;
// Tokens institucionais: se a sequencia contiver qualquer um, NAO e nome de pessoa.
const INSTITUTIONAL = new Set([
  "AGENCIA","NACIONAL","ENERGIA","ELETRICA","PETROLEO","TELECOMUNICACOES","SAUDE","AGUAS",
  "TRANSPORTES","AVIACAO","CINEMA","MINERACAO","VIGILANCIA","SANITARIA","SUPLEMENTAR",
  "MINISTERIO","ESTADO","UNIAO","REPUBLICA","FEDERATIVA","EXECUTIVO","CASA","CIVIL",
  "DIRETOR","DIRETORA","PRESIDENTE","SUPERINTENDENTE","PROCURADOR","OUVIDOR","SECRETARIO",
  "GABINETE","SECRETARIA","FISCALIZACAO","FUNCAO","CARGO","LEI","PORTARIA","DECRETO","ART",
  "RESOLUCAO","DIARIO","OFICIAL","MANDATO","ANOS","TERMOS","COMISSIONADO","DAS","SUBSTITUTO",
  "GERAL","ADJUNTO","COORDENACAO","DEPARTAMENTO","DIRETORIA","COLEGIADA","CONSELHO","ANEEL",
  "ANATEL","ANVISA","ANP","ANS","ANA","ANTT","ANTAQ","ANAC","ANCINE","ANM",
  "NOMEAR","DESIGNAR","EXONERAR","DISPENSAR","RECONDUZIR","RESOLVE","RESOLVEM","TORNAR",
  "EFEITO","PRORROGAR","NOMEACAO","PEDIDO","VAGO","SUBSTITUICAO","INTERINO"
]);

function extractPeopleFromAto(text) {
  const raw = String(text || "");
  if (!raw) return [];
  const action = EXONERAR.test(raw) ? "exoneracao" : NOMEAR.test(raw) ? "nomeacao" : null;
  if (!action) return [];
  const role = (raw.match(ROLE_RE) || [])[0] || "Dirigente";
  const seen = new Set();
  const people = [];
  let m;
  CAPS_RE.lastIndex = 0;
  while ((m = CAPS_RE.exec(raw)) !== null) {
    let words = m[1].replace(/\s+/g, " ").trim().split(" ");
    // Apara tokens institucionais/verbos das pontas (ex: "NOMEAR RICARDO ..." -> "RICARDO ...").
    while (words.length && INSTITUTIONAL.has(words[0])) words.shift();
    while (words.length && INSTITUTIONAL.has(words[words.length - 1])) words.pop();
    // Apara conectores soltos nas pontas.
    while (words.length && /^(D[AEO]S?|E)$/.test(words[0])) words.shift();
    while (words.length && /^(D[AEO]S?|E)$/.test(words[words.length - 1])) words.pop();
    const realWords = words.filter((w) => w.length > 2);
    // Nome de pessoa: 2-6 palavras "reais" e nenhum token institucional remanescente.
    if (realWords.length < 2 || realWords.length > 6) continue;
    if (words.some((w) => INSTITUTIONAL.has(w))) continue;
    const name = words.join(" ");
    const key = name.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // Title Case para exibicao (RICARDO LEME -> Ricardo Leme).
    const display = name.split(" ").map((w) =>
      /^D[AEO]S?$|^E$/.test(w) ? w.toLowerCase() : w.charAt(0) + w.slice(1).toLowerCase()
    ).join(" ");
    people.push({ name: display, action, role });
    if (people.length >= 8) break;
  }
  return people;
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

module.exports = { collectDou, parseArticle, matchAgency, extractPeopleFromAto };
