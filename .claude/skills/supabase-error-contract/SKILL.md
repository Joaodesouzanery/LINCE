---
name: supabase-error-contract
description: Contrato de acesso a dados — nunca desestruturar sem tratar error, fatal-ou-degrada explícito, paginar acima de 1000, proibido embed em tabela sem FK, e distinguir fonte fora do ar de dado ausente. Use ao escrever qualquer consulta Supabase ou cliente de fonte externa.
when_to_use: Dispara ao escrever/alterar consulta Supabase, handler em api/, lib/ de acesso a dados, ou coletor de fonte externa.
---

## A regra que originou esta skill

Falha silenciosa é pior que falha ruidosa. Quatro bugs reais deste repo vieram do mesmo padrão:
o código não distinguiu **"não há dado"** de **"não consegui buscar o dado"**.

## Resposta do Supabase

- **Nunca** desestruture sem tratar `error`: `const { data } = await ...` engole a falha e segue
  com `undefined`. Sempre `const { data, error }` e uma decisão sobre `error`.
- Toda falha é **fatal** (propaga/retorna `{ok:false}`) ou **degrada** (visível na tela ou no log).
  Nunca sucesso vazio silencioso — `[]` por erro de rede mente para quem lê.
- `maybeSingle()` para 0-ou-1; `single()` só quando a ausência é realmente um erro.

## Paginação

- O PostgREST corta em **1000 linhas** por padrão. Acima disso, `.range(from, from+999)` em loop
  até `data.length < PAGE`, com teto explícito.
- **Lote no tamanho exato do limite é suspeito de truncamento**, não de coincidência. Se o
  resultado vai para a tela, sinalize `truncated` — ver [[metrica-honesta]].
- `.in(...)` viaja na querystring: fatie em blocos (~50 chaves) ou o servidor recusa a URL.

## Embed

- **Proibido embed em tabela sem FK declarada.** `relationships` é polimórfica (`from_kind/from_id`)
  e o embed devolve `PGRST200`. Resolva com duas consultas e junção em memória.

## Fonte externa fora do ar ≠ sem dado

- Cheque `res.status` **antes** de interpretar o corpo. Um 502 com página de manutenção não tem
  `Set-Cookie`, e ler isso como "cookie ausente" produz o diagnóstico errado — foi exatamente o que
  manteve a ingestão do DOU parada por 20 dias.
- Classifique o erro: 5xx/manutenção = indisponibilidade (retentável); 4xx/redirect ao login =
  credencial; corpo inesperado = mudança de contrato. Mensagem cita status e `Location`, nunca
  valores de cookie (são credencial).
- **`200` com zero itens é ambíguo.** Decida por um denominador independente (o total da fonte),
  não pelo conjunto filtrado.

Ver [[postgres-supabase-patterns]], [[error-handling]] e [[revisor-de-ingestao]].
