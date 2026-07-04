# Claude Code Starter Pack — Setup (LINCE)

Pacote **autoral** de **18 skills + 12 agents** para o Claude Code, escrito do zero e
adaptado ao seu stack (JS/TS · Node/serverless · Vercel · Supabase/Postgres · Frontend/React)
+ base de meta/qualidade/segurança. **Markdown puro** — sem hooks, sem scripts, sem rede,
sem chave de API. Índice completo em [`.claude/PACK.md`](.claude/PACK.md).

---

## 1. Já está instalado (neste repo)

O pacote vive em `.claude/` do próprio LINCE — **não precisa copiar nada**:

```
.claude/
├── skills/<nome>/SKILL.md   # 18 skills
├── agents/<nome>.md         # 12 agents
└── PACK.md                  # manifesto
```

O Claude Code detecta skills/agents em segundos. Se você acabou de criar a pasta,
**reinicie a sessão** uma vez para ele começar a observar o diretório.

### Verifique que carregou
Dentro do Claude Code, no repo:
```
/skills     # deve listar as 18 (search-first, tdd-workflow, ...)
/agents     # deve listar os 12 (planner, code-reviewer, ...)
/doctor     # diagnóstico: descrições longas, duplicatas, capacidade
```

---

## 2. Como usar no dia a dia

**Skills disparam por intenção** — você não invoca à mão na maioria dos casos:

- "implemente a feature X" → `plan-before-code` + `search-first` + `tdd-workflow`
- "revise minhas mudanças" → `code-review-checklist` (+ `security-review` se tocar auth/input)
- "vou criar uma migração" → `database-migrations`
- "faça o deploy" → `vercel-deploy` + `verification-loop`
- "está quebrando o build" → (delegado ao) `build-error-resolver`

**Agents** o Claude delega sozinho quando a tarefa bate com a `description`, ou você força:
```
Use the security-reviewer agent on api/
Use the code-explorer agent para mapear o fluxo de dados
```

Invocação manual de skill (quando quiser forçar): `/nome-da-skill`.

---

## 3. Levar para outros projetos (ou para a máquina toda)

Você escolheu instalar só no LINCE. Para reaproveitar noutro repo, copie as pastas:

```bash
# em outro repositório:
cp -r "/Users/joaonery/VS CODE/LINCE/LINCE/.claude/skills"/* ./.claude/skills/ 2>/dev/null || \
  { mkdir -p ./.claude && cp -r "/Users/joaonery/VS CODE/LINCE/LINCE/.claude/skills" ./.claude/; }
cp -r "/Users/joaonery/VS CODE/LINCE/LINCE/.claude/agents" ./.claude/
```

**Global (vale em TODOS os projetos, sem copiar em cada um):**
```bash
mkdir -p ~/.claude/skills ~/.claude/agents
cp -r "/Users/joaonery/VS CODE/LINCE/LINCE/.claude/skills"/* ~/.claude/skills/
cp -r "/Users/joaonery/VS CODE/LINCE/LINCE/.claude/agents"/* ~/.claude/agents/
```
Precedência: projeto (`.claude/`) > pessoal (`~/.claude/`). Reinicie a sessão após criar.

---

## 4. Ajustes que valem a pena

- **Modelo por agent**: edite `model:` no frontmatter (`haiku` p/ leve e frequente como
  `code-explorer`; `sonnet` p/ trabalho principal; `opus` p/ decisão arquitetural). Baixar
  para haiku onde dá corta custo.
- **Ferramentas por agent**: `tools:` restringe o acesso — mantenha o mínimo necessário.
- **Podar o que não usa**: se não mexe com React, enxugue `frontend-and-react-patterns`;
  se usa os nativos (`/code-review`, `/verify`...), veja a tabela de sobreposição no
  `PACK.md` e apague os equivalentes — menos skills = menos ruído de contexto.
- **CLAUDE.md do projeto**: convenções específicas do repo têm prioridade; documente lá
  (as skills são procedimento, não fato — não duplique).

---

## 5. Projeção de produtividade e eficiência

> **Método:** projeção baseada em mecanismo, **não** medição garantida. Os ganhos
> dependem do seu baseline, do tamanho do projeto e de quanto retrabalho você tem hoje.
> As faixas assumem um dev usando IA ativamente em projetos de complexidade média.

| Dimensão | Mecanismo que age | Ganho projetado | Confiança |
|---|---|---|---|
| Retrabalho por abordagem errada | `search-first` + `plan-before-code` + `verification-loop` | **−30% a −50%** do tempo refazendo | Média-alta |
| Bugs que chegam a produção | `code-reviewer` + `security-reviewer` + `silent-failure-hunter` | **−20% a −40%** de defeitos escapando | Média |
| Onboarding em repo novo | `code-explorer` + `search-first` | de horas → **dezenas de min** | Alta |
| Overhead de re-explicar padrões | `coding-standards` / `error-handling` / `api-design` embutidos | **−5 a −15 min** por sessão | Alta |
| Custo/token por tarefa | `context-budget` + recall determinístico de skill | **−15% a −30%** de token em tarefas guiadas | Média |
| Consistência entre projetos | mesmas skills/agents em todo repo | qualitativo (menos variância) | Alta |

**Tempo agregado:** para quem já programa com IA várias horas por dia, a economia
realista fica em torno de **15–30% do tempo total de engenharia**, concentrada onde mais
dói — **retrabalho e review**. O maior ganho não é digitar mais rápido; é **errar de
caminho com menos frequência**.

**Duas honestidades:**
1. **Skill demais também custa** — cada skill consome contexto e cada agent adiciona
   passos. Remover as que você não usa melhora o número.
2. **O teto vem depois** — leva ~1–2 semanas para calibrar quais agents você deixa rodar
   sozinho e quais revisa. No começo há um pequeno custo de aprendizado.

---

## 6. Garantias

- 100% markdown; nenhum `.js/.sh/.py` executável em `.claude/`.
- Sem hooks, sem `install.sh`, sem `npm install`, sem chamada de rede, sem chave de API.
- Conteúdo autoral e auditável (leia cada arquivo). Procedência no `PACK.md`.
