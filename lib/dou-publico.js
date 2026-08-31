// Coletor do DOU pela fonte PUBLICA do in.gov.br — sem login, sem credencial.
//
// POR QUE ESTA FONTE E PRIMARIA (medido em 30/08/2026, mesmo dia, mesmo matchAgency):
//   cobertura 10/08 ........ INLABS 114 atos  x  publica 225  (+97%)
//   agencias zeradas ....... INLABS 4 (ANA, ANCINE, ANS, ANTAQ)  x  publica 0
//   disponibilidade ........ INLABS 302/502 intermitente  x  publica estavel
//   credencial ............. INLABS e-mail+senha (expira, IP pode ser bloqueado)  x  nenhuma
//   source_url ............. INLABS id numerico -> 404  x  publica slug -> 200
//   titulos ................ INLABS gera lixo no fallback  x  publica limpos
//   edicoes extras ......... INLABS nao  x  publica do1e/do2e/do3e
// Nao ha coluna em que o INLABS ganhe. Ele era primario por acidente historico.
//
// CUSTO: 13,6s fim-a-fim para um dia completo (3 indices + ~209 textos integrais com
// concorrencia 6). Cabe nos 60s da Vercel com folga.
//
// ARMADILHA CENTRAL: o `content` do indice vem TRUNCADO em ~403 chars (92% dos atos
// batem exatamente nesse limite). E preview, nao texto. Quem usar so o indice perde a
// maior parte da informacao EM SILENCIO — o numero do processo minerario, por exemplo,
// aparece em 22% dos previews contra 100% do texto integral. Por isso o fetch por ato.
const crypto = require("crypto");
const { matchAgency } = require("./dou");

const BASE = "https://www.in.gov.br";

// O fetch do Node passa sem header nenhum (medido), mas o host filtra por fingerprint
// de cliente — o urllib do Python leva 403. Mandar cabecalhos de navegador custa zero e
// blinda contra o dia em que a politica apertar.
const CABECALHOS = {
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "pt-BR,pt;q=0.9,en;q=0.8"
};

// DO1/DO2/DO3 + as edicoes EXTRA. As extras sao onde caem nomeacoes urgentes; ignora-las
// perde exatamente o ato que mais interessa a um monitor de pessoal.
const SECOES = {
  1: ["do1", "do1e"],
  2: ["do2", "do2e"],
  3: ["do3", "do3e"]
};

function hash(valor) {
  return crypto.createHash("sha256").update(valor).digest("hex");
}

// YYYY-MM-DD -> DD-MM-YYYY (o formato que o leiturajornal aceita).
function paraFormatoBR(iso) {
  const [a, m, d] = String(iso).split("-");
  return `${d}-${m}-${a}`;
}

function desescapaHtml(s) {
  return String(s)
    .replace(/&quot;/g, '"').replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&"); // por ultimo: senao desfaz os anteriores
}

