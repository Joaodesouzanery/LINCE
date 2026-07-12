// Popula rss/consultas_url + CNPJ das 11 agencias reguladoras federais.
// Fonte de verdade do CNPJ = data/agencies.seed.json (usado por db:setup).
// ATENCAO: 5 CNPJs foram CONFIRMADOS via cnpj.ws (ANATEL, ANVISA, ANS, ANTT,
// ANCINE). Os outros 6 (ANEEL, ANP, ANA, ANTAQ, ANAC, ANM) estao com CNPJ
// INVALIDO (digito verificador nao bate) nos dois arquivos — a base esta errada
// e precisam ser corrigidos de fonte oficial. Ate la, ingest-pncp os PULA
// (isValidCnpj), entrando em agencies_without_cnpj (visivel, nao silencioso).
// Uso: node scripts/seed-agencies-cnpj.js
//
// NOTA (jul/2026): as URLs de RSS do gov.br abaixo estao majoritariamente
// quebradas (404 ou 200 sem itens) — o portal mudou a estrutura de sindicacao.
// api/rss-feeds.js ja tem fallback: quando o RSS nao retorna nada, ele busca
// consultas/pautas nos atos do DOU ja ingeridos. Portanto as abas Consultas/
// Agenda/radar setorial funcionam mesmo com estes RSS vazios. Atualize as URLs
// aqui caso encontre feeds vivos (testar: deve responder XML com <item>/<entry>).
require("dotenv").config();
const { getSupabase } = require("../lib/supabase");

const CNPJS = [
  { acronym: "ANEEL",  cnpj: "02016243000104", rss: "https://www.gov.br/aneel/pt-br/assuntos/noticias/RSS",  consultas_url: "https://www.gov.br/aneel/pt-br/assuntos/consultas-publicas" },
  { acronym: "ANATEL", cnpj: "02030715000112", rss: "https://www.gov.br/anatel/pt-br/assuntos/noticias/RSS", consultas_url: "https://www.gov.br/anatel/pt-br/regulado/radiofrequencia/consulta-publica" },
  { acronym: "ANP",    cnpj: "04523628000170", rss: "https://www.gov.br/anp/pt-br/assuntos/noticias/RSS",    consultas_url: "https://www.gov.br/anp/pt-br/assuntos/consultas-e-audiencias-publicas" },
  { acronym: "ANVISA", cnpj: "03112386000111", rss: "https://www.gov.br/anvisa/pt-br/assuntos/noticias-anvisa/RSS", consultas_url: "https://www.gov.br/anvisa/pt-br/assuntos/consultas-publicas" },
  { acronym: "ANS",    cnpj: "03589068000146", rss: "https://www.gov.br/ans/pt-br/assuntos/noticias/RSS",    consultas_url: "https://www.gov.br/ans/pt-br/assuntos/consultas-publicas-e-audiencias" },
  { acronym: "ANA",    cnpj: "04158952000154", rss: "https://www.gov.br/ana/pt-br/assuntos/noticias-e-eventos/noticias/RSS", consultas_url: "https://www.gov.br/ana/pt-br/acesso-a-informacao/consultas-publicas" },
  { acronym: "ANTT",   cnpj: "04898488000177", rss: "https://www.gov.br/antt/pt-br/assuntos/noticias/RSS",   consultas_url: "https://www.gov.br/antt/pt-br/assuntos/consultas-e-audiencias-publicas" },
  { acronym: "ANTAQ",  cnpj: "04817224000175", rss: "https://www.gov.br/antaq/pt-br/noticias/RSS",           consultas_url: "https://www.gov.br/antaq/pt-br/assuntos/consultas-publicas" },
  { acronym: "ANAC",   cnpj: "08827999000119", rss: "https://www.gov.br/anac/pt-br/noticias/RSS",            consultas_url: "https://www.gov.br/anac/pt-br/assuntos/consultas-e-audiencias-publicas" },
  { acronym: "ANCINE", cnpj: "04884574000120", rss: "https://www.gov.br/ancine/pt-br/noticias/RSS",          consultas_url: "https://www.gov.br/ancine/pt-br/assuntos/consultas-publicas" },
  { acronym: "ANM",    cnpj: "28884395000190", rss: "https://www.gov.br/anm/pt-br/assuntos/noticias/RSS",    consultas_url: "https://www.gov.br/anm/pt-br/acesso-a-informacao/consultas-publicas" },
];

async function main() {
  const supabase = getSupabase();
  let ok = 0;
  for (const ag of CNPJS) {
    const { error } = await supabase
      .from("agencies")
      .update({
        collection_rules: { cnpj: ag.cnpj, rss: ag.rss, consultas_url: ag.consultas_url }
      })
      .eq("acronym", ag.acronym);
    if (error) { console.error(`ERRO ${ag.acronym}: ${error.message}`); continue; }
    console.log(`OK: ${ag.acronym} -> CNPJ ${ag.cnpj}`);
    ok++;
  }
  console.log(`\n${ok}/${CNPJS.length} agencias atualizadas.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
