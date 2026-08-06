# Módulo "EVENTO" — Levantamento (pré-implementação)

> Pedido do usuário: **só pesquisa e levantamento, sem mexer em código ainda.** Este doc é o resultado
> da exploração (o que já temos p/ reusar × o que é novo × decisões a tomar antes de planejar/codar).

## Contexto
Novo módulo para **estruturar e administrar os eventos do IRIS** (ex.: Seminário do Setor Metroferroviário,
06/08/2026, Hotel Renaissance SP). Deve funcionar para **cada evento separadamente** (multi-evento, só troca
a informação). A **1ª aba é um Checklist totalmente interativo** (add/editar/excluir itens **e colunas**) que
substitui a planilha atual, incluindo **o que enviar e quando** (e-mails/ações ao longo do mês).

Anatomia de um evento (extraída dos seus PDFs):
- **Painéis + painelistas/moderadores** com cargo/empresa/minibio/foto e **status** (confirmado ✅ / pendente ⏱️). Ex.: 3 painéis, 13 painelistas+moderadores.
- **Demais convidados** (~35): nome + empresa + status. Total confirmado ~48; indicações por instituição (Metrô SP até 10, Simineral até 4…).
- **Cotas de patrocínio**: Diamante R$50k / Ouro R$30k / Prata R$15k, cada uma com lista de benefícios; + patrocinadores fechados.
- **Sequência de e-mails** (com timing): save-the-date → carta-convite (painelista/instituição) → pedido de minibio+foto → autorização de imagem → RSVP/confirmação (Google Form) → lembretes.
- **Checklist operacional**: Gerador, Hotel, Passagens, Financeiro, credenciamento, welcome coffee, coffee break.
- **Artes/specs**: painel de LED (1.280×512 px e 128×512 px), backdrop, logomarca, vídeo institucional.

---

## 1. O que JÁ temos (reutilizável) — molde pronto

O módulo **Painéis (NOMOS)** é o molde quase perfeito: multi-entidade, lista→detalhe, abas, CRUD multiplexado.

| Peça | Onde | Como reusar no EVENTO |
|---|---|---|
| **Módulo novo no front** | nav `index.html:61-64` · view `index.html:510-526` · `setView` `app.js:456-500` (título + `if(view==="evento")loadEvento()`) | 1 botão + 1 `<section id="view-evento">` + 3 linhas no setView. Clique e deep-link `?view=` já genéricos (`wireEvents` `app.js:4008`). |
| **CRUD multiplexado** (sem `api/*.js` novo) | `api/intelligence.js` dispatch por `type` (`:181-183`), helper `params(req)` (`:11`), blocos `painel_*` (`:767-905`) | Novos types `evt_*` (list/get/save/delete/item_add/update/remove), copiando `no-store` + `params(req)` + upsert `onConflict` + `{ok,...}`. |
| **Front lista→detalhe→abas** | `loadPaineis/openPainel/renderPainelDetail/renderPainelTab/wirePaineis` (`app.js:1800-2218`) | Copiar p/ `loadEvento/openEvento/...`; abas via `.dossier-tabs`; `wireEvento` com guard "ligar-uma-vez" + delegação de eventos. |
| **E-mail (Resend, gated)** | `lib/mailer.js sendEmail({to,subject,html,text})` | Disparo dos e-mails do evento. Sem `RESEND_API_KEY` → `skipped:"no_key"` (degrada). |
| **Webhook (anti-SSRF)** | `lib/notify.js postWebhook(url,{text})` | Notificação de status (opcional). |
| **Agendamento por data** | GitHub Actions `.github/workflows/paineis.yml` (cron diário) → `scripts/send-painel-reports.js` (cursor `last_report_at`) | Novo workflow+script no mesmo molde: cron diário que varre e-mails com `data_envio <= hoje AND status<>enviado`. |
| **Helpers de front** | `escapeHtml`/`safeUrl`/`money`/`fmtDate`/`requestJson`/`postJson`/`emptyCard`/`cardFoot`/`downloadText`/`$`/`state` (`app.js`) | Todos reutilizáveis direto. |
| **Schema idempotente** | `supabase/schema.sql` blocos M21–M24 (`:647-775`) | `create table if not exists` + índices + unique de dedup + `enable RLS`; aplicado por você no SQL Editor. |
| **Pessoas/empresas do grafo** | `people` (`:29`,+`:248-252`,`:555-557`) · `companies` (`:38`) | Painelista/convidado **liga por FK a `people`** quando já tem dossiê (diretor/parlamentar/sócio) → reuso investigativo. |
| **Auth automática** | `middleware.js` gateia `/api/*` (JWT+ALLOWED_EMAILS) | Types `evt_*` do operador ficam **protegidos automaticamente** (só liberar manualmente se houver link público read-only do evento). |
| **jsonb flexível + GIN** | `paineis.metadata`, `people.external_ids` (GIN `:557`) | Base do **checklist de colunas dinâmicas** (linha = `valores jsonb`; colunas = `jsonb` no cabeçalho). |

