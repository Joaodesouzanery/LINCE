// Remove o bucket 'financeiro-nf' (modulo Financeiro M30, migrado para outro sistema).
//
// Por que um script e nao uma linha no SQL: storage.objects tem o trigger
// storage.protect_delete(), que recusa DELETE direto com 42501 e manda usar a
// Storage API. E como o SQL Editor roda tudo numa transacao, aquela linha
// abortava e revertia os drops de tabela junto.
//
// Uso: node scripts/drop-bucket-financeiro.js [--dry-run]
require("dotenv").config();
const { getSupabase } = require("../lib/supabase");

const dryRun = process.argv.includes("--dry-run");
const BUCKET = "financeiro-nf";

async function main() {
  const supabase = getSupabase();

  const { data: buckets, error: listErr } = await supabase.storage.listBuckets();
  if (listErr) {
    console.error(`ERRO ao listar buckets: ${listErr.message}`);
    process.exit(1);
  }
  if (!buckets.some((b) => b.id === BUCKET)) {
    console.log(`Bucket '${BUCKET}' nao existe — nada a fazer.`);
    return;
  }

  // Recusa apagar bucket com conteudo: o modulo foi migrado, mas se houver nota
  // fiscal aqui e porque alguem subiu algo depois do backup.
  const { data: objetos, error: objErr } = await supabase.storage.from(BUCKET).list("", { limit: 100 });
  if (objErr) {
    console.error(`ERRO ao listar objetos: ${objErr.message}`);
    process.exit(1);
  }
  if (objetos.length) {
    console.error(`ABORTADO: o bucket tem ${objetos.length} objeto(s). Esperado: vazio.`);
    for (const o of objetos.slice(0, 10)) console.error(`  - ${o.name}`);
    process.exit(1);
  }
  console.log(`Bucket '${BUCKET}' encontrado e vazio (0 objetos).`);

  if (dryRun) {
    console.log("(dry-run: nenhuma remocao realizada)");
    return;
  }

  const { error: delErr } = await supabase.storage.deleteBucket(BUCKET);
  if (delErr) {
    console.error(`ERRO ao remover o bucket: ${delErr.message}`);
    process.exit(1);
  }
  console.log(`Bucket '${BUCKET}' removido.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
