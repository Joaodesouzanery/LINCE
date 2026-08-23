-- ============================================================================
-- MODULO EVENTOS (gestao de seminarios) — schema isolado para porte
-- Extraido da LINCE (supabase/schema.sql, blocos "Fase M25" a "M29").
--
-- Idempotente. ORGANIZADO EM 3 NIVEIS — porte so o que for usar:
--   NIVEL 1 (NUCLEO)     : evt_eventos + evt_checklist_itens + RPC de merge.
--                          Sozinho ja entrega o checklist-planilha por area.
--   NIVEL 2 (PRODUCAO)   : programacao, painelistas, patrocinadores, convidados.
--   NIVEL 3 (RELACIONAL) : base de contatos cross-evento (funil de associados).
--
-- FORA deste arquivo (de proposito): as 7 tabelas do "Score de Patrocinador"
-- (evt_sponsor_rubrics/ref_notes/runs/scores/golden/calibracoes/supressao) e a
-- evt_sponsor_contatos — dependem de dados REGULATORIOS do sistema de origem
-- (agencias, contratos publicos do PNCP, atos do DOU) e nao fazem sentido fora
-- dele. Ver a secao "Score de Patrocinador" no guia de extracao.
--
-- Postgres 14+ / Supabase. Requer gen_random_uuid().
-- ============================================================================

-- ############################ NIVEL 1 — NUCLEO #############################