**Restrições confirmadas:** `api/*.js` = **12 (no teto do Hobby)** → nada de arquivo novo, tudo multiplexa em `intelligence.js`. **2 crons Vercel esgotados** → agendamento em GitHub Actions. Schema aplicado por você (service key não roda DDL).

---

## 2. O que NÃO existe (precisa ser novo)

1. **Checklist/grid EDITÁVEL com COLUNAS DINÂMICAS — o coração da 1ª aba.** Não há precedente no repo: todo o front é render estático a partir do backend; o único "editável" são `<select>` inline com colunas **fixas/hardcoded**. Construir do zero: célula editável in-place, add/remover **linha**, add/remover/renomear **coluna**, e persistência de um "schema de colunas por evento".
2. **Agendamento por DATA-ALVO** ("enviar neste dia" / "faltam N dias p/ o evento"). O mecanismo diário (Actions) existe, mas o painel envia por *novidade de ingestão*, não por data marcada — a lógica de data é nova.
3. **Storage de fotos/artes.** O projeto **não usa Supabase Storage** (0 uso de `supabase.storage`). Fotos de painelista / backdrop / LED exigem **habilitar um bucket novo** OU **guardar URL externa** em campo texto.
4. Domínios sem UI hoje (patrocínio, RSVP, specs LED, operacional) — mas cada um cabe no **molde estático de aba+tabela** do painel; só o Checklist exige o grid dinâmico.

---

## 3. Proposta de arquitetura (alto nível)

**Prefixo `evt_*`** (distinto de `legislative_eventos`/`evento_pauta`/`painel_*`; grep-safe). Um evento pai + tabelas filhas escopadas por `evento_id` (FK `on delete cascade`), no molde `paineis`↔`painel_items`:

- `evt_eventos` — evento pai (nome, data, horário, local, descrição, status, metadata jsonb).
- `evt_painelistas` — painel/nome, `person_id` (FK opcional a `people`), cargo, empresa, minibio, foto_url, papel (painelista/moderador), status (confirmado/pendente/recusado).
- `evt_convidados` — nome, empresa, email, instituição, status, cota_indicacao.
- `evt_patrocinadores` — nome/empresa, cota (Diamante/Ouro/Prata), valor, status, `company_id` opcional.
- `evt_cotas` — catálogo de cotas por evento (nome, valor, benefícios jsonb) — ou fixo em metadata.
- `evt_emails` — comunicação: tipo/template, destinatários, **data_envio**, status (rascunho/agendado/enviado), corpo. É o que o cron por-data dispara.
- `evt_checklist_colunas` (`colunas jsonb` def. por evento) + `evt_checklist_itens` (`valores jsonb`) — o grid flexível.

**Endpoints** (todos em `intelligence.js`): `evt_list`, `evt_get` (hidrata as abas), `evt_save`, `evt_delete`, `evt_<sub>_add/update/remove` por aba, `evt_checklist_*` (colunas+itens), `evt_email_send` ("enviar agora", molde `painel_send_report`).

**Front:** módulo "Eventos" (lista→detalhe) com abas: **Checklist** (grid dinâmico), **Painéis & Painelistas**, **Convidados/RSVP**, **Patrocínio**, **Comunicação** (timeline + enviar), **Operacional**, **Artes/Specs**.

**Agendamento:** novo `.github/workflows/eventos.yml` (cron diário) → `scripts/send-eventos-emails.js` (varre `evt_emails` com `data_envio<=hoje AND status='agendado'`, dispara `sendEmail`, marca enviado). Gated no Resend.

