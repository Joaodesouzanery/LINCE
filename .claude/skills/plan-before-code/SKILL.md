---
name: plan-before-code
description: Antes de implementar uma tarefa não-trivial, produza um plano curto — arquivos a tocar, abordagem, riscos e como verificar. Use ao "implementar feature X", em refatorações, mudanças que tocam várias partes, ou quando o caminho não é óbvio.
when_to_use: Dispara antes de escrever código para tarefas de complexidade média/alta ou multi-arquivo.
---

## Regra

Pensar barato antes de codar caro. Um plano de 6 linhas evita horas de retrabalho.

## O plano mínimo (responda antes de tocar código)

1. **Objetivo**: o que muda para o usuário, em 1 frase.
2. **Arquivos**: quais arquivos/funções vão ser criados ou alterados (caminhos reais).
3. **Abordagem**: a estratégia escolhida — e por que, em 1 linha, contra a alternativa mais óbvia.
4. **Reuso**: o que já existe que será aproveitado (ver [[search-first]]).
5. **Riscos / modo de falha mais provável**: o que pode quebrar e como mitigar.
6. **Verificação**: como você vai provar que funciona (rodar o quê, observar o quê — ver [[verification-loop]]).

## Quando NÃO planejar

Correções triviais (1 linha, rename, typo). Para o resto, planeje.

## Boas práticas

- Prefira o menor diff que resolve. Não faça refator oportunista junto de feature.
- Se a tarefa é grande, quebre em passos entregáveis e verificáveis.
- Se há decisão arquitetural relevante, registre (ver [[coding-standards]] / ADR).
- Não invente requisito: se algo é ambíguo, pergunte antes de assumir.
