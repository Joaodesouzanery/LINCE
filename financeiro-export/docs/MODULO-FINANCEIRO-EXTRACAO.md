# Módulo "Financeiro / Balancete" — guia de extração para outro projeto

> Extraído da **LINCE** (JS vanilla + Vercel Functions + Supabase).
> Origem no repo: `supabase/schema.sql` (bloco Fase M30), `api/intelligence.js:2263-2588`,
> `app.js:3396-3861`, `index.html:559-575`, `styles.css` (bloco `@media print`).
> Todas as linhas citadas foram conferidas contra o código em 2026-08.

---

## 1. O QUE O MÓDULO FAZ (em uma frase)

Transforma **o texto colado de um extrato bancário** num **Balancete pronto para
assinatura** — com despesas numeradas, carta de justificativa por despesa e Nota
Fiscal anexada — em vez de a pessoa montar isso à mão no Word todo mês.

### O problema real que ele resolve
Uma associação/instituto precisa prestar contas mensalmente. O trabalho manual era:
abrir o extrato, copiar cada débito para uma planilha, numerar, escrever uma carta
de justificativa por despesa (com o valor por extenso), anexar a NF de cada uma e
montar um PDF com página de assinaturas. São 2 a 4 horas por mês, com erro de
digitação e de soma.

### O fluxo, do jeito que o usuário vive
1. **Cria o balancete** do mês (competência `AAAA-MM`).
2. **Cola o extrato** (texto puro do internet banking) e escolhe a conta.
3. O sistema **parseia por regex** (sem IA) e cria um lançamento por linha.
4. O sistema **confere o saldo**: `anterior + créditos − débitos` tem que bater com
   o saldo final impresso no extrato. Se não bate, mostra a diferença — é sinal de
   linha perdida no parse.
5. O usuário **completa a finalidade** de cada despesa (o que o extrato não diz) e
   **anexa a NF**. Fornecedor recorrente já vem preenchido do mês anterior.
6. **Gera o documento**: baixa um `.md` e abre a versão de impressão (capa → tabela
   por conta → assinaturas → um ANEXO por despesa com a carta e a NF embutida).
7. **Fecha o balancete** (vira somente-leitura, com trava no backend).

---

## 2. MODELO DE DADOS (2 tabelas + 1 bucket)

DDL completo e idempotente em **`../supabase/schema-financeiro.sql`**.

| Tabela | Papel |
|---|---|
| `fin_balancetes` | 1 linha por mês. `status` aberto/fechado. `metadata jsonb` guarda **org** (nome/CNPJ/endereço), **assinaturas** (6 nomes) e **saldos** por conta. |
| `fin_lancamentos` | 1 linha por movimento do extrato. FK cascade para o balancete. |
| bucket `financeiro-nf` | **Privado**. Path `<balancete_id>/<lancamento_id>-<arquivo>`. |

### Decisões de modelagem que valem copiar

**Nomes de pessoas ficam em `metadata`, não no código.** Diretor financeiro, contador,
CRC e conselho fiscal são editáveis na interface. Ninguém precisa de deploy para trocar
o contador — e o repositório não guarda nome de ninguém.

**`Nº DOC` não é coluna.** É derivado na hora de renderizar: sequência sobre os débitos
com `contabiliza = true`, na ordem de exibição. Persistir o número seria criar uma
segunda fonte de verdade que sai de sincronia na primeira exclusão de linha.

**`contabiliza` é separado de `tipo`.** Crédito nunca contabiliza (regra do domínio:
entrada não é despesa). Mas um *débito* pode ser desmarcado — transferência entre contas
próprias sai da soma **sem** ser falseada como crédito, que era o único jeito antes.

**`ordem` existe e é reescrita.** Depois de cada importação o backend renumera o
balancete inteiro por `(conta, data)`. Sem isso, importar a segunda conta embaralhava a
numeração dos anexos do documento.

---

## 3. BACKEND — 11 operações

No sistema de origem tudo vive numa função só, multiplexada por `?type=`, porque o plano
Vercel Hobby limita a 12 funções. **Ao portar, o natural é virar rotas REST** — o mapa
está na tabela abaixo.

