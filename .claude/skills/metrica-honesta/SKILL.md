---
name: metrica-honesta
description: Nenhum número vai à tela ou ao PDF sem janela, denominador, truncamento e composição. Score não pode ser volume renomeado; ranking declara critério. Use ao calcular, agregar ou exibir qualquer métrica, KPI, score ou percentual.
when_to_use: Dispara ao escrever agregação, KPI, score, ranking, percentual, gráfico, ou texto de relatório que contenha número.
---

## Os quatro carimbos

Todo número exibido carrega, explícita ou visivelmente:

1. **Janela** — de quando até quando. "534 atos" sem período não significa nada.
2. **Denominador** — 534 de quantos? Percentual sem denominador é retórica.
3. **Truncamento** — o valor é total ou é o teto de um `limit`? Se pode ter cortado, diga.
4. **Composição** — de que o número é feito, quando isso muda a leitura.

## Armadilhas que já aconteceram aqui

- **Teto de `limit` exibido como total.** "200 alertas em aberto" era `.limit(200)`; o total real
  era 320. Use `{ count:'exact', head:true }` para o número, e a amostra só para a distribuição —
  declarando que é amostra.
- **Janelas misturadas.** Card contando contratos de 90 dias e somando dinheiro de 30. Contagem e
  valor têm de sair da mesma janela.
- **Delta contaminado.** "−47%" que era falha de coleta, não queda de publicação. Quando a coleta
  está degradada ou a janela truncou, o delta vira `null` **e a tela diz qual das causas é**.
- **NULL somado como zero em silêncio.** Somar valor de contrato ignorando os sem valor
  subestima a exposição. Some e **declare quantos não tinham valor**.
- **Arredondamento que apaga.** "0% contratos" quando há contratos. Se o valor é não-nulo, não
  exiba 0 — use `<1%`.

## Score e ranking

- **Score que cresce com volume é contagem renomeada.** Normalize por base/exposição, ou chame de
  contagem e pare de chamar de risco.
- Ranking declara o critério e se está normalizado.
- Quando uma categoria passa de **50%** do total, decomponha — um agregado dominado por uma classe
  esconde tudo que importa dentro dela.

## A regra vale para quem escreve a regra

Aplique os carimbos aos seus próprios números antes de apresentá-los. Nesta base, "14% de
cobertura" era verdade para um mês e falso para o acervo (~72%) — o denominador estava errado, e
só o carimbo pegou.

Ver [[supabase-error-contract]] e [[lgpd-e-proveniencia]].
