// Carrega o quadro societario da Receita Federal (dump mensal dados.gov.br).
// Faz o cruzamento socio↔diretor para detectar "porta giratoria".
//
// Como baixar o dump:
//   1. Acesse: https://dados.gov.br/dados/conjuntos-dados/cadastro-nacional-da-pessoa-juridica---cnpj
//   2. Baixe os arquivos SOCIO (ex: K3241.K03200Y04.D50308.SOCIOCSV.zip ou similar)
//   3. Descompacte — o arquivo e um CSV sem cabecalho, delimitado por ";"
//
// Uso: node scripts/load-receita-socio.js /path/to/SOCIO.csv [--dry-run]
//
// Filtro automatico: so carrega socios cujo nome aparecer na tabela `people` do Supabase
// (ou que tenham CPF/CNPJ registrado). Isso evita carregar os ~20M de socios do Brasil inteiro.
//
// Colunas do CSV Receita SOCIO (layout 2024):
// 0: cnpj_basico, 1: identificador_socio (1=PF,2=PJ,3=Estrangeiro),
// 2: nome_socio, 3: cpf_cnpj_socio, 4: qualificacao_socio,
// 5: data_entrada_sociedade, 6: pais, 7: cpf_representante_legal,
// 8: nome_representante_legal, 9: qualificacao_representante_legal, 10: faixa_etaria
require("dotenv").config();
const fs = require("fs");
const readline = require("readline");
const { getSupabase } = require("../lib/supabase");

const QUALIF_SOCIO = {
  "05": "Administrador",
  "08": "Conselheiro",
  "10": "Diretor",
  "16": "Presidente",
  "21": "Socio",
  "22": "Socio Administrador",
  "49": "Socio-Gerente",
  "65": "Titular",
};

function normalize(name) {
  return (name || "").toUpperCase().replace(/[^A-Z\s]/g, "").replace(/\s+/g, " ").trim();
}

async function main() {
  const csvPath = process.argv[2];
  const dryRun = process.argv.includes("--dry-run");
  if (!csvPath) {
    console.error("Uso: node scripts/load-receita-socio.js /path/to/SOCIO.csv [--dry-run]");
    process.exit(1);
  }
  if (!fs.existsSync(csvPath)) {
    console.error(`Arquivo nao encontrado: ${csvPath}`);
    process.exit(1);
  }

  const supabase = getSupabase();

  // Carrega nomes normalizados dos diretores ja no banco
  const { data: people } = await supabase.from("people").select("id, name, normalized_name");
  const nameIndex = new Map();
  for (const p of people || []) {
    const key = normalize(p.normalized_name || p.name);
    if (key) nameIndex.set(key, p.id);
  }
  console.log(`Diretores no banco: ${nameIndex.size}`);

  // Carrega CNPJs das agencias (basico = 8 digitos) para filtrar empresas reguladas
  const { data: agencies } = await supabase.from("agencies").select("id, acronym, collection_rules");
  const agencyCnpjs = new Set(
    (agencies || []).map((a) => (a.collection_rules?.cnpj || "").replace(/\D/g, "").slice(0, 8)).filter(Boolean)
  );

  // Carrega empresas ja no banco por CNPJ
  const { data: companies } = await supabase.from("companies").select("id, cnpj");
  const companyIndex = new Map();
  for (const c of companies || []) {
    if (c.cnpj) companyIndex.set(c.cnpj.replace(/\D/g, ""), c.id);
  }

  const rl = readline.createInterface({ input: fs.createReadStream(csvPath, "latin1"), crlfDelay: Infinity });
  let lineNum = 0, matched = 0, inserted = 0, skipped = 0;

  for await (const line of rl) {
    lineNum++;
    if (lineNum % 500000 === 0) console.log(`  Lidas ${lineNum} linhas, ${matched} correspondencias...`);

    const cols = line.split(";").map((c) => c.replace(/^"|"$/g, "").trim());
    if (cols.length < 4) continue;

    const cnpjBasico = cols[0].padStart(8, "0");
    const idSocio = cols[1];
    if (idSocio !== "1") continue; // so PF (pessoa fisica)

    const nomeSocio = normalize(cols[2]);
    const cpfSocio = (cols[3] || "").replace(/\D/g, "");
    const qualCod = cols[4] || "";
    const role = QUALIF_SOCIO[qualCod] || "Socio";
    const dataEntrada = cols[5] || null;

    // Verifica se nome bate com algum diretor
    const personId = nameIndex.get(nomeSocio);
    if (!personId) continue;
    matched++;

    const cnpjCompleto = cnpjBasico; // basico apenas; complemento nao esta no arquivo SOCIO
    let companyId = companyIndex.get(cnpjBasico);

    if (dryRun) {
      console.log(`  MATCH: ${cols[2]} | CNPJ basico: ${cnpjBasico} | ${role} | entrada: ${dataEntrada}`);
      continue;
    }

    // Upsert empresa se necessario
    if (!companyId) {
      const { data: comp } = await supabase
        .from("companies")
        .upsert({ cnpj: cnpjBasico, legal_name: `CNPJ ${cnpjBasico}` }, { onConflict: "cnpj" })
        .select("id").single();
      if (comp?.id) { companyId = comp.id; companyIndex.set(cnpjBasico, comp.id); }
    }
    if (!companyId) continue;

    // Grava relacionamento socio (company→person)
    const { data: exists } = await supabase
      .from("relationships")
      .select("id")
      .eq("from_kind", "person")
      .eq("from_id", personId)
      .eq("to_kind", "company")
      .eq("to_id", companyId)
      .eq("relationship", "socio")
      .maybeSingle();

    if (exists) { skipped++; continue; }

    await supabase.from("relationships").insert({
      from_kind: "person", from_id: personId,
      to_kind: "company", to_id: companyId,
      relationship: "socio",
      confidence_score: 1,
      metadata: { role, data_entrada: dataEntrada, cnpj_basico: cnpjBasico, source: "receita_cnpj" }
    });
    inserted++;
    console.log(`  + ${cols[2]} como ${role} em CNPJ ${cnpjBasico}`);
  }

  console.log(`\n=== Receita SOCIO concluido ===`);
  console.log(`Linhas lidas   : ${lineNum}`);
  console.log(`Correspondencias: ${matched}`);
  console.log(`Inseridos      : ${inserted}`);
  console.log(`Ja existiam    : ${skipped}`);
  if (dryRun) console.log(`\n(dry-run: nenhuma gravacao realizada)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
