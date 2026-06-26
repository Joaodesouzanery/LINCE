# LINCE

LINCE is a regulatory intelligence operating system for Brazil. It combines company/person investigation with regulatory decision analysis: who the actor is, where they appear, how they connect, and how regulators decide when they are involved.

## What Is Implemented

- Real-only CNPJ investigation flow: the app starts empty and does not load fictitious targets.
- Clean dark dashboard inspired by the reference: sidebar, compact metrics, thin borders and dense cards.
- Vercel API proxies for real sources:
  - `/api/cnpj` -> CNPJ.ws public API.
  - `/api/rdap` -> Registro.br RDAP.
  - `/api/news` -> Google News RSS.
  - `/api/datajud` -> prepared, requires `DATAJUD_API_KEY`.
  - `/api/transparency` -> prepared, requires `PORTAL_TRANSPARENCIA_API_KEY`.
- Interactive graph with pan, zoom, reset, node selection and draggable nodes.
- Dossier tabs filled only from real returned data; empty sections explicitly say there is no connected data.
- Supabase/Postgres schema for the current core plus future contacts, domains, news items, RSS feeds, bank-account metadata and company movements.

## Backbone de Ingestao (Fase 1 - Monitor DOU / M2+M4)

Primeiro pipeline real ponta-a-ponta: DOU diario -> Supabase -> app.

- `lib/dou.js` -> coletor do DOU via INLABS (Imprensa Nacional): login, download do ZIP de XMLs por secao/data, parse e match por agencia.
- `lib/anthropic.js` -> resumo executivo + extracao de entidades de cada ato via API Claude.
- `lib/supabase.js` -> cliente Supabase (service role).
- `/api/ingest-dou` -> ingestao agendada (Vercel Cron, `vercel.json`, 1x/dia) ou manual (`?date=YYYY-MM-DD`). Dedupe por `content_hash`; atos da Secao 2 (pessoal) geram `alerts`.
- `/api/dou-feed` -> feed do Monitor DOU para o front (filtro por data/agencia).
- `data/agencies.seed.json` -> seed das agencias reguladoras federais.

### Variaveis de ambiente

```
SUPABASE_URL, SUPABASE_SERVICE_KEY     # banco
INLABS_EMAIL, INLABS_SENHA             # conta gratuita do INLABS (DOU)
ANTHROPIC_API_KEY                      # camada de IA (opcional; sem ela, grava ato sem resumo)
ANTHROPIC_MODEL                        # default claude-sonnet-4-6
CRON_SECRET                            # opcional: protege /api/ingest-dou
DATAJUD_API_KEY, PORTAL_TRANSPARENCIA_API_KEY
```

### Setup

```
npm install
# 1) aplique supabase/schema.sql no SQL Editor do Supabase
# 2) popule as agencias:
npm run db:setup
# 3) teste a ingestao de uma data conhecida:
npm run ingest:dou 2026-06-11
```

## Modulos de Inteligencia (Fases 2-4)

- **M3 Diretores** -> `api/ingest-people-dou` (extrai dirigentes dos atos de pessoal do DOU,
  cria `people`/`mandates`/`relationships`) e `api/dossier-person?name=` (dossie: mandatos,
  filiacao, votos, SIAPE, score de captura). Front: aba "Diretores".
- **M6 Contratos** -> `api/ingest-pncp` (PNCP, contratos por agencia; preencha o CNPJ da
  agencia em `agencies.collection_rules.cnpj`). Tabela `contracts` + `relationships`.
- **M7 Grafo Nacional** -> `api/graph` (nodes/edges a partir de `relationships`). Front: aba
  "Grafo Nacional".
- **M9 Jurisprudencia** -> `scripts/load-tcu.js` (CSV do TCU) + `api/datajud` (processos).

## Onde colocar credenciais e dados

- **Chaves/segredos** (pequenos): em `.env` local (ver `.env.example`) e, em producao, no
  painel da Vercel (Environment Variables). Nunca no repositorio.
- **Bases publicas grandes** (dumps CSV/ZIP: Receita CNPJ, TSE, TCU): NAO vao no Git. Baixe e
  carregue no Supabase com os loaders em `scripts/` (ex.: `node scripts/load-tcu.js arquivo.csv`).
  O Supabase e a fonte unica de leitura da plataforma.

## Open The MVP

Open `index.html` directly in a browser. No install step is required.

For real API calls, use the Vercel deployment because `/api/*` serverless routes are required.

## Suggested Next Implementation Steps

1. Connect Supabase and run `supabase/schema.sql`.
2. Persist CNPJ/RDAP/RSS responses from the current Vercel API routes.
3. Add PGFN dump ingestion for debt lookup.
4. Add DataJud and Portal da Transparencia keys in Vercel environment variables.
5. Build ARTESP and ANEEL ingestion for regulatory history and decision pattern.
6. Add review workflow for low-confidence extractions before commercial dossier delivery.

## Product Boundary

The first commercial product should sell ready-made dossiers and monitoring, not a generic investigation platform. Company data should remain contextual and tied to regulatory relevance. The moat is the connection between company, director, vote, process, historical pattern, and cited evidence.
