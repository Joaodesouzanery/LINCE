# LINCE Starter Pack — Skills & Agents

Pacote **autoral** de skills e subagentes do Claude Code, escrito do zero (markdown
puro — sem hooks, sem scripts, sem chamadas de rede, sem chave de API), adaptado ao
stack do usuário: **JS/TS · Node/serverless · Vercel · Supabase/Postgres · Frontend/React**,
mais uma base de meta/fluxo/qualidade/segurança portável a qualquer projeto.

- **22 skills** em `.claude/skills/<nome>/SKILL.md` — disparam automaticamente por
  intenção (o Claude lê a `description` de cada uma e usa quando o pedido bate).
- **12 agents** em `.claude/agents/<nome>.md` — subagentes com escopo/tools restritos
  que o Claude delega automaticamente (ou você força: "use o security-reviewer em api/").

## Skills

**Meta / fluxo / qualidade / segurança**
- `search-first` — procurar o que já existe antes de escrever do zero
- `plan-before-code` — planejar (arquivos, riscos, verificação) antes de codar
- `tdd-workflow` — teste primeiro (red-green-refactor)
- `verification-loop` — rodar e observar antes de dar por concluído
- `code-review-checklist` — revisão do diff (correção/segurança/reuso/eficiência)
- `security-review` — OWASP, secrets, input, XSS/CSP/CORS
- `error-handling` — falhar alto, sem catch vazio, degradação graciosa
- `coding-standards` — KISS/DRY/YAGNI, imutabilidade, nomes, sem código morto
- `debugging-method` — reproduzir → isolar → hipótese → causa raiz
- `documentation-lookup` — consultar doc oficial antes de assumir API
- `commit-and-pr` — commits convencionais e PRs claros
- `context-budget` — economia de contexto/token e quando delegar

**Stack do usuário**
- `node-serverless-patterns` — handlers, env, cold start, limites Hobby, degradação
- `api-design` — REST, status, paginação, versionamento, truncamento honesto
- `vercel-deploy` — deploy por push, env vars, crons, verificação, rollback
- `postgres-supabase-patterns` — SQL, índices, N+1, RLS, service role, storage
- `database-migrations` — aditivas, idempotentes, reversíveis, sem downtime
- `frontend-and-react-patterns` — estados, a11y, escape/XSS, performance

**Regras invioláveis do LINCE** (nasceram de bugs reais deste repo — ver `CLAUDE.md`)
- `supabase-error-contract` — tratar `error`, paginar >1000, sem embed sem FK, fonte fora do ar ≠ sem dado
- `metrica-honesta` — janela, denominador, truncamento e composição em todo número exibido
- `lgpd-e-proveniencia` — CPF nunca persistido, match fraco com selo na tela e no PDF, proveniência sempre
- `revisor-de-ingestao` — idempotência com chave not-null, a armadilha do `NULL != NULL`, falha honesta

## Agents

- `planner` — plano de implementação (read-only)
- `code-reviewer` — review de qualidade/correção pós-edição
- `security-reviewer` — vulnerabilidades (OWASP/secrets/injection/XSS)
- `test-writer` — escreve testes via TDD
- `build-error-resolver` — corrige erro de build/typecheck/lint
- `refactor-cleaner` — remove código morto/duplicado (comportamento preservado)
- `silent-failure-hunter` — caça catch vazio / erro engolido / truncamento silencioso
- `code-explorer` — mapeia o codebase (read-only, haiku)
- `code-simplifier` — reduz complexidade preservando comportamento
- `migration-reviewer` — segurança/reversibilidade de migração SQL
- `accessibility-reviewer` — a11y de frontend
- `docs-updater` — sincroniza README/DEPLOY/.env.example com o código

## Procedência

Conteúdo 100% autoral desta sessão. Cobertura inspirada no manifesto do pacote ECC
(github.com/affaan-m/ECC, MIT) que o usuário trouxe, mas **nada foi copiado** — cada
arquivo foi escrito e é auditável. Sem dependência de terceiros em runtime.

## Sobreposição com recursos embutidos do Claude Code (pode podar)

O ambiente já traz alguns equivalentes nativos. As skills/agents deste pacote são
**portáveis** (valem em qualquer máquina/repo, inclusive onde os nativos não existam).
Se você usa muito os nativos e quer menos ruído de contexto, dá para apagar os
sobrepostos:

| Deste pacote | Equivalente nativo (se disponível) |
|---|---|
| `code-review-checklist` / agent `code-reviewer` | `/code-review` |
| `security-review` / agent `security-reviewer` | `/security-review` |
| `verification-loop` | `/verify` |
| `code-simplifier` (uso) | `/simplify` |
| `code-explorer` | agente `Explore` |
| `planner` | agente `Plan` |

Ver `SETUP.md` para configurar, verificar, portar para outros projetos e ajustar.
