---
name: code-review-checklist
description: Checklist de revisão do diff atual — correção, segurança, reuso, simplicidade e eficiência. Use ao "revisar minhas mudanças", antes de commit/PR, ou depois de uma implementação para uma passada de qualidade.
when_to_use: Dispara ao pedir revisão do código, antes de abrir PR, ou após terminar uma feature.
---

## Como revisar

Leia o **diff**, não o arquivo inteiro. Para cada mudança, passe pelas dimensões abaixo. Reporte achados por severidade (crítico/alto/médio/baixo) com `arquivo:linha` e correção sugerida.

## Correção (bugs)

- Null/undefined desreferenciado; `.find()`/`.get()` sem checar retorno vazio.
- Off-by-one, condição invertida, `==` vs `===`, coerção inesperada.
- `async` sem `await`; promessa sem tratamento; condição de corrida.
- Caso de borda: vazio, limite, duplicado, entrada inválida.

## Segurança (ver [[security-review]])

- Input não validado; `innerHTML`/`dangerouslySetInnerHTML` sem escape (XSS).
- URL/href de fonte externa sem validar esquema (`javascript:`/`data:`).
- Segredo hardcoded ou vazando pro cliente; erro cru exposto ao usuário.

## Reuso e simplicidade

- Duplicação que deveria ser função compartilhada (ver [[search-first]]).
- Abstração/indireção desnecessária; código morto; flag nunca usada.
- Nome que não diz a intenção; comentário explicando o "óbvio errado".

## Eficiência

- N+1 (loop de fetch/query); trabalho repetido em render; falta de memoização.
- Loop sobre dados grandes sem necessidade; paginação/limite ausente.

## Regras

- Priorize **crítico/alto**; não afogue em nitpick.
- Aponte o problema **e** a correção. Se não tem certeza, marque como "verificar".
- Não invente problema para preencher lista — silêncio é resultado válido.
