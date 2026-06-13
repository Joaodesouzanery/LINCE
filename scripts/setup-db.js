// Aplica o schema e popula as agencias reguladoras no Supabase.
// Uso: SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/setup-db.js
// Obs: a aplicacao do schema.sql exige acesso ao banco; se a service key nao
// permitir DDL via RPC, rode supabase/schema.sql manualmente no SQL Editor e
// este script apenas popula o seed das agencias.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { getSupabase } = require("../lib/supabase");

async function main() {
  const supabase = getSupabase();
  const seed = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "data", "agencies.seed.json"), "utf8")
  );

  const { error } = await supabase
    .from("agencies")
    .upsert(seed, { onConflict: "acronym" });

  if (error) {
    console.error("Erro ao popular agencias:", error.message);
    console.error("Confirme que o schema (supabase/schema.sql) ja foi aplicado.");
    process.exit(1);
  }
  console.log(`OK: ${seed.length} agencias inseridas/atualizadas.`);
}

main();