| `?type=` | REST equivalente | O que faz |
|---|---|---|
| `fin_list` | `GET /balancetes` | Lista + agrega nº de lançamentos e total de despesas |
| `fin_get` | `GET /balancetes/:id` | Balancete + lançamentos + **signed URLs (1h)** das NFs |
| `fin_save` | `POST/PATCH /balancetes` | Cria (herdando config) ou atualiza (merge de metadata) |
| `fin_delete` | `DELETE /balancetes/:id` | Apaga NFs do storage **antes** do cascade |
| `fin_lancamento_add` | `POST /lancamentos` | Linha vazia no fim |
| `fin_lancamento_save` | `PATCH /lancamentos/:id` | Patch parcial (uma célula por vez) |
| `fin_lancamento_remove` | `DELETE /lancamentos/:id` | Remove linha + NF |
| `fin_extrato_import` | `POST /balancetes/:id/extrato` | **O coração** — ver §4 |
| `fin_nf_upload` | `PUT /lancamentos/:id/nf` | base64 ≤ 4 MB → bucket privado |
| `fin_nf_remove` | `DELETE /lancamentos/:id/nf` | Remove do storage + limpa o path |

### Trava de balancete fechado
Um helper resolve o balancete (direto ou pelo lançamento) e devolve erro **409** se
`status = 'fechado'`. Aplicado em: `lancamento_add/save/remove`, `extrato_import`,
`nf_upload/remove`. **Não** em `fin_save` — é por lá que se reabre.

> ⚠️ **Defeito conhecido que você deve corrigir no porte:** esse guard **falha aberto** —
> ele ignora o erro das leituras e só bloqueia quando confirma `status = 'fechado'`. Se a
> consulta falhar, a escrita passa. No porte, trate erro de leitura como bloqueio.

---

## 4. O PARSER DO EXTRATO (a parte que dá o valor)

Formato do Banco do Brasil, texto copiado da tela. **Sem IA** — decisão consciente:
o formato é estável, regex é auditável e não custa por chamada.

```js
// linha de valor:  "1.234,56 (-) 05/03/2026 Pix - Enviado"
const valRe = /^([\d.]+,\d{2})\s*\(([-+])\)\s*(\d{2})\/(\d{2})\/(\d{4})\s+(.+)$/;
// linha de detalhe (a seguinte): "05/03 14:22 FORNECEDOR ABC LTDA"
const detRe = /^\d{2}\/\d{2}\s+\d{2}:\d{2}\s+(.+)$/;
```

Algoritmo, por linha:
1. Casou `valRe`? Extrai **valor** (pt-BR → float), **sinal** (`-` débito, `+` crédito),
   **data** e **lançamento**.
2. Olha a linha seguinte: se não for outra linha de valor, consome como **detalhe**
   (é o destinatário do PIX) e avança o índice.
3. `Saldo Anterior` → guarda em `metadata.saldos[conta].anterior` e **não** vira lançamento.
4. `S A L D O` (com espaços, é assim que o BB imprime) → guarda como `.final`.
5. **O sinal do saldo é preservado** — conta no cheque especial é negativa, e ignorar isso
   fazia a conferência acusar divergência falsa.

> ⚠️ **Ordem das operações (defeito sutil):** o passo 2 roda **antes** dos passos 3 e 4.
> Resultado: a linha logo após uma linha de saldo é consumida como "detalhe" e descartada
> junto. No porte, **teste saldo primeiro, depois o lookahead de detalhe.**

### Os quatro serviços que o import presta além de importar

| Serviço | Como |
|---|---|
| **Conferência de saldo** | `anterior + créditos − débitos` vs. saldo final do extrato; a UI mostra ✓ ou ⚠ com a diferença |
| **Dedup** | Chave `data\|valor\|lancamento\|detalhe` (o `lancamento` na chave é essencial: sem ele, duas despesas legítimas iguais no mesmo dia sumiam). Devolve **a lista** do que pulou, não só o número |
| **Fora da competência** | Conta linhas cuja data não é do mês do balancete — aviso, não bloqueio (extrato do BB pega o dia 1º seguinte) |
| **Memória entre meses** | Para cada lançamento novo, procura o **débito** mais recente de **outro** balancete com o mesmo `detalhe` e copia `descricao`/`estabelecimento`. Só débito→débito: um PIX *recebido* do fornecedor não pode emprestar finalidade de despesa |

Depois de inserir, renumera `ordem` no balancete inteiro por `(conta, data)`.
O update em lote manda **`{id, balancete_id, ordem}`** — `balancete_id` é `not null` sem
default, e um upsert sem ele quebra.

---

## 5. FRONTEND — o que precisa existir

Uma tela com dois estados: **lista de balancetes** (cards agrupados por ano) e **detalhe**
(tabela editável por conta). No original é `app.js:3396-3861`, mas nada ali é específico
de framework — é `innerHTML` + delegação de evento.

