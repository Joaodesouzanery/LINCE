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
