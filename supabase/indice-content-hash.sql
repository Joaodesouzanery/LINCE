-- Fase 0 da ingestao sob demanda. Rodar no SQL Editor do Supabase.
-- Ja incluido em supabase/schema.sql (idempotente); este arquivo existe para
-- aplicar so o indice, sem reaplicar o schema inteiro.
--
-- Seguro: verificado em producao que os 34.363 content_hash sao 100% distintos
-- e sem nulos, entao a criacao do indice unico nao pode falhar por duplicata.
-- Em base grande, prefira CONCURRENTLY (nao roda dentro de transacao):
--   create unique index concurrently documents_content_hash_uidx
--     on documents (content_hash) where content_hash is not null;

create unique index if not exists documents_content_hash_uidx
  on documents (content_hash) where content_hash is not null;
