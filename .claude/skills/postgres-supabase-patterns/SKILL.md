---
name: postgres-supabase-patterns
description: Padrões de Postgres/Supabase — schema, índices, evitar N+1, RLS, service role vs anon key e storage. Use ao escrever SQL, consultas Supabase, definir tabelas/índices, ou mexer em segurança de dados.
when_to_use: Dispara ao criar/alterar schema, escrever query Supabase/SQL, ou configurar acesso a dados.
---

## Schema

- Chave primária `uuid default gen_random_uuid()`; `timestamptz` para tempo; `not null`/`default` explícitos.
- Unicidade real com `unique` (ex.: `cnpj`); FKs para integridade referencial.
- Enum para conjunto fechado; JSONB para dado semiestruturado (com parcimônia).

## Índices & performance

- Indexe colunas de filtro/junção/ordenação usadas de fato (não tudo).
- **Evite N+1**: uma query com `in (...)`/join em vez de um SELECT por item num loop.
- Pagine com `limit` + `range`/cursor; devolva `count` quando o cliente precisa saber o total (ver [[api-design]]).
- `select` só as colunas necessárias; evite `select *` em caminho quente.

## Supabase: chaves & RLS

- **`service_role` só no servidor** (bypassa RLS). **Nunca** no cliente/bundle (ver [[security-review]]).
- **Ligue RLS** em toda tabela exposta ao `anon`/`authenticated` e escreva policies por operação.
- Cliente do navegador usa a `anon key` + RLS; leitura/escrita privilegiada fica em rota de servidor.

## Robustez de query

- Trate `{ data, error }`: cheque `error` sempre; `maybeSingle()` quando 0/1 linha.
- Tolere tabela vazia/ausente sem quebrar a página (degradação graciosa).

## Migrações

- Mudança de estrutura vai por migração aditiva e idempotente — ver [[database-migrations]].