function limpaTexto(html) {
  return desescapaHtml(String(html).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

async function buscar(url, timeoutMs = 15000) {
  const res = await fetch(url, { headers: CABECALHOS, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
  return res.text();
}

// ── Indice de uma secao/dia ────────────────────────────────────────────────
// O in.gov.br embute o dia inteiro num <script id="params"> como JSON.
async function indiceSecao(iso, secao) {
  const url = `${BASE}/leiturajornal?data=${paraFormatoBR(iso)}&secao=${secao}`;
  let html;
  try {
    html = await buscar(url);
  } catch (e) {
    return { ok: false, atos: [], erro: `${secao}: ${e.message}` };
  }
  const m = html.match(/<script[^>]*id=["']params["'][^>]*>([\s\S]*?)<\/script>/);
  if (!m) {
    // Contrato implicito quebrado. Falha RUIDOSA: se o portal mudar o markup, isso
    // nao pode virar "0 atos" silencioso.
    return { ok: false, atos: [], erro: `${secao}: bloco <script id="params"> ausente (markup mudou?)` };
  }
  try {
    const dados = JSON.parse(desescapaHtml(m[1].trim()));
    return { ok: true, atos: dados.jsonArray || [], erro: null };
  } catch (e) {
    return { ok: false, atos: [], erro: `${secao}: JSON invalido (${e.message})` };
  }
}

// ── Texto integral de um ato ───────────────────────────────────────────────
async function textoIntegral(urlTitle) {
  const html = await buscar(`${BASE}/web/dou/-/${urlTitle}`, 12000);
  const m = html.match(/class="[^"]*texto-dou[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/);
  return m ? limpaTexto(m[1]) : "";
}

// Pool de concorrencia fixa. Sem isso, 235 fetches simultaneos derrubam o host (e a
// gente com ele).
async function emLotes(itens, n, fn) {
  const saida = new Array(itens.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, itens.length) }, async () => {
    for (;;) {
      const k = i++;
      if (k >= itens.length) return;
      saida[k] = await fn(itens[k], k);
    }
  }));
  return saida;
}

/**
 * Coleta os atos de agencia reguladora de um dia. Mesma forma de saida de collectDou(),
 * entao persistDou() consome os dois sem alteracao.
 *
 * @returns array de records + props { totalXml, discarded, totalPublicados, semEdicao, parcial, erros }
 */
async function collectDouPublico(iso, agencies, opcoes = {}) {
  const { sections = [1, 2, 3], concorrencia = 6, comTextoIntegral = true } = opcoes;
  const debug = !!process.env.DOU_DEBUG;
  const erros = [];

  const nomes = sections.flatMap((s) => (SECOES[s] || []).map((nome) => ({ secao: s, nome })));
  const indices = await Promise.all(nomes.map(async ({ secao, nome }) => {
    const r = await indiceSecao(iso, nome);
    if (!r.ok) erros.push(r.erro);
    return { secao, nome, atos: r.atos };
  }));

  // totalPublicados = TODOS os atos do dia, antes de qualquer filtro. E o denominador
  // que desambigua "sem edicao" de "ingestao quebrada" — sem ele, 0 atos de agencia num
  // domingo e 0 atos por matcher quebrado sao indistinguiveis. Esse foi o erro que
  // custou 20 dias de silencio aqui.
  const totalPublicados = indices.reduce((s, i) => s + i.atos.length, 0);

  const candidatos = [];
  for (const { secao, atos } of indices) {
    for (const it of atos) {
      const orgao = Array.isArray(it.hierarchyList) ? it.hierarchyList.join("/") : (it.hierarchyStr || "");
      const titulo = it.title || it.titulo || "Ato sem titulo";
      // hierarchyStr tem o MESMO formato do artCategory do INLABS, entao matchAgency
      // funciona sem uma linha alterada (verificado contra a funcao real).
      const prova = { title: titulo, orgao, extracted_text: it.content || "", section: secao };
      const agency = matchAgency(prova, agencies);
      if (agency) candidatos.push({ it, secao, titulo, orgao, agency });
    }
  }

  const textos = comTextoIntegral
    ? await emLotes(candidatos, concorrencia, async (c) => {
        try {
          return await textoIntegral(c.it.urlTitle);
        } catch {
          return null; // cai para o preview; o ato entra marcado como parcial
        }
      })
    : candidatos.map(() => null);

  let parcial = 0;
  const out = candidatos.map((c, k) => {
    const integral = textos[k];
    if (comTextoIntegral && !integral) parcial++;
    const texto = integral || c.it.content || "";
    return {
      external_id: c.it.urlTitle,
      section: c.secao,
      title: c.titulo,
      orgao: c.orgao,
      published_at: iso,
      extracted_text: texto,
      // O slug FUNCIONA. O id numerico do INLABS devolve 404 — e esse e o motivo de os
      // ~34 mil links "abrir no DOU" da plataforma estarem mortos hoje.
      source_url: `${BASE}/web/dou/-/${c.it.urlTitle}`,
      // Hash NAO depende do texto: um ato salvo so com preview pode ser atualizado
      // depois para o integral sem gerar duplicata.
      content_hash: hash(`${c.it.urlTitle}|${c.titulo}|${iso}`),
      extraction_status: (comTextoIntegral && integral) ? "raw" : "preview",
      agency_id: c.agency.id,
      agency_acronym: c.agency.acronym,
      fonte: "in.gov.br"
    };
  });

  out.totalXml = totalPublicados;
  out.discarded = Math.max(0, totalPublicados - out.length);
  out.totalPublicados = totalPublicados;
  // Sem edicao e um FATO (domingo, feriado, data futura), nao uma falha.
  out.semEdicao = totalPublicados === 0 && erros.length === 0;
  // Publicou VOLUME NORMAL e nada casou: o matcher quebrou. Falha ruidosa.
  //
  // O piso de 100 nao e arbitrario: em feriado o DOU sai com edicao minima e e
  // perfeitamente normal nenhum ato ser de agencia reguladora. Medido em 03/04/2026
  // (Sexta-feira Santa): 5 atos publicados, 0 de agencia. Sem o piso, todo feriado
  // viraria alarme falso — e alarme que grita a toa e alarme que as pessoas desligam,
  // que e como se chega a meses de ingestao quebrada sem ninguem olhar.
  // Dia util normal publica 3.000-3.700 atos, entao o piso nao mascara falha real.
  const VOLUME_MINIMO_PARA_SUSPEITAR = 100;
  out.matcherSuspeito = totalPublicados >= VOLUME_MINIMO_PARA_SUSPEITAR && out.length === 0;
  // Edicao minima (feriado): publicou pouco e nada casou. Nao e falha nem "sem edicao".
  out.edicaoMinima = totalPublicados > 0 && totalPublicados < VOLUME_MINIMO_PARA_SUSPEITAR && out.length === 0;
  out.parcial = parcial;
  out.erros = erros;

  if (debug) {
    console.log(`    [DEBUG ${iso}] publicados=${totalPublicados} · agencias=${out.length} · so-preview=${parcial}${erros.length ? ` · erros=${erros.length}` : ""}`);
  }
  return out;
}

module.exports = { collectDouPublico, indiceSecao, textoIntegral, CABECALHOS };
