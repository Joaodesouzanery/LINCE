// Coletor do Diario Oficial da Uniao via INLABS (Imprensa Nacional).
// Login gratuito em https://inlabs.in.gov.br/ -> credenciais em env vars
// INLABS_EMAIL / INLABS_SENHA. Baixa o ZIP de XMLs por secao/data e faz parse.
const crypto = require("crypto");
const AdmZip = require("adm-zip");
const { normalizeNameKey } = require("./text");

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
// Em erro de autenticacao (401/403) lanca AuthError para o caller re-logar.
// Com DOU_DEBUG=1, loga status HTTP, tamanho do buffer e nº de XMLs por seção.
class AuthError extends Error {}
async function downloadSection(cookie, date, section) {
  const debug = !!process.env.DOU_DEBUG;
  const file = `${date}-${SECTIONS[section]}.zip`;
  const url = `${BASE}/index.php?p=${date}&dl=${file}`;
  const res = await fetch(url, { headers: { Cookie: cookie } });
  if (res.status === 401 || res.status === 403) {
    if (debug) console.log(`    [DEBUG ${date} S${section}] HTTP ${res.status} — cookie inválido, re-login necessário`);
    throw new AuthError(`HTTP ${res.status} no download (sessão expirada)`);
  }
  if (!res.ok) {
    if (debug) console.log(`    [DEBUG ${date} S${section}] HTTP ${res.status} (sem edição nesse dia/seção) — ${url}`);
    return [];
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 200) {
    if (debug) console.log(`    [DEBUG ${date} S${section}] buffer ${buffer.length}B (vazio)`);
    return [];
  }
  // ZIP magic bytes: PK (0x50 0x4B). Se não começar assim, é HTML.
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4B) {
    // Distingue página de login (sessão expirada) de página "sem edição".
    const peek = buffer.slice(0, 1024).toString("utf8").toLowerCase();
    if (peek.includes("senha") || peek.includes("logar") || peek.includes("login") || peek.includes("acesso negado")) {
      if (debug) console.log(`    [DEBUG ${date} S${section}] sessão expirada (HTML de login com HTTP 200) — re-login necessário`);
      throw new AuthError(`Sessão expirada detectada via HTML (HTTP 200 com página de login)`);
    }
    if (debug) console.log(`    [DEBUG ${date} S${section}] sem edição nesse dia/seção`);
    return [];
  }
  let entries;
  try {
    entries = new AdmZip(buffer).getEntries();
  } catch (e) {
    if (debug) console.log(`    [DEBUG ${date} S${section}] falha ao abrir ZIP: ${e.message}`);
    return [];
  }
  const xmls = entries.filter((e) => e.entryName.endsWith(".xml"));
  if (debug) console.log(`    [DEBUG ${date} S${section}] HTTP 200 · ${(buffer.length / 1024).toFixed(0)}KB · ${xmls.length} XMLs`);
  return xmls;
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

// Siglas curtas (3 letras) que colidem com nomes proprios/palavras comuns —
// "ANA" e prenome hipercomum, aparece em CAIXA ALTA em atos de pessoal de todo o
// governo. Para elas, exigimos CONTEXTO forte (orgao ou nome completo da agencia),
// nunca a sigla solta no corpo do ato. (Evita atribuir o governo inteiro a ANA.)
const AMBIGUOUS_ACRONYMS = new Set(["ANA", "ANP", "ANM", "ANS"]);

