---
name: commit-and-pr
description: Escreva commits e pull requests claros — mensagem convencional, escopo pequeno, corpo que explica o porquê. Use ao commitar, abrir PR, ou quando pedir "faça o commit"/"suba isso".
when_to_use: Dispara ao criar commit ou PR.
---

## Antes de commitar

- Rode o [[verification-loop]]. Não commite código que você não verificou.
- Commit/push só quando o usuário pedir. Se está no branch padrão, crie um branch antes.
- Um commit = uma mudança lógica coesa. Não misture refactor + feature + fix.

## Mensagem de commit (Conventional Commits)

```
tipo(escopo): resumo no imperativo, ≤72 chars

Corpo opcional: o PORQUÊ da mudança e o efeito, não o "o quê" (o diff mostra).
Cite o modo de falha resolvido / decisão relevante.
```

Tipos: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `perf`, `style`.

## Pull Request

- **Título**: mesma convenção do commit.
- **Corpo**: contexto (por que), o que mudou (bullets), como testar/verificar, riscos e rollback.
- PR pequeno e revisável > PR gigante. Se cresceu demais, quebre.
- Link para issue/decisão quando houver.

## Higiene

- Sem `console.log`/debug, arquivo temporário, segredo ou dado real no diff.
- Confira `git status`/`git diff` antes — não commite o que não pretendia.
- Descreva outcomes com fidelidade: se um teste ficou pendente, diga no PR.
