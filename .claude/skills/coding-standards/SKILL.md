---
name: coding-standards
description: Padrões de código — KISS/DRY/YAGNI, imutabilidade, nomes claros, funções pequenas, zero código morto e consistência com o estilo vizinho. Use ao escrever ou revisar código para manter legibilidade e manutenção.
when_to_use: Dispara ao criar/alterar código; guia o estilo e as decisões de design pequenas.
---

## Princípios

- **KISS**: a solução mais simples que resolve. Complexidade precisa se pagar.
- **DRY**: uma verdade em um lugar — mas não abstraia cedo demais (duas repetições ainda podem ficar; três, extraia).
- **YAGNI**: não construa para requisito hipotético. Resolva o que existe.
- **Consistência**: escreva como o código ao redor (nomes, imports, comentários, formatação). O repo manda mais que sua preferência.

## Práticas

- **Nomes** dizem intenção: `activeDirectors`, não `x`/`data2`. Verbo para função, substantivo para valor.
- **Imutabilidade** por padrão: `const`, cópias em vez de mutar; evite estado compartilhado mutável.
- **Funções pequenas e coesas**: uma responsabilidade; extraia quando cresce.
- **Retorno cedo** em vez de aninhar `if`; reduza profundidade.
- **Sem código morto**: apague o não usado (não comente "por via das dúvidas" — o git lembra).
- **Comentário explica o porquê**, não o quê. Código óbvio dispensa comentário.
- **Densidade de comentário** igual à do arquivo vizinho.

## Antes de finalizar

- O diff é o menor que resolve? Removeu debug/TODO solto?
- Um colega entende sem você explicar? Se não, renomeie/simplifique (ver [[code-simplifier]] agent).
