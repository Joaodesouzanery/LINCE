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

-- ===== Fase M20: Diferencial Legislativo (parlamentar investigavel) =====
-- Cruza o legislativo (proposicao/autor/voto/financiamento) com a camada
-- investigativa (patrimonio/vinculos) que ja existe para diretores. O parlamentar
-- e apenas uma `people` com role='deputado'/'senador' e agency_id NULO — nao ha
-- pseudo-agencia (sector='regulatory' protege as queries regulatorias). SEM IA.

-- Id externo estavel (Camara/Senado) p/ casar autor/voto SEM CPF (LGPD). + UF.
alter table people add column if not exists external_ids jsonb not null default '{}'::jsonb;
alter table people add column if not exists uf text;
create index if not exists people_external_ids_gin on people using gin (external_ids);

-- Proposicao: tema (classifyThemes, determinístico) + situacao de tramitacao.
alter table proposicoes add column if not exists themes text[];
alter table proposicoes add column if not exists situacao text;
create index if not exists proposicoes_themes_gin on proposicoes using gin (themes);

-- Autoria estruturada: clicavel quando person_id resolvido; institucional
-- (comissao/executivo) fica com person_id NULO mas autor_nome preenchido.
create table if not exists proposicao_autores (
  id uuid primary key default gen_random_uuid(),
  proposicao_id text not null references proposicoes(id) on delete cascade,
  person_id uuid references people(id) on delete set null,
  autor_nome text not null,
  tipo text,                 -- deputado|senador|comissao|executivo|outro
  ordem int,
  external_author_id text,
  created_at timestamptz not null default now()
);
create unique index if not exists proposicao_autores_uidx on proposicao_autores (proposicao_id, autor_nome);
create index if not exists proposicao_autores_person_idx on proposicao_autores (person_id);
alter table proposicao_autores enable row level security;

