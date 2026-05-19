# LINCE

LINCE is a regulatory intelligence operating system for Brazil. It combines company/person investigation with regulatory decision analysis: who the actor is, where they appear, how they connect, and how regulators decide when they are involved.

## What Is Implemented

- Dark operational dashboard that opens directly as a system, not a landing page.
- Sidebar modules: Overview, Investigar, Empresas, Diretores, Deliberações, Votos, Fontes, Red Flags, Dossiês and Alertas.
- Investigative search across companies, directors, agencies, deliberations, processes and themes.
- Interactive regulatory graph connecting companies, directors, agencies, votes, sanctions, QSA, DOU and DataJud.
- Red flag queue for recurrence, sanctions, judicialization, director vote patterns, QSA updates and institutional changes.
- Evidence panel with source, document type, date, confidence score and cited-data framing.
- Codex-generated dossier draft with executive summary, red flags, connections, decision pattern and next steps.
- Supabase/Postgres schema for agencies, people, companies, documents, meetings, deliberations, votes, relationships, dossiers and alerts.

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
