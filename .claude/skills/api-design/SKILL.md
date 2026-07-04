---
name: api-design
description: Design de API REST — nomes de recurso, métodos e status HTTP corretos, paginação, versionamento, formato de erro consistente e flags de truncamento. Use ao criar/alterar endpoint, definir contrato de resposta, ou revisar uma rota.
when_to_use: Dispara ao projetar ou alterar endpoints/contratos de API.
---

## Recursos & métodos

- Recurso é substantivo no plural: `/api/companies`, `/api/documents`. Ação vai no método, não no nome.
- `GET` (ler, seguro/idempotente), `POST` (criar), `PUT/PATCH` (atualizar), `DELETE` (remover).
- Filtros/opções via query: `?agency=ANEEL&limit=100`.

## Status HTTP

- `200` ok · `201` criado · `204` sem conteúdo.
- `400` input inválido · `401` não autenticado · `403` sem permissão · `404` ausente · `409` conflito.
- `429` rate limit · `5xx` erro interno · `501` recurso preparado mas sem credencial (`requires_key`).

## Formato de resposta (consistente)

- Sucesso: `{ ok:true, ...dados, fetchedAt }`.
- Erro: `{ ok:false, error:"mensagem útil", status? }` — sem vazar stack/segredo.
- Datas em ISO 8601; dinheiro como número + moeda explícita.

## Paginação & truncamento (honestidade)

- Ao aplicar `.limit(N)`, **devolva `total` e `truncated`** para o cliente saber que há mais. Nunca corte silenciosamente.
- Cursor/offset para páginas; documente o default e o máximo.

## Versionamento & evolução

- Mudança quebra-contrato → nova versão (`/v2/`) ou campo aditivo. Não altere o significado de um campo existente.
- Campos aditivos e opcionais são retrocompatíveis; remoção não é.

## Erros comuns

- Verbo no path (`/getUsers`), `200` com corpo de erro, paginação ausente em lista, formato de erro diferente por rota.
