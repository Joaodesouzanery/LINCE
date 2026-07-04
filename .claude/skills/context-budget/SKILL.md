---
name: context-budget
description: Gerencie a janela de contexto e o custo de tokens — leia só o necessário, delegue buscas amplas a subagentes, e prefira conclusões a despejos de arquivo. Use em tarefas longas, repositórios grandes, ou quando o contexto começar a encher.
when_to_use: Dispara em sessões longas/multi-arquivo ou ao varrer muitos arquivos.
---

## Princípios

- **Leia com precisão**: quando você já sabe a parte do arquivo que importa, leia só ela (offset/limit), não o arquivo inteiro.
- **Delegue buscas amplas a subagentes** (ex.: `code-explorer`): eles varrem muitos arquivos e devolvem a conclusão, não o dump. Você guarda o resultado, não os arquivos.
- **Não re-leia** o que você acabou de editar para "conferir" — o tooling já valida a edição.
- **Não re-derive** fatos já estabelecidos na conversa; não re-explique opções que você não vai seguir.

## Quando delegar vs fazer inline

- Fato único / arquivo conhecido → busque direto.
- Varredura por convenção/uso em muitos lugares → subagente.
- Trabalho independente em paralelo → vários subagentes de uma vez.

## Táticas de economia

- Rode buscas específicas (`grep -n` do símbolo) em vez de abrir vários arquivos.
- Peça saída estruturada e curta dos subagentes.
- Em loops longos, resuma o estado e descarte o ruído intermediário.
- Aja quando tiver informação suficiente — não colete além do necessário.

## Sinal de alerta

Se você está relendo os mesmos arquivos ou copiando blocos grandes repetidamente, pare e delegue ou resuma.
