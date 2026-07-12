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
| `APP_USER`, `APP_PASS` | **gate de acesso (Basic Auth via `middleware.js`)** — pede login e protege TODO o deploy (front + APIs), exceto `/api/ingest-*` | **o site inteiro fica ABERTO (fail-open)** — qualquer um que ache a URL le dossies/screening/CPF. **Configure antes de por dado real de cliente.** |

> **Gate de acesso (LGPD):** o LINCE produz dossie de contraparte, screening PEP/sancoes e toca CPF. Uma URL publica da Vercel **nao e privada por si** — sem `APP_USER`/`APP_PASS`, o `middleware.js` roda em modo **fail-open** (libera tudo) e registra um `console.warn` nos logs. Configurar **ambas** ativa o Basic Auth. Atencao: se setar so uma (ou errar o nome da env), continua aberto e silencioso.

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
- **Gate de acesso ativo** (apos setar `APP_USER`/`APP_PASS` + Redeploy): uma
  requisicao **sem credencial** deve dar **401**. Teste:
  ```bash
  curl -i "https://<sua-url>/api/intelligence?type=health"    # esperado: 401
  curl -i -u "$APP_USER:$APP_PASS" "https://<sua-url>/api/intelligence?type=health"  # esperado: 200
  ```
  Se o primeiro devolver 200, o gate esta **aberto** — falta `APP_USER`/`APP_PASS`
  (ou uma delas) ou o Redeploy. A ingestao (`/api/ingest-*`) fica fora do Basic
  Auth de proposito (protegida por `CRON_SECRET`).

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
