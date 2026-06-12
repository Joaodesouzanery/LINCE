// Cliente Supabase compartilhado (service role - uso server-side apenas).
// Requer env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY
const { createClient } = require("@supabase/supabase-js");

let cached = null;

function getSupabase() {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL e SUPABASE_SERVICE_KEY precisam estar configuradas.");
  }
  cached = createClient(url, key, { auth: { persistSession: false } });
  return cached;
}

module.exports = { getSupabase };
