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

module.exports = { analyzeAto };
