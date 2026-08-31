---
name: revisor-de-ingestao
description: Todo pipeline é idempotente com chave de identidade NOT NULL; re-run é no-op ou update, nunca duplicata; queda de fonte é falha honesta, não "sem dados". Use ao escrever ou revisar coletor, loader, backfill, cron ou workflow de ingestão.
when_to_use: Dispara ao criar/alterar script de ingestão, loader em lote, backfill, cron da Vercel ou workflow de Actions.
---

## Idempotência

- Re-rodar o mesmo insumo é **no-op ou update**, nunca duplicata. Prove rodando duas vezes: a
  segunda tem de inserir **0**.
- Idempotência mora em **constraint no banco** (índice único), não só em `if` no JavaScript. O
  código sozinho perde a corrida entre dois jobs.

## A armadilha da chave NULL

**Em Postgres `NULL != NULL`.** Um índice único sobre coluna que aceita nulo **não deduplica** as
linhas nulas — cada reingestão insere de novo, em silêncio.

Foi o que aconteceu com `alerts.alert_type`: a coluna ia `NULL`, o índice de dedupe nunca
conflitava, e cada reingestão do mesmo dia duplicava os alertas.

- Chave de identidade é **NOT NULL**. Se não puder ser, use índice **parcial**
  (`where col is not null`) e **garanta o preenchimento antes** de ligar o caminho que depende dele.
- Backfill da chave vem **antes** de habilitar a dedupe que a usa.

## Dedupe entre fontes

- Duas fontes da mesma informação raramente compartilham id. **Não desenhe o sistema para depender
  de igualdade de hash entre fontes** sem medir.
- Casamento textual **não é chave**: 96% de acerto significa 4% de duplicata, e a falha costuma ser
  **sistemática** (um formato específico), não ruído — logo, corrigível. Meça em vários dias.
- O mecanismo mais confiável é **particionamento**: um período/partição é servido por exatamente
  uma fonte, e aí não há colisão possível.
- O que não casar vai para **fila de revisão com flag**, nunca inserido direto.

## Falha honesta

- **Fonte fora do ar não é "sem dados".** Distinga indisponibilidade de ausência legítima usando um
  denominador independente (ver [[supabase-error-contract]]).
- **Job que falha tem de sair com código diferente de zero.** Um script que captura o erro por item,
  soma zero e termina com `exit 0` faz o cron reportar sucesso indefinidamente. Neste repo isso
  escondeu meses de ingestão quebrada.
- **Todo pipeline tem alarme de ausência**: período que fecha sem o volume esperado avisa no mesmo
  dia. Sem alarme, o conserto é temporário e a base degrada de novo.
- Loader em lote: `--dry-run` que imprime as primeiras correspondências, heartbeat de progresso, e
  relatório final com lidos/casados/inseridos/já existiam.

Ver [[database-migrations]] e [[metrica-honesta]].
