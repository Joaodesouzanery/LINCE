-- ============================================================================
-- MODULO FINANCEIRO (Balancete) — schema isolado para porte
-- Extraido da LINCE (supabase/schema.sql, bloco "Fase M30" + ajustes da F-FIN2).
--
-- Idempotente: pode ser reaplicado. NAO depende de nenhuma outra tabela do
-- sistema de origem (zero FK para agencies/people/companies) — e autocontido.
--
-- Postgres 14+ / Supabase. Requer gen_random_uuid() (pgcrypto ou pg 13+).
-- ============================================================================

-- Automatiza o Balancete mensal do IRIS: importa o extrato bancario, formata no padrao,
-- numera despesas (credito NAO contabiliza), gera carta justificativa + NF por despesa, e
-- produz o documento no formato do Balancete. LGPD: extrato tem dado financeiro + nomes de
-- destinatarios de PIX (dado pessoal) — vive SO no app (acesso controlado por middleware.js
-- JWT+allowlist); o documento gerado e BAIXADO, nunca vai para o repositorio/git.

-- Um balancete por competencia (mes). metadata guarda org (nome/cnpj/endereco), signatarios
-- (nomes editaveis) e saldos por conta.
create table if not exists fin_balancetes (
  id uuid primary key default gen_random_uuid(),
  competencia text not null,                          -- 'YYYY-MM' (ex.: '2026-03')
  titulo text,
  status text not null default 'aberto' check (status in ('aberto', 'fechado')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table fin_balancetes enable row level security;

-- Lancamento do extrato. Credito NAO contabiliza (contabiliza=false) -> fica fora da soma de
-- despesas e nao ganha No DOC. No DOC e DERIVADO no export (sequencia sobre debitos
-- contabilizados, por data) — nao persiste, fica sempre coerente. nf_path = caminho no Storage.
create table if not exists fin_lancamentos (
  id uuid primary key default gen_random_uuid(),
  balancete_id uuid not null references fin_balancetes(id) on delete cascade,
  conta text not null default 'Banco do Brasil',      -- Banco do Brasil / BTG / ...
  data date,
  lancamento text,                                    -- Pix Enviado / Compra Cartao / Boleto / ...
  detalhe text,                                       -- destinatario (ex.: ALMERIA, MIDIA IMPRESSA DF)
  descricao text,                                     -- finalidade (entra na DESCRICAO e na carta)
  valor numeric(14, 2),
  tipo text not null default 'debito' check (tipo in ('debito', 'credito')),
  contabiliza boolean not null default true,          -- credito -> false
  estabelecimento text,
  nf_path text,                                       -- caminho no bucket financeiro-nf
  ordem int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists fin_lancamentos_balancete_idx on fin_lancamentos (balancete_id, ordem);
alter table fin_lancamentos enable row level security;

-- Bucket PRIVADO das Notas Fiscais. Acesso so via service-role (backend); leitura via signed URL
-- curta gerada no fin_get. Sem policies publicas em storage.objects.

-- Bucket PRIVADO das Notas Fiscais. Acesso so via service-role (backend); leitura
-- via signed URL curta gerada no fin_get. Sem policies publicas em storage.objects.
-- (Supabase-especifico: em outro stack, troque por S3/GCS com URL assinada.)
insert into storage.buckets (id, name, public)
values ('financeiro-nf', 'financeiro-nf', false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- NOTAS DE PORTE
-- 1. RLS habilitada SEM policies: so a service-role (backend) enxerga. Se o seu
--    app consulta o banco pelo cliente, crie policies ANTES de usar.
-- 2. O bucket e PRIVADO por desenho (NF tem CNPJ, valor e nome). Nunca publico.
-- 3. Nao ha unique em (competencia): dois balancetes do mesmo mes sao possiveis
--    — o front avisa, mas nao bloqueia. Para impedir (depois de limpar duplicatas):
--      create unique index if not exists fin_balancetes_comp_uidx
--        on fin_balancetes (competencia);
-- 4. `ordem` nao tem unique — a re-numeracao (conta, data) do import assume isso.
-- 5. O Nº DOC do documento NAO e persistido: e derivado da ordem de exibicao,
--    contando so os debitos com contabiliza=true. Ver finNumbering() no guia.
-- ---------------------------------------------------------------------------
