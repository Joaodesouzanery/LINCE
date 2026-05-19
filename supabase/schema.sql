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
  'succeeded_by'
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

create index documents_embedding_idx on documents using ivfflat (embedding vector_cosine_ops);
create index deliberations_embedding_idx on deliberations using ivfflat (embedding vector_cosine_ops);
create index votes_embedding_idx on votes using ivfflat (embedding vector_cosine_ops);
create index documents_source_idx on documents (source_name, published_at);
create index deliberations_process_idx on deliberations (process_number);
create index companies_cnpj_idx on companies (cnpj);
create index relationships_from_idx on relationships (from_kind, from_id);
create index relationships_to_idx on relationships (to_kind, to_id);