---

## 4. Diferencial — "o que seria interessante adicionar"

- **Painelista → dossiê LINCE:** quando o painelista/convidado é diretor de agência, parlamentar ou sócio, ligar por FK a `people` e abrir o **dossiê investigativo já existente** (patrimônio TSE, vínculos societários, porta-giratória). Nenhuma ferramenta de gestão de evento tem isso — é a camada única da LINCE aplicada a quem senta na mesa.
- **Gerar peças a partir do dado estruturado** (molde do relatório de painel → Markdown p/ Claude Design): programação preliminar, lista de confirmados, one-pager de patrocínio, release — sempre atualizados.
- **Mini-CRM de patrocínio:** soma das cotas fechadas vs meta; pipeline por status.
- **Import de RSVP:** colar/importar a lista do Google Form (o fluxo real hoje) → popular `evt_convidados` com dedup por nome/email.
- **Timeline de comunicação visual:** save-the-date → convite → minibio → RSVP → dia do evento, com o que já foi enviado e o que falta.

---

## 5. Decisões (respondidas pelo usuário) → F-EVT1

1. **Checklist = os dois modelos** → um só dado, **dois MODOS de visão**: Planilha (colunas 100% dinâmicas) ↔ Por categoria (agrupado). ✅
2. **Fotos/artes** → começar com **coluna tipo URL** (Drive/externo); **Marketing entra como categoria** (backdrop, Instagram, LinkedIn, stories, release). Supabase Storage = fase futura. ✅
3. **E-mails** → **só cronograma** ("hora de enviar X"): linhas com prazo + destaque de vencido/próximo. **Sem envio real, sem cron, sem Resend.** ✅
4. **Escopo** → **multi-evento** (evento-pai + Checklist). Painelistas/Patrocínio/RSVP = fases futuras. ✅
5. **Rótulo** "Eventos"; prefixo **`evt_*`**. ✅

**F-EVT1 implementado:** schema M25 (`evt_eventos` + `evt_checklist_itens` + RPC evt_item_patch), types `evt_*`, módulo "Eventos" no front (grid editável 2 modos + colunas dinâmicas + template semente por categoria incl. Marketing + destaque de prazo). Aplicar **M25**.

**F-EVT2 implementado:** schema M26 (`evt_programacao`, `evt_painelistas`, `evt_patrocinadores`, `evt_convidados` + `evt_eventos.objetivos`); abas **Programação do dia** (linha do tempo; bloco de painel puxa painelistas), **Painelistas** (status + **vincular → dossiê LINCE** via `openDirectorDossier`/`dossier-person?q=`), **Patrocínio** (cota/valor/benefícios/status + soma R$ fechado/pipeline), **Convidados/RSVP** (editável + import "Nome – Empresa ✅" dedup por nome + contadores); **Histórico** na lista de Eventos (barra de totais + cards com métricas + comparativo); Objetivos (campo em Dados) + specs LED (obs do Backdrop). types `evt_sub_save/remove` (whitelist por kind) + `evt_convidado_import`; evt_get/evt_list enriquecidos com métricas. Aplicar **M26**.

**F-EVT3 implementado (fecho software-only, sem schema):** **Exportar (.md)** do evento (one-pager/programação → Claude Design, reusa `downloadText`); **gráfico** de público/patrocínio por evento no histórico (reusa `buildMiniChart`); **cotas-catálogo** (Diamante/Ouro/Prata + valor + benefícios em `evt_eventos.metadata.cotas`, sem tabela; datalist no campo cota + entra no export). type `evt_cotas_save`. Rev. adversarial: 0 achados. **Falta (precisa de você): Supabase Storage p/ artes/fotos (bucket).**

---

## 6. Restrições herdadas (duras)
- Zero `api/*.js` novo (multiplexar em `intelligence.js`); zero cron Vercel novo (GitHub Actions).
- Schema idempotente aplicado por você no SQL Editor. Front sem framework. LGPD (e-mails de convidado são dado pessoal — tratar com cuidado, base "consentimento/legítimo interesse" do próprio evento).
- Ritmo por fase: código → revisão adversarial (Workflow) → corrigir → node --check → commit+merge+deploy.
