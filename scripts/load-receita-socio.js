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
const { normalizeNameKey } = require("../lib/text");

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

// Chave de nome UNICA em toda a plataforma (lib/text.normalizeNameKey): translitera
// acento (JOAO, nao JOO), ordena tokens e remove conectivos ("SILVA, RICARDO" ==
// "RICARDO SILVA"). O normalize local antigo apagava letras acentuadas e era
// sensivel a ordem -> quase nenhum socio casava com diretor. Este destrava o cruzamento.
const nameKey = (name) => normalizeNameKey(name);

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

  // Carrega TODOS os diretores ja no banco (paginado — select cru trunca em 1000).
  const nameIndex = new Map();
  let peopleCount = 0;
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data: people, error } = await supabase
      .from("people").select("id, full_name, normalized_name")
      .order("id", { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new Error(`people: ${error.message}`);
    for (const p of people || []) {
      const key = nameKey(p.normalized_name || p.full_name);
      if (key) nameIndex.set(key, p.id);
      peopleCount++;
    }
    if (!people || people.length < PAGE) break;
  }
  console.log(`Diretores no banco: ${peopleCount} (chaves unicas: ${nameIndex.size})`);

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
    const nomeSocio = nameKey(cols[2]);
    const docSocio = (cols[3] || "").replace(/\D/g, "");
    const qualCod = cols[4] || "";
    const role = QUALIF_SOCIO[qualCod] || "Socio";
    const dataEntrada = cols[5] || null;

    // Garante o no da empresa-alvo (upsert por CNPJ basico). Retorna id ou null.
    async function ensureTargetCompany() {
      let companyId = companyIndex.get(cnpjBasico);
      if (companyId) return companyId;
      const { data: comp } = await supabase
        .from("companies")
        .upsert({ cnpj: cnpjBasico, legal_name: `CNPJ ${cnpjBasico}` }, { onConflict: "cnpj" })
        .select("id").single();
      if (comp?.id) { companyId = comp.id; companyIndex.set(cnpjBasico, comp.id); }
      return companyId || null;
    }

    // Grava aresta 'socio' com dedupe (from -> company-alvo).
    async function ensureEdge(fromKind, fromId, companyId, meta) {
      const { data: exists } = await supabase
        .from("relationships").select("id")
        .eq("from_kind", fromKind).eq("from_id", fromId)
        .eq("to_kind", "company").eq("to_id", companyId)
        .eq("relationship", "socio").maybeSingle();
      if (exists) { skipped++; return false; }
      await supabase.from("relationships").insert({
        from_kind: fromKind, from_id: fromId, to_kind: "company", to_id: companyId,
        relationship: "socio", confidence_score: 1,
        metadata: { ...meta, cnpj_basico: cnpjBasico, source: "receita_cnpj" }
      });
      inserted++;
      return true;
    }

    if (idSocio === "1") {
      // Socio PF: casa por nome com diretor ja no banco (mantem o escopo enxuto).
      const personId = nameIndex.get(nomeSocio);
      if (!personId) continue;
      matched++;
      if (dryRun) { console.log(`  MATCH PF: ${cols[2]} | CNPJ ${cnpjBasico} | ${role}`); continue; }
      const companyId = await ensureTargetCompany();
      if (!companyId) continue;
      if (await ensureEdge("person", personId, companyId, { role, data_entrada: dataEntrada }))
        console.log(`  + PF ${cols[2]} como ${role} em CNPJ ${cnpjBasico}`);
    } else if (idSocio === "2") {
      // Socio PJ: so materializa a rede empresa->empresa quando a empresa-alvo ja
      // e rastreada (evita puxar o Brasil inteiro). Doc do socio = CNPJ (14 digitos).
      if (!companyIndex.has(cnpjBasico)) continue;
      if (docSocio.length !== 14) continue;
      matched++;
      if (dryRun) { console.log(`  MATCH PJ: CNPJ socio ${docSocio} -> alvo ${cnpjBasico}`); continue; }
      const targetId = companyIndex.get(cnpjBasico);
      let socioCompanyId = companyIndex.get(docSocio);
      if (!socioCompanyId) {
        const { data: sc } = await supabase
          .from("companies")
          .upsert({ cnpj: docSocio, legal_name: cols[2] || `CNPJ ${docSocio}` }, { onConflict: "cnpj" })
          .select("id").single();
        if (sc?.id) { socioCompanyId = sc.id; companyIndex.set(docSocio, sc.id); }
      }
      if (!socioCompanyId || socioCompanyId === targetId) continue;
      if (await ensureEdge("company", socioCompanyId, targetId, { role, data_entrada: dataEntrada }))
        console.log(`  + PJ ${cols[2]} (${docSocio}) socia de CNPJ ${cnpjBasico}`);
    } else {
      continue; // idSocio 3 (estrangeiro) e outros: fora de escopo por ora
    }
  }

  console.log(`\n=== Receita SOCIO concluido ===`);
  console.log(`Linhas lidas   : ${lineNum}`);
  console.log(`Correspondencias: ${matched}`);
  console.log(`Inseridos      : ${inserted}`);
  console.log(`Ja existiam    : ${skipped}`);
  if (dryRun) console.log(`\n(dry-run: nenhuma gravacao realizada)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
