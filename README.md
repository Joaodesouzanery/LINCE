# LINCE

LINCE is a regulatory intelligence operating system for Brazil. It combines company/person investigation with regulatory decision analysis: who the actor is, where they appear, how they connect, and how regulators decide when they are involved.

## What Is Implemented

- Dark investigative canvas inspired by graph-first investigation products.
- Search entrypoints for CNPJ, CPF/name, process, agency and theme.
- Connected entity cards for company, partners, contacts, agency, director, process, debt, domains and regulatory news.
- Rich dossier tabs for basic information, CNAEs, partners, movements, addresses, phones, emails, social networks, documents, processes, debts, bank-account metadata, irregularities, alerts, domains, news/RSS, regulatory history and decision pattern.
- Sensitive-data policy in the UI: phones, emails, social networks and bank-account metadata are only shown when sourced from public data, licensed data or client-provided material.
- Sources/RSS module showing data capabilities, collection method and connection status.
- Supabase/Postgres schema for the current core plus future contacts, domains, news items, RSS feeds, bank-account metadata and company movements.

## Open The Demo

Open `index.html` directly in a browser. No install step is required.

## Suggested Next Implementation Steps

1. Connect Supabase and run `supabase/schema.sql`.
2. Build the first two ingest jobs:
   - ARTESP meetings and deliberation PDFs.
   - ANEEL CKAN dataset for public meeting agendas and minutes.
3. Add document storage and hashing for every original PDF/XML/CSV.
4. Add extraction jobs:
   - Deterministic regex for CNPJ, process numbers, dates, agency acronyms, and SEI numbers.
   - OpenAI extraction for votes, themes, results, justifications, and affected companies.
5. Replace demo data in `app.js` with API responses from Supabase.
6. Add review workflow for low-confidence extractions before commercial dossier delivery.

## Product Boundary

The first commercial product should sell ready-made dossiers and monitoring, not a generic investigation platform. Company data should remain contextual and tied to regulatory relevance. The moat is the connection between company, director, vote, process, historical pattern, and cited evidence.
