// Camada de IA: resumo + extracao de entidades de atos do DOU via API Claude.
// Requer env var: ANTHROPIC_API_KEY. Modelo configuravel por ANTHROPIC_MODEL.
const API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

// Recebe o texto bruto de um ato e devolve { summary, entities, confidence }.
// entities: [{ kind: 'person'|'company'|'agency', name, role }]
async function analyzeAto(title, rawText) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { summary: null, entities: [], confidence: 0, skipped: "no_api_key" };
  }

  const prompt = [
    "Voce e um analista regulatorio. Analise o ato oficial do DOU abaixo.",
    "Responda APENAS com JSON valido no formato:",
    '{"summary": "resumo executivo em 1-2 frases", "entities": [{"kind": "person|company|agency", "name": "...", "role": "..."}], "confidence": 0.0}',
    "confidence = sua certeza (0 a 1) de que a extracao esta correta.",
    "",
    `TITULO: ${title}`,
    `TEXTO: ${String(rawText || "").slice(0, 8000)}`
  ].join("\n");

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }]
      })
    });
    const data = await response.json();
    if (!response.ok) {
      return { summary: null, entities: [], confidence: 0, error: data?.error?.message };
    }
    const text = data?.content?.[0]?.text || "";
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = match ? JSON.parse(match[0]) : {};
    return {
      summary: parsed.summary || null,
      entities: Array.isArray(parsed.entities) ? parsed.entities : [],
      confidence: Number(parsed.confidence) || 0
    };
  } catch (error) {
    return { summary: null, entities: [], confidence: 0, error: error.message };
  }
}

// Resumo executivo de um dossie (pessoa ou empresa) para o relatorio impresso.
// Recebe o payload do dossie ja montado; devolve { summary, highlights,
// risk_flags, confidence } ou { summary: null, skipped/error } (degradacao).
async function summarizeDossier(dossier) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { summary: null, highlights: [], risk_flags: [], confidence: 0, skipped: "no_api_key" };
  }

  // Remove campos pesados/brutos antes de serializar (budget de tokens e 10s).
  const compact = JSON.parse(JSON.stringify(dossier, (key, value) => {
    if (["raw", "extracted_text", "embedding", "metadata"].includes(key)) return undefined;
    return value;
  }));
  const serialized = JSON.stringify(compact).slice(0, 12000);

  const prompt = [
    "Voce e um analista de compliance e inteligencia regulatoria.",
    "Abaixo esta um dossie em JSON (dados reais de fontes publicas brasileiras).",
    "Produza um resumo executivo para um relatorio impresso.",
    "Considere como sinais de risco: vinculo partidario/doacoes, rede societaria",
    "(campo corporate_network) e empresas com situacao cadastral nao-ativa",
    "(corporate_inactive > 0), porta giratoria e patrimonio incompativel.",
    "Responda APENAS com JSON valido no formato:",
    '{"summary": "3-5 frases objetivas", "highlights": ["fato relevante", "..."], "risk_flags": ["risco identificado", "..."], "confidence": 0.0}',
    "Nao invente dados: cite apenas o que esta no dossie. Se o dossie for escasso, diga isso no summary.",
    "",
    `DOSSIE: ${serialized}`
  ].join("\n");

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        max_tokens: 700,
        messages: [{ role: "user", content: prompt }]
      })
    });
    const data = await response.json();
    if (!response.ok) {
      return { summary: null, highlights: [], risk_flags: [], confidence: 0, error: data?.error?.message };
    }
    const text = data?.content?.[0]?.text || "";
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = match ? JSON.parse(match[0]) : {};
    return {
      summary: parsed.summary || null,
      highlights: Array.isArray(parsed.highlights) ? parsed.highlights : [],
      risk_flags: Array.isArray(parsed.risk_flags) ? parsed.risk_flags : [],
      confidence: Number(parsed.confidence) || 0
    };
  } catch (error) {
    return { summary: null, highlights: [], risk_flags: [], confidence: 0, error: error.message };
  }
}

// Narrativa executiva COMERCIAL sobre um dossie de landscape/deal (a
// "interpretacao" que uma consultoria de inteligencia regulatoria entrega —
// o que a Arko cobra). Inteligencia de MERCADO privada: le dados publicos e
// projeta cenarios/janelas/posicionamento. NUNCA sugere influenciar decisao
// publica (linha anti-lobby). Degrada sem chave: { summary:null, skipped }.
async function narrateDeal(payload) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { summary: null, scenarios: [], opportunities: [], risks: [], recommendation: null, confidence: 0, skipped: "no_api_key" };
  }

  // Remove campos brutos/pesados antes de serializar (budget de tokens).
  const compact = JSON.parse(JSON.stringify(payload, (key, value) => {
    if (["raw", "extracted_text", "embedding", "metadata"].includes(key)) return undefined;
    return value;
  }));
  const serialized = JSON.stringify(compact).slice(0, 14000);

  const prompt = [
    "Voce e analista senior de inteligencia regulatoria produzindo um briefing",
    "executivo PRIVADO para um cliente comercial (um fornecedor ou consultoria",
    "que quer entender o cenario regulatorio de um tema em agencias brasileiras).",
    "Abaixo esta um dossie em JSON com dados REAIS de fontes publicas (atos do",
    "DOU por tema, dirigentes das agencias-alvo, contratos a vencer, consultas",
    "abertas, vinculos societarios e, opcionalmente, uma contraparte).",
    "Escreva a INTERPRETACAO executiva: o que o cenario significa, para onde",
    "tende e como o cliente deveria se posicionar comercialmente.",
    "REGRAS: (1) NAO invente dados — cite apenas o que esta no dossie; se os",
    "dados forem escassos, diga isso no summary. (2) E inteligencia de MERCADO:",
    "foque em timing, posicionamento, risco reputacional/compliance e janelas de",
    "negocio. NUNCA sugira influenciar, pressionar ou obter vantagem indevida",
    "junto a agente publico, nem atrele recomendacao a decisao de orgao publico.",
    "Responda APENAS com JSON valido no formato:",
    '{"summary":"3-6 frases objetivas","scenarios":["cenario provavel nas agencias-alvo","..."],"opportunities":["janela ou frente de atuacao comercial","..."],"risks":["risco regulatorio ou reputacional","..."],"recommendation":"recomendacao de abordagem em 1-2 frases","confidence":0.0}',
    "",
    `DOSSIE: ${serialized}`
  ].join("\n");

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        max_tokens: 1100,
        messages: [{ role: "user", content: prompt }]
      })
    });
    const data = await response.json();
    if (!response.ok) {
      return { summary: null, scenarios: [], opportunities: [], risks: [], recommendation: null, confidence: 0, error: data?.error?.message };
    }
    const text = data?.content?.[0]?.text || "";
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = match ? JSON.parse(match[0]) : {};
    const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()) : []);
    return {
      summary: parsed.summary || null,
      scenarios: arr(parsed.scenarios),
      opportunities: arr(parsed.opportunities),
      risks: arr(parsed.risks),
      recommendation: parsed.recommendation || null,
      confidence: Number(parsed.confidence) || 0
    };
  } catch (error) {
    return { summary: null, scenarios: [], opportunities: [], risks: [], recommendation: null, confidence: 0, error: error.message };
  }
}

module.exports = { analyzeAto, summarizeDossier, narrateDeal };