-- NAO confundir com legislative_eventos/evento_pauta (agenda da Camara). Prefixo evt_*.
-- Checklist interativo multi-evento: colunas DINAMICAS por evento (checklist_colunas jsonb)
-- e linhas com celulas em `valores jsonb` (sem DDL por coluna nova). Dois modos de visao
-- (planilha / por categoria) sobre o mesmo dado.
create table if not exists evt_eventos (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  data_evento date,
  horario text,
  local text,
  descricao text,
  status text not null default 'planejamento' check (status in ('planejamento', 'confirmado', 'realizado', 'cancelado')),
  checklist_colunas jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists evt_eventos_data_idx on evt_eventos (data_evento);
alter table evt_eventos enable row level security;

create table if not exists evt_checklist_itens (
  id uuid primary key default gen_random_uuid(),
  evento_id uuid not null references evt_eventos(id) on delete cascade,
  valores jsonb not null default '{}'::jsonb,   -- celula: { colKey: valor }
  ordem int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists evt_checklist_itens_evento_idx on evt_checklist_itens (evento_id, ordem);
alter table evt_checklist_itens enable row level security;

-- Merge ATOMICO de celula: valores || patch num unico UPDATE (evita lost-update quando
-- dois curadores editam celulas diferentes da MESMA linha ao mesmo tempo). Retorna o
-- valores final, ou NULL se o id nao existe. Idempotente (create or replace).
create or replace function evt_item_patch(p_id uuid, p_patch jsonb)
returns jsonb language sql as $$
  update evt_checklist_itens set valores = valores || p_patch, updated_at = now()
  where id = p_id returning valores;
$$;


-- ######################### NIVEL 2 — PRODUCAO DO EVENTO #####################

alter table evt_eventos add column if not exists objetivos text[];   -- objetivos do evento

-- Linha do tempo do dia. tipo='painel' + painel_ref casa com evt_painelistas.painel.
create table if not exists evt_programacao (
  id uuid primary key default gen_random_uuid(),
  evento_id uuid not null references evt_eventos(id) on delete cascade,
  ordem int not null default 0,
  horario text, titulo text not null,
  tipo text not null default 'painel' check (tipo in ('abertura', 'painel', 'coffee', 'intervalo', 'encerramento', 'outro')),
  descricao text, painel_ref text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists evt_programacao_evento_idx on evt_programacao (evento_id, ordem);
alter table evt_programacao enable row level security;

-- Painelistas/moderadores. person_id (opcional) liga ao dossie LINCE (diferencial).
create table if not exists evt_painelistas (
  id uuid primary key default gen_random_uuid(),
  evento_id uuid not null references evt_eventos(id) on delete cascade,
  painel text, nome text not null,
  person_id uuid,                                    -- FK OPCIONAL p/ a sua tabela de pessoas (ver rodape)
  cargo text, empresa text,
  papel text not null default 'painelista' check (papel in ('painelista', 'moderador')),
  minibio text, foto_url text,
  status text not null default 'pendente' check (status in ('confirmado', 'pendente', 'recusado')),
  ordem int not null default 0, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists evt_painelistas_evento_idx on evt_painelistas (evento_id);
alter table evt_painelistas enable row level security;

-- Patrocinadores. company_id (opcional) liga a empresa do grafo. beneficios = texto leve por cota.
create table if not exists evt_patrocinadores (
  id uuid primary key default gen_random_uuid(),
  evento_id uuid not null references evt_eventos(id) on delete cascade,
  nome text not null, company_id uuid,               -- company_id: FK OPCIONAL p/ empresas (ver rodape)
  cota text, valor numeric(14,2), beneficios text,
  status text not null default 'prospect' check (status in ('prospect', 'negociacao', 'fechado', 'recusado')),
  contato text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists evt_patrocinadores_evento_idx on evt_patrocinadores (evento_id);
alter table evt_patrocinadores enable row level security;

-- Convidados/RSVP. LGPD: email so interno (base = organizacao do evento); nunca em endpoint publico.
create table if not exists evt_convidados (
  id uuid primary key default gen_random_uuid(),
  evento_id uuid not null references evt_eventos(id) on delete cascade,
  nome text not null, empresa text, email text, instituicao text,
  status text not null default 'pendente' check (status in ('confirmado', 'pendente', 'recusado')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index if not exists evt_convidados_uidx on evt_convidados (evento_id, lower(nome));
create index if not exists evt_convidados_evento_idx on evt_convidados (evento_id);
alter table evt_convidados enable row level security;


-- Complementos do NIVEL 2 que no schema de origem moram dentro dos blocos do
-- Score/Central (M27-M29), mas que NAO dependem do score — vao junto:
alter table evt_patrocinadores add column if not exists motivo text;                            -- por que perdeu/ganhou
alter table evt_patrocinadores add column if not exists respondeu boolean not null default false;
alter table evt_convidados     add column if not exists segmento text;                          -- ICP do convidado
-- (a coluna sponsor_score_id de evt_patrocinadores FICOU DE FORA: e FK do Score.)

-- Disciplina de pipeline (F-EVT7): estagio + proxima acao com data.
alter table evt_patrocinadores add column if not exists estagio text;        -- Alvo/Contatado/Reuniao/Proposta/Fechado/Associado/Perdido
alter table evt_patrocinadores add column if not exists porta text;          -- quem abre a conta
alter table evt_patrocinadores add column if not exists proxima_acao text;
alter table evt_patrocinadores add column if not exists data_acao date;

-- ###################### NIVEL 3 — BASE DE CONTATOS ##########################


-- BASE de contatos CROSS-EVENTO (funil de associados): a lista de presenca de um evento vira a
-- base de prospeccao do proximo; quem nao fecha cota de patrocinio vira prospect de associado.
-- Padrao do schema: SEM evento_id obrigatorio (dado reutilizavel entre eventos, como
-- evt_sponsor_contatos). LGPD: e-mail/telefone = dado pessoal sob LEGITIMO INTERESSE do evento
-- (mesma base de evt_convidados) — declarado; NAO persistir CPF.
create table if not exists evt_contatos (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  empresa text,
  cargo text,
  setor text,
  email text,
  telefone text,
  company_id uuid,                                  -- FK OPCIONAL p/ empresas (ver rodape)
  origem_evento_id uuid references evt_eventos(id) on delete set null,  -- evento de origem (nulo se importado avulso)
  rel text not null default 'Contato',       -- Contato/Prospect patrocinio/Prospect associado/Patrocinador/Associado/Institucional
  cota_assoc text,                            -- regua de associacao: Apoiador/Bronze/Prata/Ouro/Platinum
  obs text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Dedup por pessoa+empresa (case-insensitive): a mesma pessoa nao duplica a cada evento importado.
create unique index if not exists evt_contatos_uidx on evt_contatos (lower(nome), lower(coalesce(empresa, '')));
create index if not exists evt_contatos_rel_idx on evt_contatos (rel);
create index if not exists evt_contatos_origem_idx on evt_contatos (origem_evento_id);
alter table evt_contatos enable row level security;

-- Disciplina do PIPELINE: o Score prospecta os alvos; aqui o pipeline e trabalhado com etapas +
-- proxima-acao datada (regra da "linha morta"). estagio complementa o status legado (prospect/…).

-- ---------------------------------------------------------------------------
-- NOTAS DE PORTE
-- 1. RLS habilitada SEM policies em todas: so a service-role (backend) enxerga.
-- 2. evt_painelistas.person_id e evt_patrocinadores.company_id sao FK OPCIONAIS
--    para as tabelas people/companies do sistema de origem. Ao portar sem elas,
--    REMOVA as duas FKs (o codigo ja trata os campos como opcionais).
-- 3. LGPD — a divisao de dado pessoal e DELIBERADA:
--      evt_contatos      : TEM email/telefone (base propria, legitimo interesse)
--      evt_convidados    : TEM email (lista do evento)
--      evt_sponsor_contatos (NAO incluida): so nome/cargo/link, SEM email/telefone
--    Nunca persista CPF em nenhuma delas.
-- 4. evt_checklist_itens.valores e um jsonb livre cujas CHAVES sao definidas por
--    evt_eventos.checklist_colunas — e o que torna a planilha dinamica. A RPC
--    evt_item_patch faz merge ATOMICO de uma celula (nao sobrescreve a linha).
-- 5. Uniques que sustentam os imports:
--      evt_convidados (evento_id, lower(nome))
--      evt_contatos   (lower(nome), lower(coalesce(empresa,'')))
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- FKs OPCIONAIS para as tabelas de pessoas/empresas do SEU sistema
--
-- No projeto de origem, tres colunas apontam para tabelas que NAO fazem parte
-- deste modulo (people/companies do sistema regulatorio). Elas foram deixadas
-- como uuid solto para que este arquivo aplique sem dependencia externa.
--
-- Se o seu sistema tiver tabelas equivalentes, ative as FKs (ajuste os nomes):
--
--   alter table evt_painelistas
--     add constraint evt_painelistas_person_fk
--     foreign key (person_id) references people(id) on delete set null;
--
--   alter table evt_patrocinadores
--     add constraint evt_patrocinadores_company_fk
--     foreign key (company_id) references companies(id) on delete set null;
--
--   alter table evt_contatos
--     add constraint evt_contatos_company_fk
--     foreign key (company_id) references companies(id) on delete set null;
--
-- O codigo do modulo trata os tres campos como OPCIONAIS — sem as FKs tudo
-- funciona; elas so garantem integridade referencial e o "ver dossie" do
-- painelista/patrocinador.
-- ---------------------------------------------------------------------------
