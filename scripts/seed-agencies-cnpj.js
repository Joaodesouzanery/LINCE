// Popula rss/consultas_url + CNPJ das 11 agencias reguladoras federais.
// Fonte de verdade do CNPJ = data/agencies.seed.json (usado por db:setup).
// Os 11 CNPJs estao CONFIRMADOS (digito verificador valido + nome conferido via
// cnpj.ws / Portal da Transparencia). Os 6 que estavam errados (ANEEL, ANP, ANA,
// ANTAQ, ANAC, ANM) foram corrigidos p/ a matriz correta (jul/2026).
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
  { acronym: "ANEEL",  cnpj: "02270669000129", rss: "https://www.gov.br/aneel/pt-br/assuntos/noticias/RSS",  consultas_url: "https://www.gov.br/aneel/pt-br/assuntos/consultas-publicas" },
  { acronym: "ANATEL", cnpj: "02030715000112", rss: "https://www.gov.br/anatel/pt-br/assuntos/noticias/RSS", consultas_url: "https://www.gov.br/anatel/pt-br/regulado/radiofrequencia/consulta-publica" },
  { acronym: "ANP",    cnpj: "02313673000127", rss: "https://www.gov.br/anp/pt-br/assuntos/noticias/RSS",    consultas_url: "https://www.gov.br/anp/pt-br/assuntos/consultas-e-audiencias-publicas" },
  { acronym: "ANVISA", cnpj: "03112386000111", rss: "https://www.gov.br/anvisa/pt-br/assuntos/noticias-anvisa/RSS", consultas_url: "https://www.gov.br/anvisa/pt-br/assuntos/consultas-publicas" },
  { acronym: "ANS",    cnpj: "03589068000146", rss: "https://www.gov.br/ans/pt-br/assuntos/noticias/RSS",    consultas_url: "https://www.gov.br/ans/pt-br/assuntos/consultas-publicas-e-audiencias" },
  { acronym: "ANA",    cnpj: "04204444000108", rss: "https://www.gov.br/ana/pt-br/assuntos/noticias-e-eventos/noticias/RSS", consultas_url: "https://www.gov.br/ana/pt-br/acesso-a-informacao/consultas-publicas" },
  { acronym: "ANTT",   cnpj: "04898488000177", rss: "https://www.gov.br/antt/pt-br/assuntos/noticias/RSS",   consultas_url: "https://www.gov.br/antt/pt-br/assuntos/consultas-e-audiencias-publicas" },
  { acronym: "ANTAQ",  cnpj: "04903587000108", rss: "https://www.gov.br/antaq/pt-br/noticias/RSS",           consultas_url: "https://www.gov.br/antaq/pt-br/assuntos/consultas-publicas" },
  { acronym: "ANAC",   cnpj: "07947821000189", rss: "https://www.gov.br/anac/pt-br/noticias/RSS",            consultas_url: "https://www.gov.br/anac/pt-br/assuntos/consultas-e-audiencias-publicas" },
  { acronym: "ANCINE", cnpj: "04884574000120", rss: "https://www.gov.br/ancine/pt-br/noticias/RSS",          consultas_url: "https://www.gov.br/ancine/pt-br/assuntos/consultas-publicas" },
  { acronym: "ANM",    cnpj: "29406625000130", rss: "https://www.gov.br/anm/pt-br/assuntos/noticias/RSS",    consultas_url: "https://www.gov.br/anm/pt-br/acesso-a-informacao/consultas-publicas" },
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
