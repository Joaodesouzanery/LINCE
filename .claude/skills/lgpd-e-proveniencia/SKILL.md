---
name: lgpd-e-proveniencia
description: CPF nunca persistido; match fraco exige selo de incerteza na tela E no PDF; toda afirmação carrega fonte primária, método e data. Use ao persistir dado pessoal, cruzar entidades por nome, ou gerar relatório/exportação que chegue ao cliente.
when_to_use: Dispara ao gravar dado de pessoa, casar entidades (pessoa/empresa), gerar PDF/relatório/e-mail, ou expor dado em tela.
---

## Dados pessoais

- **CPF nunca é persistido em claro** — nem em coluna, nem em log, nem em `metadata`. Minimize no
  ponto de entrada e descarte. Para vincular, use o id interno da pessoa.
- Ao exibir, mascare (`maskCpf`). O vínculo forte mora em `person_id`, não no documento.
- Dado público de registro (ex.: titular de processo minerário, que muitas vezes é **pessoa
  física**) pode ser persistido, mas **declare no comentário do schema** por que está ali — é o
  que uma auditoria vai perguntar, e ninguém lembra seis meses depois.

## Força do casamento

Todo cruzamento entre entidades declara sua força:

- **Forte** — documento ou id (CNPJ, CPF interno, número de processo). Afirmável como fato.
- **Fraco** — só por nome. **Não é afirmável.** Exige `match_method` gravado e flag de homônimo.

Regras do match fraco:

- **O selo de incerteza aparece na TELA e no PDF exportado.** O PDF é o que chega ao cliente; selo
  só na tela é selo que não existe.
- Homônimo ambíguo é **descartado**, não chutado.
- Onde houver operador, o match fraco passa por **confirmação humana antes do envio** — o gate vem
  antes de o alerta sair, não como nota de rodapé depois. Um falso positivo entregue custa mais que
  dez omissões.
- Mostre a evidência ao lado da afirmação (o nome como veio da fonte), não só a conclusão.

## Proveniência

- Toda afirmação de relatório carrega **fonte primária + método + data de coleta**. Sem isso, não
  entra — ou entra rotulada como hipótese não verificada.
- Dado curado à mão carrega `curated_at`/`curated_by` e prazo de revisão, e a tela mostra a data da
  última curadoria. Curadoria sem data vira folclore.
- Licença da fonte é parte da proveniência (ex.: CC BY 4.0 exige atribuição no rodapé).

Ver [[security-review]] e [[metrica-honesta]].
