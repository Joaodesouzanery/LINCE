create extension if not exists vector;

create type entity_kind as enum ('agency', 'person', 'company', 'meeting', 'deliberation', 'vote', 'document', 'dossier');
create type relationship_kind as enum (
  'regulates',
  'mentions',
  'owns',
  'employs',
  'voted_on',
  'reported',
  'affected_by',
  'published',
  'cites',
  'succeeded_by',
  'socio'
);

create table agencies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  acronym text not null unique,
  sphere text not null,
  sector text not null,
  portal_url text,
  collection_rules jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table people (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  role text,
  source_profile_url text,
  bio jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table companies (
  id uuid primary key default gen_random_uuid(),
  cnpj text unique,
  legal_name text not null,
  trade_name text,
  cnae text,
  registration_status text,
  size_label text,
  shareholding jsonb not null default '[]'::jsonb,
  risk_context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table documents (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid references agencies(id),
  source_name text not null,
  source_url text not null,
  document_type text not null,
  title text not null,
  published_at date,
  collected_at timestamptz not null default now(),
  storage_path text,
  content_hash text,
  extracted_text text,
  extraction_status text not null default 'pending',
  metadata jsonb not null default '{}'::jsonb,
  embedding vector(1536)
);

create table meetings (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references agencies(id),
  meeting_number text,
  meeting_date date not null,
  meeting_type text,
  agenda_document_id uuid references documents(id),
  minutes_document_id uuid references documents(id),
  video_url text,
  status text not null default 'published',
  created_at timestamptz not null default now()
);

create table deliberations (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references agencies(id),
  meeting_id uuid references meetings(id),
  document_id uuid references documents(id),
  deliberation_number text,
  process_number text,
  title text not null,
  theme text,
  result text,
  impact_level text,
  affected_company_id uuid references companies(id),
  rapporteur_person_id uuid references people(id),
  confidence_score numeric(5, 4) not null default 0,
  evidence jsonb not null default '[]'::jsonb,
  embedding vector(1536),
  created_at timestamptz not null default now()
);

create table votes (
  id uuid primary key default gen_random_uuid(),
  deliberation_id uuid not null references deliberations(id) on delete cascade,
  voter_person_id uuid not null references people(id),
  vote_direction text,
  summary text,
  justification text,
  is_dissent boolean not null default false,
  confidence_score numeric(5, 4) not null default 0,
  evidence jsonb not null default '[]'::jsonb,
  embedding vector(1536),
  created_at timestamptz not null default now()
);

create table relationships (
  id uuid primary key default gen_random_uuid(),
  from_kind entity_kind not null,
  from_id uuid not null,
  to_kind entity_kind not null,
  to_id uuid not null,
  relationship relationship_kind not null,
  source_document_id uuid references documents(id),
  confidence_score numeric(5, 4) not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table dossiers (
  id uuid primary key default gen_random_uuid(),
  target_kind entity_kind not null,
  target_id uuid not null,
  title text not null,
  narrative text not null,
  risk_label text,
  evidence jsonb not null default '[]'::jsonb,
  review_status text not null default 'draft',
  generated_by text not null default 'Codex',
  generated_at timestamptz not null default now()
);

create table alerts (
  id uuid primary key default gen_random_uuid(),
  target_kind entity_kind not null,
  target_id uuid not null,
  title text not null,
  description text not null,
  severity text not null default 'medium',
  source_document_id uuid references documents(id),
  created_at timestamptz not null default now(),
  acknowledged_at timestamptz
);

create table contacts (
  id uuid primary key default gen_random_uuid(),
  target_kind entity_kind not null,
  target_id uuid not null,
  contact_type text not null,
  value_masked text not null,
  source_name text not null,
  source_document_id uuid references documents(id),
  legal_basis text not null default 'public_or_licensed_source',
  confidence_score numeric(5, 4) not null default 0,
  created_at timestamptz not null default now()
);

create table domains (
  id uuid primary key default gen_random_uuid(),
  target_kind entity_kind not null,
  target_id uuid not null,
  domain_name text not null,
  dns_snapshot jsonb not null default '{}'::jsonb,
  source_name text not null,
  confidence_score numeric(5, 4) not null default 0,
  created_at timestamptz not null default now()
);

create table news_items (
  id uuid primary key default gen_random_uuid(),
  source_name text not null,
  source_url text,
  published_at timestamptz,
  title text not null,
  summary text,
  extracted_entities jsonb not null default '[]'::jsonb,
  relevance_score numeric(5, 4) not null default 0,
  embedding vector(1536),
  created_at timestamptz not null default now()
);

create table rss_feeds (
  id uuid primary key default gen_random_uuid(),
  source_name text not null,
  feed_url text not null unique,
  agency_id uuid references agencies(id),
  status text not null default 'pending',
  last_checked_at timestamptz,
  created_at timestamptz not null default now()
);

create table bank_accounts_metadata (
  id uuid primary key default gen_random_uuid(),
  target_kind entity_kind not null,
  target_id uuid not null,
  label text not null,
  value_masked text not null,
  source_name text not null,
  legal_basis text not null,
  source_document_id uuid references documents(id),
  confidence_score numeric(5, 4) not null default 0,
  created_at timestamptz not null default now()
);

create table company_movements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  movement_date date,
  movement_type text not null,
  description text not null,
  source_name text not null,
  source_document_id uuid references documents(id),
  confidence_score numeric(5, 4) not null default 0,
  created_at timestamptz not null default now()
);

create index documents_embedding_idx on documents using ivfflat (embedding vector_cosine_ops);
create index deliberations_embedding_idx on deliberations using ivfflat (embedding vector_cosine_ops);
create index votes_embedding_idx on votes using ivfflat (embedding vector_cosine_ops);
create index news_items_embedding_idx on news_items using ivfflat (embedding vector_cosine_ops);
create index documents_source_idx on documents (source_name, published_at);
create index deliberations_process_idx on deliberations (process_number);
create index companies_cnpj_idx on companies (cnpj);
create index relationships_from_idx on relationships (from_kind, from_id);
create index relationships_to_idx on relationships (to_kind, to_id);
create index contacts_target_idx on contacts (target_kind, target_id);
create index domains_target_idx on domains (target_kind, target_id);
create index news_items_source_idx on news_items (source_name, published_at);
create index bank_accounts_metadata_target_idx on bank_accounts_metadata (target_kind, target_id);
create index company_movements_company_idx on company_movements (company_id, movement_date);

-- ============================================================================
-- Fases 2-4: diretores (M3), contratos (M6), jurisprudencia (M9)
-- ============================================================================

-- Migracao p/ bancos ja existentes: vinculo socio (socio<->empresa, dump da Receita).
-- Sem isso, scripts/load-receita-socio.js falha ao inserir e o vinculo some do grafo.
alter type relationship_kind add value if not exists 'socio';

-- Entity resolution de pessoas: chave canonica por nome normalizado / CPF.
alter table people add column if not exists cpf text;
alter table people add column if not exists normalized_name text;
-- Chave por token ordenado (dedup tolerante a ordem/conectivo). Ver lib/text.js.
alter table people add column if not exists normalized_key text;
alter table people add column if not exists agency_id uuid references agencies(id);
create index if not exists people_normalized_name_idx on people (normalized_name);
create index if not exists people_normalized_key_idx on people (normalized_key);
create index if not exists people_cpf_idx on people (cpf);

-- Mandatos de diretores (nomeacao/exoneracao via DOU Secao 2). M3.
create table if not exists mandates (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people(id) on delete cascade,
  agency_id uuid not null references agencies(id),
  role text,
  started_at date,
  ended_at date,
  appointment_act text,
  source_document_id uuid references documents(id),
  confidence_score numeric(5, 4) not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists mandates_person_idx on mandates (person_id);
create index if not exists mandates_agency_idx on mandates (agency_id);

-- Filiacao partidaria / doacoes (TSE dados abertos). M3.
create table if not exists party_links (
  id uuid primary key default gen_random_uuid(),
  person_id uuid references people(id) on delete cascade,
  party text not null,
  link_type text not null default 'filiacao',
  reference_year int,
  amount numeric(14, 2),
  source_name text not null default 'TSE',
  created_at timestamptz not null default now()
);
create index if not exists party_links_person_idx on party_links (person_id);

-- Contratos / licitacoes (PNCP). M6.
create table if not exists contracts (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid references agencies(id),
  supplier_company_id uuid references companies(id),
  supplier_cnpj text,
  supplier_name text,
  object text,
  modality text,
  value numeric(16, 2),
  signed_at date,
  ends_at date,
  pncp_id text unique,
  source_url text,
  source_name text not null default 'PNCP',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists contracts_agency_idx on contracts (agency_id);
create index if not exists contracts_supplier_idx on contracts (supplier_cnpj);
create index if not exists contracts_ends_idx on contracts (ends_at);

-- Jurisprudencia / processos (TCU, DataJud, CADE). M9.
create table if not exists jurisprudence (
  id uuid primary key default gen_random_uuid(),
  court text not null,
  process_number text,
  title text not null,
  summary text,
  decided_at date,
  url text,
  related_company_id uuid references companies(id),
  related_agency_id uuid references agencies(id),
  external_id text unique,
  metadata jsonb not null default '{}'::jsonb,
  embedding vector(1536),
  created_at timestamptz not null default now()
);
create index if not exists jurisprudence_court_idx on jurisprudence (court, decided_at);

-- ============================================================================
-- Fase 5 (M10): monitores, screening e patrimonio
-- Bloco idempotente: pode ser rodado mais de uma vez no SQL Editor sem efeito.
-- ============================================================================

-- Reconciliacao de drift: producao ja tem estas colunas em alerts (lib/ingest.js
-- upserta alert_type/body/metadata); bancos criados do zero passam a te-las tambem.
alter table alerts add column if not exists alert_type text;
alter table alerts add column if not exists body text;
alter table alerts add column if not exists metadata jsonb not null default '{}'::jsonb;
-- lib/ingest.js e o matcher de monitores inserem alerts sem description.
alter table alerts alter column description drop not null;

-- Unique p/ dedupe (onConflict do PostgREST exige indice unico). DO block porque
-- producao pode ja ter o indice equivalente com outro nome.
do $$
begin
  if not exists (
    select 1 from pg_indexes
    where tablename = 'alerts'
      and indexdef ilike '%unique%'
      and indexdef ilike '%source_document_id%'
      and indexdef ilike '%alert_type%'
  ) then
    create unique index alerts_dedupe_idx on alerts (source_document_id, target_id, alert_type);
  end if;
end $$;

-- Reconciliacao de drift: colunas de party_links usadas por load-tse-filiacao.js.
alter table party_links add column if not exists joined_at date;
alter table party_links add column if not exists status text;
alter table party_links add column if not exists source text default 'tse_filiacao';
alter table party_links add column if not exists confidence_score numeric(5, 4) default 1;

-- alerts.target_kind precisa apontar para monitores. Seguro no SQL Editor: este
-- bloco nao usa o valor novo em DML na mesma transacao (restricao do Postgres).
alter type entity_kind add value if not exists 'monitor';

-- Monitores de vigilancia (estilo Arko Alerta): o matcher roda a cada ingestao
-- do DOU e gera alerts com alert_type='monitor'.
create table if not exists monitors (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('keyword', 'person', 'company', 'agency')),
  label text not null,
  pattern text not null,
  -- normalizeName(pattern) pre-computado: o matcher compara includes() sem
  -- normalizar N monitores x M docs.
  normalized_pattern text not null,
  cpf_cnpj text,
  agency_id uuid references agencies(id) on delete set null,
  person_id uuid references people(id) on delete set null,
  company_id uuid references companies(id) on delete set null,
  severity text not null default 'medium',
  active boolean not null default true,
  hit_count integer not null default 0,
  last_hit_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- O matcher so le monitores ativos.
create index if not exists monitors_active_idx on monitors (active) where active;

-- Bens declarados ao TSE (bem_candidato x consulta_cand). Sem CPF do candidato
-- (LGPD): o vinculo forte ja esta em person_id; match_method registra a confianca.
create table if not exists assets (
  id uuid primary key default gen_random_uuid(),
  person_id uuid references people(id) on delete cascade,
  candidate_name text,
  sq_candidato text,
  nr_ordem integer,
  asset_type text,
  description text,
  value numeric(16, 2),
  reference_year integer,
  election_uf text,
  match_method text not null default 'cpf',
  source_name text not null default 'TSE',
  created_at timestamptz not null default now()
);
create index if not exists assets_person_idx on assets (person_id);
-- Identidade natural do dump: permite re-rodar o loader com ignoreDuplicates.
create unique index if not exists assets_tse_ref_idx on assets (sq_candidato, nr_ordem, reference_year);

-- ============================================================================
-- Fase M14: classificacao por TEMA dos atos (habilita o Mapa de Landscape).
-- Bloco idempotente: rodar no SQL Editor do Supabase e depois `npm run backfill:themes`.
-- ============================================================================
alter table documents add column if not exists themes text[];
-- GIN permite filtrar "atos que contem o tema X" de forma eficiente
-- (documents.themes @> array['Inteligência Artificial']).
create index if not exists documents_themes_gin on documents using gin (themes);

-- ============================================================================
-- Fase M15: Row Level Security (RLS) — SEGURANCA / LGPD. OBRIGATORIO.
-- A chave anon e exposta ao front (Supabase Auth). SEM RLS, qualquer um pega a
-- anon key e le o banco INTEIRO (CPF/dossie/vinculos) direto no PostgREST do
-- Supabase, contornando o gate do middleware (que so protege /api/* na Vercel).
-- Ligar RLS SEM criar policy = NEGA anon/authenticated por padrao. O acesso
-- server-side usa SUPABASE_SERVICE_KEY (lib/supabase.js), que IGNORA RLS -> os
-- endpoints /api/* seguem funcionando; o front so usa a anon key para login.
-- Bloco idempotente: rode no SQL Editor ANTES de expor a SUPABASE_ANON_KEY.
-- ============================================================================
alter table agencies enable row level security;
alter table people enable row level security;
alter table companies enable row level security;
alter table documents enable row level security;
alter table meetings enable row level security;
alter table deliberations enable row level security;
alter table votes enable row level security;
alter table relationships enable row level security;
alter table dossiers enable row level security;
alter table alerts enable row level security;
alter table contacts enable row level security;
alter table domains enable row level security;
alter table news_items enable row level security;
alter table rss_feeds enable row level security;
alter table bank_accounts_metadata enable row level security;
alter table company_movements enable row level security;
alter table mandates enable row level security;
alter table party_links enable row level security;
alter table contracts enable row level security;
alter table jurisprudence enable row level security;
alter table monitors enable row level security;
alter table assets enable row level security;

-- Reforco (defesa em profundidade): revoga os grants padrao de anon/authenticated
-- nas tabelas atuais e futuras do schema public.
revoke all on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;

-- ============================================================================
-- Fase M16: Agenda Regulatoria itemizada (os temas formais que cada agencia
-- planeja regular no bienio). Populada por scripts/load-agenda.js (extrai do
-- texto do ato de aprovacao ja em documents; qualidade com a IA). Bloco
-- idempotente + RLS (padrao M15). Rodar no SQL Editor.
-- ============================================================================
create table if not exists regulatory_agenda (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid references agencies(id),
  biennium text,                    -- ex.: "2026-2027"
  theme_title text not null,        -- o tema/atividade regulatoria
  status text,                      -- ex.: "planejado", "em consulta", "concluido"
  area text,                        -- area/superintendencia responsavel
  source_document_id uuid references documents(id),  -- o ato de aprovacao no DOU
  source_url text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists regulatory_agenda_agency_idx on regulatory_agenda (agency_id);
create index if not exists regulatory_agenda_biennium_idx on regulatory_agenda (biennium);
alter table regulatory_agenda enable row level security;

-- ============================================================================
-- Fase M17: Busca full-text (FTS) nativa do Postgres — alternativa SEM IA ao
-- embedding. Coluna gerada tsvector (portugues) sobre titulo+texto + indice GIN.
-- api/intelligence.js (type=search) usa websearch_to_tsquery; se a coluna nao
-- existir, degrada para ILIKE. Bloco idempotente. O `left(...,900000)` mantem a
-- entrada sob o limite de 1 MB do tsvector (senao um edital/anexo gigante
-- quebraria a ingestao do ato). ATENCAO OPERACIONAL: por ser coluna STORED
-- gerada, o ADD COLUMN reescreve a tabela documents inteira sob lock (ACCESS
-- EXCLUSIVE) uma vez — rode em janela de baixo trafego (leva alguns segundos).
-- ============================================================================
alter table documents add column if not exists search_tsv tsvector
  generated always as (to_tsvector('portuguese', left(coalesce(title, '') || ' ' || coalesce(extracted_text, ''), 900000))) stored;
create index if not exists documents_search_gin on documents using gin (search_tsv);

-- ============================================================================
-- Fase M18: Proposicoes legislativas PERSISTIDAS (Camara/Senado) — hoje o radar
-- legislativo e so ao vivo (sem historico). scripts/load-proposicoes.js grava
-- por tema (upsert por id estavel "camara:"/"senado:"), preservando first_seen.
-- Bloco idempotente + RLS (padrao M15).
-- ============================================================================
create table if not exists proposicoes (
  id text primary key,              -- "camara:<id>" / "senado:<cod>"
  casa text, tipo text, numero text, ano int,
  ementa text, titulo text, autor text, url text,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists proposicoes_ano_idx on proposicoes (ano desc);
alter table proposicoes enable row level security;

-- ============================================================================
-- Fase M19: Modulo "Voto dos Diretores" (Colegiado) — voto nominal/inferido de
-- cada diretor em cada deliberacao. Port do modulo homonimo do IRIS. SEM IA
-- (extracao/inferencia por regex). As tabelas votes/deliberations JA existem
-- (M3/M?) e o grafo (api/graph.js) e o dossie (api/dossier-person.js) JA as leem
-- -> voto ingerido aparece automaticamente no grafo e no dossie.
-- ============================================================================
-- votes: is_nominal (extraido por nome) vs inferido por mandato; is_dissent ja
-- cobre is_divergente; vote_direction ja cobre tipo_voto.
alter table votes add column if not exists is_nominal boolean not null default false;
-- Idempotencia: 1 voto por (deliberacao, diretor). votes esta vazia hoje.
create unique index if not exists votes_delib_voter_uidx on votes (deliberation_id, voter_person_id);

-- deliberations: campos extraidos do PDF/ata (espelham o IRIS). theme ja cobre
-- microtema; result ja cobre resultado; deliberation_number ja cobre numero.
alter table deliberations add column if not exists data_reuniao date;
alter table deliberations add column if not exists reuniao_ordinaria text;
alter table deliberations add column if not exists interessado text;
alter table deliberations add column if not exists pauta_interna boolean not null default false;
alter table deliberations add column if not exists auto_classified boolean not null default false;
alter table deliberations add column if not exists raw_text text;

-- Esteira de upload (writer unico dos votos): dedup por hash do arquivo.
create table if not exists upload_jobs (
  id uuid primary key default gen_random_uuid(),
  filename text not null,
  file_hash text unique,
  status text not null default 'pending',
  agency_id uuid references agencies(id) on delete set null,
  storage_path text,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists upload_jobs_status_idx on upload_jobs (status);
alter table upload_jobs enable row level security;
