-- ============================================================================
-- REMOÇÃO dos módulos Eventos (M25-M29) e Financeiro (M30)
-- Os módulos migraram para outro sistema. Este script apaga as tabelas, a função
-- de merge do checklist e o bucket das notas fiscais.
--
-- IRREVERSÍVEL. Backup das linhas existentes foi feito antes de rodar
-- (2 eventos, 46 itens de checklist, 1 rubrica — nenhum dado financeiro).
--
-- Ordem: dependentes primeiro; o CASCADE cobre o resto.
-- ============================================================================

-- Score de Patrocinador (M27-M28) — dependem de evt_eventos/evt_patrocinadores
drop table if exists evt_sponsor_supressao   cascade;
drop table if exists evt_sponsor_calibracoes cascade;
drop table if exists evt_sponsor_golden      cascade;
drop table if exists evt_sponsor_scores      cascade;
drop table if exists evt_sponsor_runs        cascade;
drop table if exists evt_ref_notes           cascade;
drop table if exists evt_sponsor_rubrics     cascade;
drop table if exists evt_sponsor_contatos    cascade;

-- Base de contatos (M29) e sub-entidades do evento (M26)
drop table if exists evt_contatos       cascade;
drop table if exists evt_convidados     cascade;
drop table if exists evt_patrocinadores cascade;
drop table if exists evt_painelistas    cascade;
drop table if exists evt_programacao    cascade;

-- Núcleo do evento (M25)
drop function if exists evt_item_patch(uuid, jsonb);
drop table if exists evt_checklist_itens cascade;
drop table if exists evt_eventos         cascade;

-- Financeiro (M30)
drop table if exists fin_lancamentos cascade;
drop table if exists fin_balancetes  cascade;

-- Bucket privado das Notas Fiscais (apaga os objetos antes, senão o delete falha)
delete from storage.objects where bucket_id = 'financeiro-nf';
delete from storage.buckets where id = 'financeiro-nf';
