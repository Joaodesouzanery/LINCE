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
