# LINCE — Deploy e Ativacao da Inteligencia Nacional

Runbook do operador. O codigo ja esta em producao; este guia liga as fontes de
inteligencia conforme voce obtem as credenciais. **Nada aqui e obrigatorio para o
fluxo de consulta por CNPJ**, que funciona sem nenhum segredo.

## 1. Deploy (GitHub -> Vercel)

- O deploy e automatico: todo `git push` na branch `main` do repo
  `github.com/Joaodesouzanery/LINCE` dispara um build na Vercel
  (conta `joaodsouzanery@gmail.com`).
- Build: a Vercel detecta `package.json` e roda `npm install`. Sem passo de build
  do front (HTML/CSS/JS estaticos).
- **Limite Hobby**: o projeto usa exatamente **12 funcoes serverless** em `api/`
  (o teto do plano Hobby). **Nao adicione novos arquivos em `api/`** — novas rotas
  devem entrar por query-param nos dispatchers existentes (`api/external.js`,
  `api/intelligence.js`). Crons no Hobby: **2** (ja configurados em `vercel.json`;
  o PNCP roda manualmente, ver abaixo).

## 2. Variaveis de ambiente

Cadastre em **Vercel -> Project -> Settings -> Environment Variables (Production)**.
Apos cadastrar/alterar, **e preciso um novo deploy (Redeploy)** para as funcoes
enxergarem os valores. Veja `.env.example` para o template local.

| Variavel | O que liga | Sem ela |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | todo o motor de inteligencia, grafo, ingestao e dossie de pessoa | endpoints retornam 502; front mostra estado vazio |
| `INLABS_EMAIL`, `INLABS_SENHA` | ingestao do DOU (conta gratuita do INLABS) | Monitor DOU fica vazio |
| `ANTHROPIC_API_KEY` | resumo executivo + extracao de entidades por IA nos atos | grava o ato sem resumo (resto funciona) |
| `ANTHROPIC_MODEL` (default `claude-sonnet-4-6`) | modelo usado pela IA | usa o default |
| `DATAJUD_API_KEY` | `/api/external?type=datajud` (processos) | retorna `501 requires_key` |
| `PORTAL_TRANSPARENCIA_API_KEY` | `/api/external?type=transparency` (contratos/pagamentos) | retorna `501 requires_key` |
| `CRON_SECRET` | protege TODOS os endpoints de ingestao (`/api/ingest-*`, header `Authorization: Bearer <valor>`; a Vercel injeta nos crons) | endpoints de ingestao ficam abertos (abuso de custo/DoS) |
| `SUPABASE_ANON_KEY` | **login (Supabase Auth)** — chave PUBLICA exposta ao front (tela de login) e usada pelo `middleware.js` para validar o JWT nas APIs | **as APIs ficam ABERTAS (fail-open)** — qualquer um que ache a URL le dossies/screening/CPF. **Configure antes de por dado real de cliente.** |
| `ALLOWED_EMAILS` | allowlist de acesso (emails separados por virgula) — so eles acessam, mesmo com signup aberto | qualquer usuario que se cadastrar acessa (vazio = sem allowlist) |

> **Gate de acesso (LGPD) — Supabase Auth. LEIA NA ORDEM:**
> 1. **RLS PRIMEIRO (obrigatorio).** Rode no **SQL Editor** o bloco **"Fase M15"** de `supabase/schema.sql` (habilita Row Level Security em todas as tabelas). **Sem isso, expor a `SUPABASE_ANON_KEY` deixa qualquer um ler o banco inteiro (CPF/dossie) direto no PostgREST**, contornando o gate. O acesso server-side usa a service key (ignora RLS), entao o app segue funcionando.
> 2. Supabase > **Authentication > Providers > Email** habilitado.
> 3. Vercel env: **`SUPABASE_ANON_KEY`** (Project Settings > API > `anon public`), **`ALLOWED_EMAILS`** (seu email) e **`CRON_SECRET`** → Redeploy.
> 4. Abrir o LINCE → **Criar conta** com um email da allowlist. **Depois de criar, desligue** "Enable Sign Ups" no Supabase (registro invite-only).
>
> **Producao e FAIL-CLOSED:** sem `SUPABASE_ANON_KEY` as APIs dao **503**; com `ALLOWED_EMAILS` vazia, **403**; sem `CRON_SECRET` os `/api/ingest-*` dao **401**. (Em preview/dev, fail-open por conveniencia.) O `SUPABASE_SERVICE_KEY` continua **so** server-side.

Confira o que esta configurado **sem expor segredo**:
`GET https://<sua-url>/api/intelligence?type=health` -> retorna booleanos por variavel.

## 3. Banco de dados (Supabase)

1. Crie um projeto no Supabase e pegue `SUPABASE_URL` + `service_role key` (= `SUPABASE_SERVICE_KEY`).
2. No **SQL Editor**, rode o conteudo de [`supabase/schema.sql`](supabase/schema.sql)
   (cria agencias, documentos, relationships, mandates, contracts, etc.).
