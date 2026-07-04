---
name: vercel-deploy
description: Deploy e operação na Vercel — deploy por git push, env vars por ambiente, crons, previews, verificação pós-deploy e rollback. Use ao publicar, configurar variáveis/cron na Vercel, investigar um deploy, ou reverter.
when_to_use: Dispara ao fazer deploy, mexer em vercel.json, env vars, crons, ou verificar produção.
---

## Deploy = git push

- Push na branch de produção (`main`) dispara o build automático na Vercel.
- Build detecta `package.json` e roda `npm install`; site estático sem passo de build.
- Antes do push: rode o [[verification-loop]] e crie uma tag/âncora do estado atual para rollback fácil.

## Env vars

- Cadastre em **Project → Settings → Environment Variables**, por ambiente (Production/Preview).
- **Alterou env var → precisa novo deploy (Redeploy)** para a função enxergar.
- Confirme sem expor segredo com um endpoint de health que só retorna booleanos (`{ supabase_url:true, ... }`).

## vercel.json / limites (Hobby)

- `cleanUrls`, `trailingSlash`, `crons`. **Hobby: ≈12 funções e ≈2 crons** — respeite o teto (ver [[node-serverless-patterns]]).
- Cron extra além do limite pode não registrar; mantenha 2 e rode o resto manualmente/externamente.

## Verificação pós-deploy (sem acesso à conta)

- Status via API do GitHub: `curl -s https://api.github.com/repos/<owner>/<repo>/commits/main/status` (contexto "Vercel").
- URL de produção via `.../deployments` (campo `environment_url`).
- Smoke test: raiz responde 200; fluxo essencial funciona; recursos sem credencial degradam (não quebram).

## Rollback

- `git revert -m 1 <sha-do-merge>` + push (preserva histórico), ou `git reset --hard <tag-anterior>` + push forçado (último recurso).
