---
name: node-serverless-patterns
description: Padrões para funções serverless em Node (Vercel/API routes) — handlers idempotentes, env vars, cold start, limites de plano, cache e degradação graciosa. Use ao criar/editar rotas em api/, funções serverless, ou lógica de backend Node.
when_to_use: Dispara ao mexer em handlers de API/serverless, lib/ de backend Node ou configuração de função.
---

## Handler

- Assinatura padrão: `module.exports = async function handler(req, res) { ... }`.
- Valide `req.query`/`req.method` cedo; retorne status coerente (ver [[api-design]]).
- Envelope consistente: `{ ok:true, ...data, fetchedAt }` / `{ ok:false, error }`.
- Idempotente e stateless: nada de estado em memória entre invocações (cada request pode ser um processo novo).

## Segredos & config

- Leia de `process.env`; nunca hardcode. Documente em `.env.example` (ver [[security-review]]).
- Sem env obrigatória → falhe claro (501/`requires_key`) e degrade no front, não derrube a função.
- `try/catch` em toda dependência externa (banco/API); one source cai, o resto segue.

## Limites de plataforma (Vercel)

- **Plano Hobby: teto de funções serverless (≈12) e de crons (≈2).** Não crie arquivo novo em `api/` se já está no teto — roteie por query-param num dispatcher existente (`?type=...`).
- Cold start: minimize deps pesadas; import só o necessário no topo do handler.
- Cache: `res.setHeader("Cache-Control", "s-maxage=..., stale-while-revalidate=...")` conforme frescor aceitável da fonte.

## Robustez

- `Promise.allSettled` para chamadas paralelas com falha parcial tolerável.
- Não vaze erro cru/segredo no corpo da resposta.
- Sinalize truncamento (`total`, `truncated`) quando aplicar `.limit()` — não corte dado em silêncio (ver [[api-design]]).