-- ===== Fase M20.2: votacao legislativa nominal ("como vota") =====
-- Paralela a deliberations/votes (regulatorio), mas SEM agency_id. O loader de
-- dados (lib/vote-data.loadVotacoesLeg) mapeia p/ o shape IRIS e reusa as MESMAS
-- funcoes puras de lib/vote-metrics.js — zero mudanca nas metricas.
create table if not exists legislative_votacoes (
  id text primary key,                    -- camara-vot:<id> / senado-vot:<cod>
  proposicao_id text references proposicoes(id) on delete set null,
  casa text,
  descricao text,
  data_votacao date,
  resultado text,
  sigla_orgao text,
  url text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists legislative_votacoes_prop_idx on legislative_votacoes (proposicao_id);
alter table legislative_votacoes enable row level security;

create table if not exists legislative_votes (
  id uuid primary key default gen_random_uuid(),
  votacao_id text not null references legislative_votacoes(id) on delete cascade,
  person_id uuid references people(id) on delete set null,
  parlamentar_nome text,
  external_person_id text,
  voto text,                              -- CRU: Sim|Não|Abstenção|Obstrução|Art.17
  orientacao text,                        -- orientacao do partido (p/ fidelidade)
  partido text,
  uf text,
  created_at timestamptz not null default now()
);
-- Chave estavel por (votacao, id externo do parlamentar) — sempre presente (id da
-- Camara / codigo do Senado). Indice PLANO (nao-expressao) p/ permitir upsert ATOMICO
-- onConflict (evita delete-then-insert e sua janela de perda de votos).
create unique index if not exists legislative_votes_uidx
  on legislative_votes (votacao_id, external_person_id);
create index if not exists legislative_votes_person_idx on legislative_votes (person_id);
alter table legislative_votes enable row level security;

-- ===== Fase M20.3: doacoes de campanha ("quem financia") =====
-- Prestacao de contas eleitoral do TSE (receitas). LGPD: CNPJ de doador PJ e
-- publico; CPF de doador PF fica MASCARADO. O recebedor (candidato/parlamentar)
-- casa por nome com `people` (homonimo-seguro, lib/tse-match). SEM IA.
create table if not exists campaign_donations (
  id uuid primary key default gen_random_uuid(),
  recipient_person_id uuid references people(id) on delete cascade,
  recipient_name text,
  sq_candidato text,
  tse_receita_id text,                    -- SQ_RECEITA do TSE (id do recibo) — chave
  donor_name text,
  donor_document text,                    -- CNPJ (PJ) inteiro; CPF (PF) mascarado
  donor_type text,                        -- PF|PJ
  amount numeric(16,2),
  reference_year int,
  source_name text not null default 'TSE',
  match_method text not null default 'name',
  created_at timestamptz not null default now()
);
create index if not exists campaign_donations_recipient_idx on campaign_donations (recipient_person_id);
create index if not exists campaign_donations_donor_doc_idx on campaign_donations (donor_document);
-- Chave por RECIBO (nao por valor): dois recibos legitimos de mesmo valor NAO
-- colapsam. tse_receita_id e sempre preenchido pelo loader (SQ_RECEITA ou sequencia
-- por candidato) -> sem NULL na chave (evita re-insercao a cada run).
create unique index if not exists campaign_donations_uidx
  on campaign_donations (sq_candidato, tse_receita_id);
alter table campaign_donations enable row level security;

-- ===== Fase M21: Paineis curados (NOMOS F1) + comissoes =====
-- Painel = objeto de curadoria (por tema/cliente) que AGREGA proposicoes +
-- stakeholders + orgaos + eventos, com prioridade/posicionamento/tags por item.
-- Espelha o CRUD de monitors. webhook_url/frequencia/owner_email sao scaffolding
-- p/ alertas (F3) e white-label (F5) — aditivos e inofensivos ate la.
create table if not exists paineis (
  id uuid primary key default gen_random_uuid(),
  slug text unique,
  nome text not null,
  cliente text,
  descricao text,
  tema text[],
  active boolean not null default true,
  webhook_url text,
  frequencia text default 'diario' check (frequencia in ('tempo_real', 'diario', 'off')),
  owner_email text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists paineis_active_idx on paineis (active);
alter table paineis enable row level security;

-- Itens do painel. ref_id e TEXT polimorfico (uuid de people OU 'camara:123' de
-- proposicoes) — sem FK dura (o item_kind diz o namespace).
create table if not exists painel_items (
  id uuid primary key default gen_random_uuid(),
  painel_id uuid not null references paineis(id) on delete cascade,
  item_kind text not null check (item_kind in ('proposicao', 'stakeholder', 'orgao', 'evento', 'monitor')),
  ref_id text not null,
  prioridade text default 'media',
  posicionamento text default 'neutro',
  tags text[],
  nota text,
  ordem int,
  added_by text,
  created_at timestamptz not null default now()
);
create unique index if not exists painel_items_uidx on painel_items (painel_id, item_kind, ref_id);
create index if not exists painel_items_painel_idx on painel_items (painel_id);
create index if not exists painel_items_tags_gin on painel_items using gin (tags);
alter table painel_items enable row level security;

-- Comissoes/orgaos por parlamentar (aba "Orgaos" do perfil de stakeholder — NOMOS).
create table if not exists body_memberships (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people(id) on delete cascade,
  casa text,
  orgao_sigla text,
  orgao_nome text,
  cargo text,
  external_org_id text,
  created_at timestamptz not null default now()
);
-- Unique por external_org_id (sempre presente do coletor Camara) + cargo. A
-- idempotencia real vem do load-comissoes (delete-by-person + insert = re-sync
-- limpo, remove vinculo encerrado); este indice e so rede de seguranca.
create unique index if not exists body_memberships_uidx on body_memberships (person_id, external_org_id, cargo);
create index if not exists body_memberships_person_idx on body_memberships (person_id);
alter table body_memberships enable row level security;

-- ===== Fase M21.1: cursor do digest por painel (NOMOS F3 — alertas/relatorio) =====
-- Marca do ultimo envio de relatorio; o send-painel-reports usa como `since` p/
-- computar "novas votacoes" desde entao. Ausente -> o script degrada (since=now-7d).
alter table paineis add column if not exists last_report_at timestamptz;

-- ===== Fase M22: Agenda do Congresso (NOMOS F4 — "na pauta") =====
-- Eventos da Camara (/eventos) + itens de PAUTA que referenciam proposicao. O cruzamento
-- proposicao_id (= proposicoes.id 'camara:<id>') x painel_items(proposicao) responde
-- "quais das minhas proposicoes monitoradas estao na pauta". Sem IA, fonte gratis.
create table if not exists legislative_eventos (
  id text primary key,                 -- 'camara-ev:<id>'
  casa text,
  data_inicio timestamptz,
  data_fim timestamptz,
  situacao text,
  tipo text,
  descricao text,
  orgao_sigla text,
  orgao_nome text,
  local text,
  url text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists legislative_eventos_data_idx on legislative_eventos (data_inicio);
alter table legislative_eventos enable row level security;

-- Item de pauta que referencia uma proposicao. created_at = cursor "entrou na pauta"
-- (mesmo padrao do F3: novidade por ingestao). Re-sync por evento no load-eventos via
-- UPSERT + delete-stale (PRESERVA created_at; delete+insert resetaria e spammaria o digest).
create table if not exists evento_pauta (
  id uuid primary key default gen_random_uuid(),
  evento_id text references legislative_eventos(id) on delete cascade,
  proposicao_id text,                  -- 'camara:<id>' — liga ao painel
  ordem int,
  topico text,
  titulo text,
  situacao_item text,
  regime text,
  created_at timestamptz not null default now()
);
create unique index if not exists evento_pauta_uidx on evento_pauta (evento_id, proposicao_id);
create index if not exists evento_pauta_prop_idx on evento_pauta (proposicao_id);
alter table evento_pauta enable row level security;

-- ===== Fase M23: White-label (NOMOS F5 — link read-only por painel) =====
-- Token secreto do link do cliente: nulo = nao compartilhado; presente = link ativo;
-- rotacionar = novo valor (link antigo morre); revogar = volta a nulo. Unique (indexado).
-- O endpoint publico painel_public valida por este token e devolve SO dados sanitizados.
alter table paineis add column if not exists share_token text unique;

-- ===== Fase M24: Noticias curadas por painel (NOMOS F7) =====
-- O staff FIXA noticias no painel (busca via Google News ou cola URL); o cliente ve a
-- selecao (read-only) e ela entra no digest. created_at = cursor "noticia nova" do digest.
create table if not exists painel_noticias (
  id uuid primary key default gen_random_uuid(),
  painel_id uuid not null references paineis(id) on delete cascade,
  url text not null,
  titulo text,
  fonte text,
  published_at timestamptz,
  resumo text,
  added_by text,
  created_at timestamptz not null default now()
);
create unique index if not exists painel_noticias_uidx on painel_noticias (painel_id, url);
create index if not exists painel_noticias_painel_idx on painel_noticias (painel_id);
alter table painel_noticias enable row level security;