Peças que importam:

- **Tabela editável célula a célula.** Cada `input` carrega `data-id` + `data-field`; o
  `change` dispara um PATCH só daquele campo. Re-renderiza só quando o campo afeta soma
  ou ordem (valor, data, tipo, contabiliza).
- **`valorPorExtenso(v)`** — converte 1234.56 em "mil duzentos e trinta e quatro reais e
  cinquenta e seis centavos". ~30 linhas, sem dependência. **Reaproveite direto.**
- **`cartaJustificativaTexto(despesa, org)`** — dois parágrafos padrão.
- **Geração do documento** — `.md` baixado por Blob + HTML injetado num container oculto
  e `window.print()`. Sem lib de PDF: o "Salvar como PDF" do navegador faz o trabalho.
- **NF-imagem embutida como dataURL** no momento de gerar (com teto de 2,5 MB por imagem
  e ~12 MB no total). É o que faz o PDF sobreviver à expiração da signed URL de 1 hora.
- **Três estados da célula de NF:** com `nf_url` (link), com `nf_path` mas sem URL
  (signed URL falhou — mostra só o selo), e sem NF (botão de anexar).

### Detalhes de UX que vieram de erro real
- Barra de pendências ("3 despesas sem NF · 2 sem finalidade") **antes** de gerar, com
  confirmação — não bloqueia, avisa.
- Balancete fechado desabilita todos os inputs de uma vez após render.
- Criação por mini-formulário com o **mês local** (usar `toISOString()` faz virar o mês
  seguinte às 21h no horário de Brasília).

---

## 6. DEPENDÊNCIAS

**NPM:** `@supabase/supabase-js` (^2.45.0). Só isso. Sem lib de PDF, de planilha, de
data ou de moeda.

**Env:** `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (service-role — o módulo escreve com ela).

**Plataforma:** as funções de importação fazem várias chamadas sequenciais ao banco
(paginação do dedup + chunks da memória + renumeração). No original o timeout está em
**60 s**. Em runtime com teto de 10 s isso estoura num balancete grande — ajuste ou
quebre em duas chamadas.

**Helpers compartilhados** (todos triviais de recriar): seletor `$`, `requestJson`,
`postJson`, `money`, `escapeHtml`, `toast`, `downloadBlob`, `runPrint`, `fileToBase64`.

---

## 7. O QUE VOCÊ PRECISA TROCAR AO PORTAR

1. **Roteamento.** `?type=` → rotas REST (tabela do §3). Só existe por causa do teto de
   12 funções do plano Hobby.
2. **Autenticação.** No original um middleware valida JWT + allowlist de e-mail antes de
   qualquer rota. O módulo **não tem autorização própria** — ele assume que quem chegou
   pode tudo. Se o seu sistema tem papéis, adicione.
3. **Storage.** Supabase Storage → S3/GCS. O contrato usado é mínimo: `upload`, `remove`,
   `createSignedUrls`.
4. **Quatro strings do IRIS** a trocar: nome da organização (default), a lista de contas
   (`Banco do Brasil`, `BTG`, `BTG poupança`, `BTG cartão`), o "IRIS" na capa impressa e
   — fácil de esquecer — o §2 da carta, que diz "atividades institucionais **do
   Instituto**" independente do nome configurado.
5. **Parser do banco.** Se o seu extrato não é do BB, é aqui que mexe. O resto do módulo
   não sabe de que banco veio o dado — troque `valRe`/`detRe` e mantenha o contrato
   `{data, lancamento, detalhe, valor, tipo}`.
6. **CSS de impressão.** As classes de `@media print` (capa, faixa de classificação,
   numeração via `@page`) precisam ir junto, senão o documento sai sem formatação.

---

## 8. ORDEM SUGERIDA DE IMPLEMENTAÇÃO

1. Schema + bucket (`schema-financeiro.sql`).
2. `fin_list` / `fin_get` / `fin_save` + a tela de lista e detalhe **sem** edição.
3. Tabela editável + `fin_lancamento_*`.
4. **O parser** (`fin_extrato_import`) — a partir daqui já economiza tempo real.
5. Upload de NF.
6. Geração do documento (`.md` + impressão).
7. Conferência de saldo, dedup com lista, fora-de-competência, memória entre meses.
8. Fechar/reabrir + a trava no backend.

Depois do passo 4 o módulo já paga o esforço; do 5 ao 8 é o que o torna confiável.
