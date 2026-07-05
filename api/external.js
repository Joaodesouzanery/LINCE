// DataJud + Portal da Transparencia unificados.
// GET /api/external?type=datajud&q=nome&tribunal=tjsp
// GET /api/external?type=transparency&cnpj=00000000000000
// GET /api/external?type=screening&q=nome | &cpf=11dig | &cnpj=14dig
// GET /api/external?type=cpf&cpf=11dig  (screening + match na base local people)
const { screeningByName, screeningByCpf, screeningByCnpj } = require("../lib/transparencia");

function onlyDigits(v) { return String(v||"").replace(/\D/g,""); }
// Nunca ecoar CPF completo na resposta (LGPD).
function maskCpf(d) { return `***.${d.slice(3,6)}.${d.slice(6,9)}-**`; }

module.exports = async function handler(req, res) {
  const type = String(req.query.type || "datajud");

  if (type === "datajud") {
    const apiKey = process.env.DATAJUD_API_KEY;
    if (!apiKey) return res.status(501).json({ ok:false, status:"requires_key", error:"DATAJUD_API_KEY nao configurada." });
    const q = String(req.query.q||"").trim();
    const tribunal = String(req.query.tribunal||"tjsp").toLowerCase();
    if (!q) return res.status(400).json({ ok:false, error:"Informe termo de busca." });
    try {
      const size = 50;
      const response = await fetch(`https://api-publica.datajud.cnj.jus.br/api_publica_${tribunal}/_search`, {
        method:"POST",
        headers: { "Content-Type":"application/json", Authorization:`APIKey ${apiKey}` },
        body: JSON.stringify({ size, query:{ match:{ "partes.nome": q } } })
      });
      const data = await response.json().catch(()=>null);
      if (!response.ok) return res.status(response.status).json({ ok:false, error:"DataJud falhou.", data });
      const hits = data?.hits?.hits||[];
      const total = data?.hits?.total?.value ?? hits.length;
      return res.status(200).json({ ok:true, source:"CNJ DataJud", total, truncated: total > hits.length,
        items: hits.map(h=>({ title:h._source?.numeroProcesso||h._id, description:h._source?.classe?.nome||"Processo DataJud", raw:h._source }))
      });
    } catch(error) { return res.status(502).json({ ok:false, error:error.message }); }
  }

  if (type === "transparency") {
    const apiKey = process.env.PORTAL_TRANSPARENCIA_API_KEY;
    if (!apiKey) return res.status(501).json({ ok:false, status:"requires_key", error:"PORTAL_TRANSPARENCIA_API_KEY nao configurada." });
    const cnpj = onlyDigits(req.query.cnpj);
    if (cnpj.length !== 14) return res.status(400).json({ ok:false, error:"CNPJ invalido." });
    try {
      const response = await fetch(`https://api.portaldatransparencia.gov.br/api-de-dados/contratos?cnpjFornecedor=${cnpj}&pagina=1`, {
        headers: { accept:"application/json", "chave-api-dados":apiKey }
      });
      const data = await response.json().catch(()=>null);
      if (!response.ok) return res.status(response.status).json({ ok:false, error:"Portal Transparencia falhou.", data });
      const rows = Array.isArray(data) ? data : [];
      const shown = rows.slice(0, 50);
      return res.status(200).json({ ok:true, source:"Portal da Transparencia", total: rows.length, truncated: rows.length > shown.length,
        items: shown.map(e=>({ title:e.objeto||e.numero||"Contrato publico", description:e.orgaoSuperior?.nome||"", raw:e }))
      });
    } catch(error) { return res.status(502).json({ ok:false, error:error.message }); }
  }

  // Screening PEP/sancoes (CEIS/CNEP/CEPIM/CEAF/PEP/servidores) por nome, CPF ou CNPJ.
  if (type === "screening") {
    const cpf = onlyDigits(req.query.cpf);
    const cnpj = onlyDigits(req.query.cnpj);
    const nome = String(req.query.q || req.query.nome || "").trim();
    let result, query;
    try {
      if (cpf.length === 11) { result = await screeningByCpf(cpf); query = { kind: "cpf", value_masked: maskCpf(cpf) }; }
      else if (cnpj.length === 14) { result = await screeningByCnpj(cnpj); query = { kind: "cnpj", value_masked: cnpj }; }
      else if (nome.length >= 3) { result = await screeningByName(nome); query = { kind: "nome", value_masked: nome }; }
      else return res.status(400).json({ ok:false, error:"Informe q= (nome, min. 3 letras), cpf= (11 digitos) ou cnpj= (14 digitos)." });
      if (!result.ok && result.status === "requires_key") {
        return res.status(501).json({ ok:false, status:"requires_key", error:"PORTAL_TRANSPARENCIA_API_KEY nao configurada." });
      }
      res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
      return res.status(200).json({ ok:true, source:"Portal da Transparencia", query, flags: result.flags, sources: result.sources });
    } catch(error) { return res.status(502).json({ ok:false, error:error.message }); }
  }

  // Consulta CPF: screening (se houver chave) + match na base local people.
  // O match local funciona SEM chave do Portal — nao retorna 501 aqui.
  if (type === "cpf") {
    const cpf = onlyDigits(req.query.cpf);
    if (cpf.length !== 11) return res.status(400).json({ ok:false, error:"CPF invalido (11 digitos)." });
    try {
      const { getSupabase } = require("../lib/supabase");
      const { normalizeName } = require("../lib/text");
      const supabase = getSupabase();
      const [screening, byCpf] = await Promise.all([
        screeningByCpf(cpf).catch((e) => ({ ok:false, error:e.message })),
        supabase.from("people").select("id, full_name, role, agency_id, agencies(acronym)").eq("cpf", cpf).limit(10)
      ]);
      let localMatches = (byCpf.data || []).map((p) => ({
        id: p.id, full_name: p.full_name, role: p.role, agency: p.agencies?.acronym || null
      }));
      // Se o screening trouxe um nome (PEP/servidor), tenta 2o match por nome
      // normalizado para ligar ao grafo local.
      if (!localMatches.length && screening.ok) {
        const hit = screening.sources?.peps?.items?.[0] || screening.sources?.servidores?.items?.[0];
        const nome = hit?.nome || hit?.servidor?.pessoa?.nome;
        if (nome) {
          const byName = await supabase.from("people")
            .select("id, full_name, role, agency_id, agencies(acronym)")
            .eq("normalized_name", normalizeName(nome)).limit(10);
          localMatches = (byName.data || []).map((p) => ({
            id: p.id, full_name: p.full_name, role: p.role, agency: p.agencies?.acronym || null
          }));
        }
      }
      res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=3600");
      return res.status(200).json({
        ok: true,
        cpf_masked: maskCpf(cpf),
        screening: screening.ok
          ? { flags: screening.flags, sources: screening.sources }
          : { ok:false, status: screening.status || "error", error: screening.error },
        local_matches: localMatches
      });
    } catch(error) { return res.status(502).json({ ok:false, error:error.message }); }
  }

  return res.status(400).json({ ok:false, error:"type invalido. Use: datajud, transparency, screening, cpf" });
};
