// DataJud + Portal da Transparencia unificados.
// GET /api/external?type=datajud&q=nome&tribunal=tjsp
// GET /api/external?type=transparency&cnpj=00000000000000
function onlyDigits(v) { return String(v||"").replace(/\D/g,""); }

module.exports = async function handler(req, res) {
  const type = String(req.query.type || "datajud");

  if (type === "datajud") {
    const apiKey = process.env.DATAJUD_API_KEY;
    if (!apiKey) return res.status(501).json({ ok:false, status:"requires_key", error:"DATAJUD_API_KEY nao configurada." });
    const q = String(req.query.q||"").trim();
    const tribunal = String(req.query.tribunal||"tjsp").toLowerCase();
    if (!q) return res.status(400).json({ ok:false, error:"Informe termo de busca." });
    try {
      const response = await fetch(`https://api-publica.datajud.cnj.jus.br/api_publica_${tribunal}/_search`, {
        method:"POST",
        headers: { "Content-Type":"application/json", Authorization:`APIKey ${apiKey}` },
        body: JSON.stringify({ size:10, query:{ match:{ "partes.nome": q } } })
      });
      const data = await response.json().catch(()=>null);
      if (!response.ok) return res.status(response.status).json({ ok:false, error:"DataJud falhou.", data });
      const hits = data?.hits?.hits||[];
      return res.status(200).json({ ok:true, source:"CNJ DataJud",
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
      return res.status(200).json({ ok:true, source:"Portal da Transparencia",
        items: (Array.isArray(data)?data:[]).slice(0,10).map(e=>({ title:e.objeto||e.numero||"Contrato publico", description:e.orgaoSuperior?.nome||"", raw:e }))
      });
    } catch(error) { return res.status(502).json({ ok:false, error:error.message }); }
  }

  return res.status(400).json({ ok:false, error:"type invalido. Use: datajud, transparency" });
};
