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
| `CRON_SECRET` (opcional) | protege endpoints de ingestao (`Authorization: Bearer <valor>`) | endpoints ficam abertos (ok para uso single-user) |

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

## 7. Rollback

```bash
git revert -m 1 <sha-do-merge-de-promocao>   # reverte a promocao, mantendo historico
git push origin main
# ultimo recurso:
git reset --hard pre-merge-main-6707f08 && git push --force origin main
```
