-- ============================================================================
-- REMOÇÃO dos módulos Eventos (M25-M29) e Financeiro (M30)
-- Os módulos migraram para outro sistema. Este script apaga as tabelas e a função
-- de merge do checklist.
--
-- IRREVERSÍVEL. Backup das linhas existentes foi feito antes de rodar
-- (2 eventos, 46 itens de checklist, 1 rubrica — nenhum dado financeiro).
--
-- Ordem: dependentes primeiro; o CASCADE cobre o resto.
--
-- O BUCKET 'financeiro-nf' NÃO É TRATADO AQUI, de propósito. A tabela
-- storage.objects tem o trigger storage.protect_delete(), que recusa DELETE
-- direto (42501) e manda usar a Storage API. Como o SQL Editor roda o script
-- inteiro numa transação, aquela linha abortava e REVERTIA todos os drops
-- acima — o script parecia ter falhado "só no bucket" e na verdade não tinha
-- efeito nenhum. O bucket é removido por scripts/drop-bucket-financeiro.js.
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
