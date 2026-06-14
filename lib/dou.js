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
  // getSetCookie() retorna array com todos os cookies (Node 18+); fallback para get()
  const rawCookies = res.headers.getSetCookie
    ? res.headers.getSetCookie()
    : (res.headers.get("set-cookie") || "").split(/,(?=[^ ])/);
  const session = rawCookies.find((c) => c.includes("inlabs_session_cookie="));
  if (!session) {
    throw new Error("Falha no login do INLABS (cookie nao retornado).");
  }
  // Envia todos os cookies para que o servidor aceite o download
  return rawCookies.map((c) => c.split(";")[0]).join("; ");
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
const NOMEAR = /\b(nomear|nomeia|nomeado|designar|designa|designado|reconduzir|reconduz|promover|prorrogar a nomea[çc][ãa]o)\b/i;
const EXONERAR = /\b(exonerar|exonera|exonerado|dispensar|dispensa|dispensado|tornar sem efeito a nomea[çc][ãa]o)\b/i;
// Sequencia em CAIXA ALTA: 2-8 tokens (palavras 2+ letras ou conectores DA/DE/DO).
const CAPS_RE = /\b([A-ZÀ-Ý]{2,}(?:\s+(?:D[AEO]S?|E|[A-ZÀ-Ý]{2,})){1,7})\b/g;
// Nome apos "Sr./Sra." ou apos dois-pontos (atos curtos com nome antes do cargo)
const SR_RE = /\bSr[a]?\.?\s+([A-ZÀ-Ý][a-zà-ÿ]+(?:\s+(?:d[aeo]s?\s+)?[A-ZÀ-Ý][a-zà-ÿ]+){1,5})/g;
// Nome apos verbo de nomeação seguido de cargo: NOMEAR ... cargo de X, <NOME>
const POST_CARGO_RE = /(?:cargo de|função de|posto de)\s+[^,;\n]{5,60}[,\s]+([A-ZÀ-Ý]{2,}(?:\s+(?:D[AEO]S?|E|[A-ZÀ-Ý]{2,})){1,6})/gi;
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

// Remove acentos para comparar com o conjunto INSTITUTIONAL (que e sem acento).
function bare(w) {
  return w.normalize("NFD").replace(/[̀-ͯ]/g, "");
}
function isInst(w) { return INSTITUTIONAL.has(bare(w)); }

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
    while (words.length && isInst(words[0])) words.shift();
    while (words.length && isInst(words[words.length - 1])) words.pop();
    // Apara conectores soltos nas pontas.
    while (words.length && /^(D[AEO]S?|E)$/.test(words[0])) words.shift();
    while (words.length && /^(D[AEO]S?|E)$/.test(words[words.length - 1])) words.pop();
    const realWords = words.filter((w) => w.length > 2);
    // Nome de pessoa: 2-6 palavras "reais" e nenhum token institucional remanescente.
    if (realWords.length < 2 || realWords.length > 8) continue;
    if (words.some((w) => isInst(w))) continue;
    const name = words.join(" ");
    const key = name.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // Title Case para exibicao (RICARDO LEME -> Ricardo Leme).
    const display = name.split(" ").map((w) =>
      /^D[AEO]S?$|^E$/.test(w) ? w.toLowerCase() : w.charAt(0) + w.slice(1).toLowerCase()
    ).join(" ");
    people.push({ name: display, action, role });
    if (people.length >= 12) break;
  }

  // Extrair nomes apos "Sr./Sra."
  SR_RE.lastIndex = 0;
  let sm;
  while ((sm = SR_RE.exec(raw)) !== null && people.length < 12) {
    const display = sm[1].trim();
    const key = display.toUpperCase();
    if (!seen.has(key)) { seen.add(key); people.push({ name: display, action, role }); }
  }

  // Extrair nomes apos "cargo de X, <NOME>" (nome vem depois do cargo)
  POST_CARGO_RE.lastIndex = 0;
  let pc;
  while ((pc = POST_CARGO_RE.exec(raw)) !== null && people.length < 12) {
    const rawName = pc[1].trim();
    const words2 = rawName.split(/\s+/);
    while (words2.length && isInst(words2[0])) words2.shift();
    while (words2.length && isInst(words2[words2.length - 1])) words2.pop();
    if (words2.length < 2 || words2.some((w) => isInst(w))) continue;
    const display = words2.map((w) =>
      /^D[AEO]S?$|^E$/.test(w.toUpperCase()) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
    ).join(" ");
    const key = display.toUpperCase();
    if (!seen.has(key)) { seen.add(key); people.push({ name: display, action, role }); }
  }

  return people;
}

// Coleta os atos das agencias para uma data. agencies = [{id, acronym}].
// Aceita { cookie } para reusar uma sessao ja autenticada (evita rate-limit do
// INLABS, que bloqueia o IP apos ~20 logins seguidos).
async function collectDou(date, agencies, { sections = [1, 2, 3], cookie } = {}) {
  const sessionCookie = cookie || (await login());
  const out = [];
  for (const section of sections) {
    const files = await downloadSection(sessionCookie, date, section);
    for (const file of files) {
      const record = parseArticle(file.getData().toString("utf8"), date, section);
      const agency = matchAgency(record, agencies);
      if (agency) out.push({ ...record, agency_id: agency.id, agency_acronym: agency.acronym });
    }
  }
  return out;
}

module.exports = { collectDou, login, parseArticle, matchAgency, extractPeopleFromAto };
