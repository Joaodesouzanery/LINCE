# LINCE — Instruções do Projeto

Plataforma de inteligência regulatória/investigação (DOU, screening PEP/sanções, dossiê de pessoa, patrimônio TSE, grafo de vínculos, monitoramento).

## Stack real (IMPORTANTE — não presumir outra)

- **JavaScript puro (CommonJS)**: `require(...)` / `module.exports`. **Sem TypeScript**, sem build step, sem bundler.
- **Sem framework de frontend**: o front é `index.html` + `app.js` (arquivo único, grande) + `styles.css`. **Não** há React/Next/Vue. Não sugerir migração para framework nem `.tsx`.
- **Backend**: Vercel Serverless Functions em `api/*.js`. Um handler por arquivo, sempre:
  ```js
  module.exports = async function handler(req, res) { ... }
  ```
- **Libs de domínio** em `lib/` (ex.: `lib/dou.js`, `lib/transparencia.js`, `lib/anthropic.js`, `lib/supabase.js`).
- **Banco**: Supabase/Postgres com pgvector. Cliente único server-side com **service role key** via `lib/supabase.js` (`getSupabase()`). Env: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`.
- **IA**: Claude via `fetch` direto em `lib/anthropic.js` (sem SDK). Modelo via `ANTHROPIC_MODEL` (default `claude-sonnet-4-6`), `x-api-key` = `ANTHROPIC_API_KEY`.
- **Deploy**: Vercel. Crons em `vercel.json`. Sem `src/`, sem `components/`, sem App Router.

## Comandos

- **Não existem** `npm test`, `npm run lint`, `npm run build`, `npm run dev`. Não invente esses comandos.
- Scripts reais são jobs CLI de ingestão/carga: `npm run ingest:dou`, `load:receita-socio`, `load:tse-bens`, `db:setup`, etc. (ver `package.json`). Cada um é `node scripts/<x>.js [args] [--dry-run]`.
- **Verificação** = rodar o script/endpoint alvo e observar a saída (ou consultar o Supabase via MCP `execute_sql`), **não** "rodar os testes" (não há test runner).

## Banco de dados

- Schema num **único arquivo idempotente**: `supabase/schema.sql` (padrão `create table if not exists`). **Não há migrations incrementais versionadas.** Mudança de schema = editar esse arquivo mantendo idempotência e reaplicar via `scripts/setup-db.js`.
- Grafo: nós são as próprias entidades (`people`, `companies`, `agencies`…); arestas são a tabela genérica `relationships` (`from_kind/from_id`, `to_kind/to_id`, `relationship`, `metadata jsonb`). Enums `entity_kind` e `relationship_kind`.

## Convenções

- Nomes de arquivo **kebab-case** (`dossier-person.js`, `ingest-dou.js`).
- Endpoints "hub" multiplexam por `?type=` (ex.: `api/external.js`, `api/intelligence.js`) em vez de muitas rotas.
- GET com cache de borda: `res.setHeader("Cache-Control", "s-maxage=..., stale-while-revalidate=...")`.
- **Degradação graciosa**: sem chave de API → `res.status(501).json({ error: "requires_key" })`; sem `ANTHROPIC_API_KEY` → seguir sem resumo (`skipped: "no_api_key"`). Libs retornam `{ ok, ... }` e **nunca lançam** para o caller; usar `Promise.allSettled` em chamadas múltiplas.
- **LGPD**: **não persistir CPF**. Mascarar com `maskCpf` (`api/external.js`). Patrimônio/vínculos guardam `person_id`, não CPF; `match_method` = `cpf`|`name` com flag de homônimo (`weak_match`).
- Comentários em PT-BR marcam módulos (`M3`, `M6`…). Manter esse estilo.

## Regras invioláveis deste repositório

Valem **por padrão, em todo trabalho**, sem depender de skill disparar.

### Dados pessoais e LGPD
- CPF NUNCA é persistido em claro (banco ou log). Minimize e descarte.
- Todo casamento entre entidades tem força declarada: **forte** (documento/id) ou **fraco** (só por
  nome). Match fraco NÃO é afirmável como fato e exige selo de incerteza visível na **TELA e no PDF**
  exportado — o PDF é o que chega ao cliente.
- Toda afirmação de relatório carrega fonte primária + método + data. Sem proveniência, não entra
  (ou entra explicitamente como hipótese não verificada).

### Números e métricas
- Nenhum número vai à tela/PDF sem: **janela, denominador, truncamento e composição**.
- "Score"/"risco" não pode ser volume renomeado — normalize por base/exposição.
- Ranking sempre declara o critério e se está normalizado.
- Lote de dados no tamanho exato do limite (ex.: 1000) é suspeito de truncamento.

### Acesso a dados (Supabase)
- Nunca desestruturar resposta do Supabase sem tratar `error`.
- Toda falha é fatal (propaga) ou degrada (visível/logada) — **nunca sucesso vazio silencioso**.
- Pagine acima de 1000 linhas. Não use embed em tabelas sem FK (ex.: `relationships` → `PGRST200`).

### Ingestão
- Todo pipeline é idempotente com **chave de identidade not-null**. Re-run é no-op ou update, nunca
  duplicata. (Em Postgres `NULL != NULL`: índice único com coluna nula não deduplica.)
- Queda/manutenção de fonte é **falha honesta**, não "sem dados".

### Conflito de interesse
- Não construir produto que sirva simultaneamente ao **regulado** e ao **regulador** no mesmo eixo
  (ex.: radar defensivo para a empresa + triagem de contribuições para a agência). Separação por
  produto ou por setor; na dúvida, não fazer.

### Processo
- **Revisão adversarial antes de cada commit** — é o que pega a maior parte dos defeitos.

## Dívida técnica (preferir não piorar)

- `app.js` é monolítico e `api/intelligence.js` já é grande. **Preferir criar novo arquivo** em `api/`/`lib/` a inchar esses. Novas telas: manter blocos bem marcados no `app.js`.

## Skills/agents deste repo

Há 12 agents e 22 skills em `.claude/` (ver `.claude/PACK.md`). As quatro mais recentes —
`supabase-error-contract`, `metrica-honesta`, `lgpd-e-proveniencia` e `revisor-de-ingestao` —
detalham as regras invioláveis acima e nasceram de bugs reais deste repo. Algumas skills falam de React/TS/Jest — **isto NÃO se aplica aqui** (JS vanilla, sem testes). Usá-las como referência de princípio (segurança, error-handling, degradação), não como exigência de stack.