// Casa o ato com uma agencia. Precedencia: (1) sigla/nome no ORGAO (artCategory/
// pubName — a fonte mais confiavel); (2) NOME COMPLETO em qualquer lugar; (3) sigla
// no corpo SO para siglas nao-ambiguas. `agencies` = [{id, acronym, name}].
function matchAgency(record, agencies) {
  const orgao = String(record.orgao || "").toUpperCase();
  const body = `${record.title || ""} ${record.extracted_text || ""}`.toUpperCase();
  const nameUp = (a) => (a.name ? a.name.toUpperCase() : "");
  // 1) Cabecalho do ato (orgao): sigla exata OU nome completo.
  const byOrgao = agencies.find((a) => new RegExp(`\\b${a.acronym}\\b`).test(orgao) || (a.name && orgao.includes(nameUp(a))));
  if (byOrgao) return byOrgao;
  // 2) Nome COMPLETO no corpo (ex.: "AGENCIA NACIONAL DE AGUAS E SANEAMENTO...").
  const byName = agencies.find((a) => a.name && body.includes(nameUp(a)));
  if (byName) return byName;
  // 3) Sigla no corpo — apenas siglas NAO-ambiguas.
  return agencies.find((a) => !AMBIGUOUS_ACRONYMS.has(a.acronym) && new RegExp(`\\b${a.acronym}\\b`).test(body)) || null;
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
  // "ANA" removida de proposito: e nome proprio comum (colidia e derrubava
  // "Ana ..."); a agencia "Agencia Nacional de Aguas" ja cai por AGENCIA/NACIONAL/AGUAS.
  "ANATEL","ANVISA","ANP","ANS","ANTT","ANTAQ","ANAC","ANCINE","ANM",
  "NOMEAR","DESIGNAR","EXONERAR","DISPENSAR","RECONDUZIR","RESOLVE","RESOLVEM","TORNAR",
  "EFEITO","PRORROGAR","NOMEACAO","PEDIDO","VAGO","SUBSTITUICAO","INTERINO",
  // --- Cabecalhos de tabela / formulario (causavam nomes-lixo) ---
  "MATRICULA","SIAPE","DENOMINACAO","ANEXO","CODIGO","VAGA","VAGAS","CLASSE","PADRAO","NIVEL",
  "SIGLA","LOTACAO","SETOR","UNIDADE","SERVIDOR","SERVIDORA","OCUPANTE","EFETIVO","EFETIVA",
  "QUADRO","REQUISITADO","CEDIDO","ONUS","GRATIFICADA","GRATIFICACAO","COMISSAO","ASSESSOR",
  "ASSESSORA","ASSISTENTE","TECNICO","ESPECIAL","EXECUTIVA","ADMINISTRATIVO","SUPERIOR","CHEFE",
  // --- Termos legais / de publicacao ---
  "MEDIDA","PROVISORIA","INCISO","PARAGRAFO","ALINEA","NUMERO","SECAO","PAGINA","EDICAO",
  "PUBLICADO","PUBLICACAO","VIGENCIA","EFEITOS","RETROATIVOS","CONFORME","VISTA","CONSIDERANDO",
  "PROCESSO","DESPACHO","ATO","ATOS","BOLETIM","REGIMENTO","INTERNO","REGULAMENTO",
  // --- Conectivos/preposicoes que nunca compoem nome ---
  "PARA","COM","POR","SEM","SOB","SOBRE","ENTRE","APOS","ATE","DESDE","DURANTE","CONTRA",
  // --- Outras entidades/orgaos comuns ---
  "INSTITUTO","FUNDACAO","AUTARQUIA","EMPRESA","PUBLICA","SOCIEDADE","BANCO","BRASIL",
  "BRASILEIRA","DESENVOLVIMENTO","PESQUISA","ENSINO","EDUCACAO","CULTURA","JUSTICA","FAZENDA",
  "ECONOMIA","TRABALHO","EMPREGO","PREVIDENCIA","INFRAESTRUTURA","COMUNICACOES","DEFESA",
  "RELACOES","EXTERIORES","MEIO","AMBIENTE","AGRICULTURA","PECUARIA","ABASTECIMENTO","TURISMO",
  "ESPORTE","MULHER","IGUALDADE","RACIAL","DIREITOS","HUMANOS","CIDADANIA","GESTAO","INOVACAO",
  "CIENCIA","TECNOLOGIA","PORTOS","CONTROLADORIA","ADVOCACIA"
]);

// Remove acentos para comparar com o conjunto INSTITUTIONAL (que e sem acento).
function bare(w) {
  return w.normalize("NFD").replace(/[̀-ͯ]/g, "");
}
function isInst(w) { return INSTITUTIONAL.has(bare(w)); }

