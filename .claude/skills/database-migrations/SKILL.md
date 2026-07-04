---
name: database-migrations
description: Migrações de banco seguras — aditivas, idempotentes, reversíveis, com backfill e sem downtime. Use ao alterar schema, adicionar coluna/enum/índice, ou aplicar mudança no Postgres/Supabase de um banco que já tem dados.
when_to_use: Dispara ao criar/alterar tabelas, colunas, enums ou índices em banco existente.
---

## Regras de ouro

1. **Aditivo primeiro**: adicione coluna/tabela nova antes de usar; não renomeie/derrube em produção sem etapa de transição.
2. **Idempotente**: `create table if not exists`, `add column if not exists`, `create index if not exists`, `alter type ... add value if not exists 'x'`. Rodar duas vezes não pode quebrar.
3. **Reversível**: tenha o rollback pensado (drop/revert) antes de aplicar.

## Padrão sem downtime (expand → migrate → contract)

1. **Expand**: adicione a coluna nova (nullable/`default`), sem remover a antiga.
2. **Backfill**: preencha em lotes; código passa a escrever nas duas.
3. **Migrate**: código lê da nova.
4. **Contract**: só depois, remova a antiga (migração separada).

## Cuidados

- `alter type ... add value` **não roda dentro de transação** com uso no mesmo bloco em alguns cenários — aplique isolado; `if not exists` evita erro em banco já migrado.
- Índice em tabela grande: prefira `create index concurrently` (fora de transação) para não travar escrita.
- Coluna `not null` nova em tabela cheia: adicione com `default` ou em duas etapas (nullable → backfill → set not null).
- Guarde as migrações em arquivo versionado; documente qual rodar em produção (ex.: no DEPLOY.md).

## Verificação

- Rode em cópia/staging primeiro; confira que dado existente não corrompe e que o app degrada durante a janela.