3. Cadastre as duas variaveis na Vercel (passo 2) e faca Redeploy.

## 4. Primeira ingestao (gerar inteligencia real)

Rode localmente (precisa de Node + um `.env` preenchido):

```bash
npm install
npm run db:setup            # semeia as agencias reguladoras
npm run db:agencies-cnpj    # vincula CNPJs as agencias (habilita PNCP)
npm run ingest:dou 2026-06-11   # ingere o DOU de uma data conhecida
npm run ingest:pncp         # contratos do PNCP (apos os CNPJs das agencias)
```

Depois disso o app exibe: radar de normas, score de risco por agencia, tendencia,
"porta-giratoria" (diretores com interesses corporativos), grafo nacional e dossies.

### Bases publicas grandes (nao vao no Git)
Dumps CSV/ZIP (Receita CNPJ, TSE, TCU) NAO entram no repositorio. Baixe e carregue
no Supabase com os loaders em `scripts/`:

```bash
npm run load:receita-socio <arquivo.csv>
npm run load:tse-filiacao  <arquivo.csv>
npm run load:tcu           <arquivo.csv>
```

## 5. Cron / agendamento

- `vercel.json` agenda `/api/ingest-dou` (12:00 UTC) e `/api/ingest-people-dou`
  (12:30 UTC) diariamente.
- O **PNCP** ficou fora do cron (limite Hobby de 2). Rode manual com
  `npm run ingest:pncp` ou chamando a URL `/api/ingest-pncp` (com `CRON_SECRET`
  se configurado). Se o PNCP semanal for critico, considere o plano Pro ou um
  agendador externo batendo na URL.

## 6. Verificacao pos-deploy

- **Fluxo essencial (deve funcionar sem segredos)**: abra a URL, consulte um CNPJ
  conhecido — dossie e grafo preenchem via `/api/cnpj` + `/api/rdap`; noticias via `/api/news`.
- **Degradacao (deve degradar, nao quebrar)**: abas Inteligencia / Monitor DOU /
  Diretores / Grafo Nacional mostram "sem dados / pendente" enquanto faltam
  credenciais ou ingestao — sem tela branca.
- **Status do deploy** (sem acesso a conta Vercel):
  `gh api repos/Joaodesouzanery/LINCE/commits/main/status` mostra o contexto `vercel`.
- **Gate de acesso ativo (Supabase Auth)** (apos setar `SUPABASE_ANON_KEY` + Redeploy):
  uma chamada de API **sem token** deve dar **401**; a config de login e publica.
  ```bash
  curl -i "https://<sua-url>/api/intelligence?type=score"        # esperado: 401 (protegido)
  curl -i "https://<sua-url>/api/intelligence?type=auth_config"  # esperado: 200 (publico, sem segredo)
  ```
  Se o `type=score` devolver 200 sem login, o gate esta **aberto** — falta
  `SUPABASE_ANON_KEY` ou o Redeploy. `/api/ingest-*` fica fora do gate JWT de
  proposito (protegido por `CRON_SECRET`). No navegador: abra a URL → tela de
  login → **Criar conta** (email da `ALLOWED_EMAILS`) → o app carrega.

## 6b. Atualização: grafo de vínculos + confiabilidade

O grafo foi reescrito com **Cytoscape.js** (carregado via CDN — sem build) e o
`api/graph.js` passou a derivar TODOS os vínculos (mandatos, filiação, deliberações,
votos) além da tabela `relationships`. Para o banco **já existente**, rode no SQL
Editor do Supabase apenas estas migrações idempotentes (estão em `supabase/schema.sql`):

```sql
-- habilita o vínculo socio<->empresa (dump da Receita)
alter type relationship_kind add value if not exists 'socio';
-- chave de dedup por token ordenado (reduz diretores duplicados)
alter table people add column if not exists normalized_key text;
create index if not exists people_normalized_key_idx on people (normalized_key);
```

Depois, para o vínculo de sócios aparecer no grafo, recarregue o dump:
`npm run load:receita-socio <arquivo.csv>`. A chave `normalized_key` é preenchida
automaticamente nas próximas ingestões; para popular as pessoas já existentes, faça
um backfill (uma vez) recalculando a chave a partir do nome — ou simplesmente deixe
que novas ingestões a preencham.

**Nota:** os "nomes sujos" da extração do DOU (ex.: "MATRICULA SIAPE DENOMINACAO")
foram reduzidos por uma stoplist ampliada em `lib/dou.js`. Ligar a `ANTHROPIC_API_KEY`
(seção 2) melhora ainda mais — limpa nomes e gera resumos por IA.

## 7. Rollback

```bash
git revert -m 1 <sha-do-merge-de-promocao>   # reverte a promocao, mantendo historico
git push origin main
# ultimo recurso:
git reset --hard pre-merge-main-6707f08 && git push --force origin main
```