// Toponimos (UFs + capitais) como CHAVES normalizadas (normalizeNameKey ordena
// tokens e descarta conectores). "Rio de Janeiro", "Sao Paulo", "Minas Gerais"
// etc. eram extraidos como se fossem pessoas — aqui viram bloqueio exato pelo
// NOME COMPLETO (nao por token solto, p/ nao derrubar nomes reais).
const TOPONIMOS = new Set([
  "Acre", "Alagoas", "Amapa", "Amazonas", "Bahia", "Ceara", "Espirito Santo",
  "Goias", "Maranhao", "Mato Grosso", "Mato Grosso do Sul", "Minas Gerais",
  "Para", "Paraiba", "Parana", "Pernambuco", "Piaui", "Rio de Janeiro",
  "Rio Grande do Norte", "Rio Grande do Sul", "Rondonia", "Roraima",
  "Santa Catarina", "Sao Paulo", "Sergipe", "Tocantins", "Distrito Federal",
  "Rio Branco", "Maceio", "Macapa", "Manaus", "Salvador", "Fortaleza",
  "Brasilia", "Vitoria", "Goiania", "Sao Luis", "Cuiaba", "Campo Grande",
  "Belo Horizonte", "Belem", "Joao Pessoa", "Curitiba", "Recife", "Teresina",
  "Natal", "Porto Velho", "Boa Vista", "Florianopolis", "Porto Alegre",
  "Aracaju", "Palmas"
].map(normalizeNameKey));

// Validador unico de "isto parece nome de pessoa?" — reusado pelos 3 caminhos de
// extracao E pela limpeza (scripts/clean-people.js). Rejeita: <2 ou >6 palavras
// reais, token institucional (case-insensitive), token gigante (OCR) e toponimo.
function isLikelyPersonName(display) {
  const words = String(display || "").trim().split(/\s+/).filter(Boolean);
  const real = words.filter((w) => w.length > 2);
  if (real.length < 2 || real.length > 6) return false;
  if (real.some((w) => w.length > 16)) return false;
  if (words.some((w) => INSTITUTIONAL.has(bare(w).toUpperCase()))) return false;
  if (TOPONIMOS.has(normalizeNameKey(display))) return false;
  return true;
}

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
    if (realWords.length < 2 || realWords.length > 6) continue;
    if (words.some((w) => isInst(w))) continue;
    // Rejeita tokens absurdamente longos (concatenacoes/ruido de OCR).
    if (realWords.some((w) => w.length > 16)) continue;
    const name = words.join(" ");
    const key = name.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // Title Case para exibicao (RICARDO LEME -> Ricardo Leme).
    const display = name.split(" ").map((w) =>
      /^D[AEO]S?$|^E$/.test(w) ? w.toLowerCase() : w.charAt(0) + w.slice(1).toLowerCase()
    ).join(" ");
    if (!isLikelyPersonName(display)) continue; // bloqueia toponimo/institucional
    people.push({ name: display, action, role });
    if (people.length >= 12) break;
  }

  // Extrair nomes apos "Sr./Sra."
  SR_RE.lastIndex = 0;
  let sm;
  while ((sm = SR_RE.exec(raw)) !== null && people.length < 12) {
    const display = sm[1].trim();
    if (!isLikelyPersonName(display)) continue; // SR_RE nao filtrava institucional/toponimo
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
    if (!isLikelyPersonName(display)) continue; // bloqueia toponimo/institucional
    const key = display.toUpperCase();
    if (!seen.has(key)) { seen.add(key); people.push({ name: display, action, role }); }
  }

  return people;
}

// Coleta os atos das agencias para uma data. agencies = [{id, acronym}].
// Aceita { cookie } para reusar uma sessao ja autenticada (evita rate-limit do
// INLABS, que bloqueia o IP apos ~20 logins seguidos).
async function collectDou(date, agencies, { sections = [1, 2, 3], cookie } = {}) {
  const debug = !!process.env.DOU_DEBUG;
  const sessionCookie = cookie || (await login());
  const out = [];
  let totalXml = 0;
  for (const section of sections) {
    const files = await downloadSection(sessionCookie, date, section);
    totalXml += files.length;
    for (const file of files) {
      const record = parseArticle(file.getData().toString("utf8"), date, section);
      const agency = matchAgency(record, agencies);
      if (agency) out.push({ ...record, agency_id: agency.id, agency_acronym: agency.acronym });
    }
  }
  if (debug) console.log(`    [DEBUG ${date}] ${totalXml} XMLs baixados · ${out.length} casaram com agências`);
  return out;
}

module.exports = { collectDou, login, parseArticle, matchAgency, extractPeopleFromAto, isLikelyPersonName, AuthError };
