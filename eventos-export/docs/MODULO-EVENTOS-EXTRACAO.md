# Módulo "Eventos" — guia de extração para outro projeto

> Extraído da **LINCE** (JS vanilla + Vercel Functions + Supabase).
> Origem no repo: `supabase/schema.sql` (Fases M25-M29), `api/intelligence.js:1355-2259`,
> `app.js:1918-3394`, `index.html:541-556`, `vendor/xlsx.full.min.js`.
> Linhas conferidas contra o código em 2026-08.

---

## 1. O QUE O MÓDULO FAZ

Gerencia a produção de **seminários/eventos institucionais** de ponta a ponta: o
checklist do time, a programação, os painelistas, o pipeline de patrocínio, a lista de
convidados e uma base de contatos que **atravessa** os eventos.

### O problema real
Um evento era tocado numa planilha compartilhada + um grupo de WhatsApp + a memória de
quem já fez antes. Três consequências: o cronograma era recalculado à mão a cada mudança
de data, o patrocínio não tinha próxima-ação (a conta "morria" sem ninguém notar), e a
lista de contatos do evento anterior se perdia.

### A ideia central: **a planilha vira dado, sem virar rigidez**

Esta é a decisão que vale copiar mesmo que você não faça eventos.

O time trabalhava numa planilha e cada evento tinha colunas diferentes. Em vez de impor
um schema fixo (que ninguém usaria) ou aceitar uma planilha solta (que não vira software),
o módulo faz:

- As **colunas** vivem em `evt_eventos.checklist_colunas` (jsonb): `[{key, label, type, options}]`
- As **células** vivem em `evt_checklist_itens.valores` (jsonb): `{colKey: valor}`
- Adicionar coluna é **um UPDATE de jsonb**, não um `ALTER TABLE`.

O usuário cria colunas na tela como faria no Excel; o sistema continua sendo um banco
relacional. E remover uma coluna **não apaga o dado** — só some do cabeçalho; recriar a
coluna com a mesma `key` traz tudo de volta.

### O auto-dating (D-x): a funcionalidade que mais economiza tempo
Cada item do checklist guarda um **offset em dias** relativo à data do evento (`-30`,
`-7`, `-2`…). O prazo efetivo é: *prazo manual se existir, senão `data_evento + offset`*.

**Mudar a data do evento re-data o cronograma inteiro**, sem tocar em nenhum item. É a
diferença entre uma planilha e um sistema — e um porte que grave data absoluta no seed
perde exatamente isso.

### O evento nasce pronto
Criar um evento não cria uma casca vazia: cria **7 colunas padrão e 26 itens de
checklist**, já com área, observação e offset. E se o seed falhar, o evento é **apagado** —
por decisão explícita, não existe evento sem checklist.

---

## 2. MODELO DE DADOS — três níveis

DDL idempotente em **`../supabase/schema-eventos.sql`**, já separado.
Porte só o nível que for usar.

### Nível 1 — núcleo (2 tabelas + 1 função)
| Tabela | Papel |
|---|---|
| `evt_eventos` | nome, data, local, status, `checklist_colunas jsonb`, `metadata jsonb`, `objetivos text[]` |
| `evt_checklist_itens` | `valores jsonb` + `ordem`. FK cascade |
| RPC `evt_item_patch(id, patch)` | **merge atômico de uma célula** — ver §4 |

Só isso já entrega o checklist-planilha agrupado por área, com prazo derivado e progresso.

### Nível 2 — produção do evento
`evt_programacao` (blocos da agenda) · `evt_painelistas` (com `person_id` opcional) ·
`evt_patrocinadores` (cotas + pipeline) · `evt_convidados` (unique por `evento_id + nome`).

### Nível 3 — base de contatos cross-evento
`evt_contatos` — unique **global** por `(nome, empresa)`. É o funil: quem não fecha cota
de patrocínio vira prospect de associado, e o contato sobrevive ao evento.

### Fora do pacote: o "Score de Patrocinador"
As 7 tabelas `evt_sponsor_*` **não** foram incluídas. Elas pontuam empresas para prospecção
usando **contratos públicos, doações eleitorais e grafo societário** do sistema de origem —
sem essa base de dados regulatórios, não fazem sentido. Se o seu sistema tiver dados
equivalentes, o guia do score está em `docs/patrocinio-score.md` no repo original.

---

## 3. BACKEND — 36 operações

Todas em `?type=evt_*` no original (teto de 12 funções da Vercel). Agrupadas:

| Grupo | Operações | Observação |
|---|---|---|
| Evento | `evt_list`, `evt_get`, `evt_save`, `evt_delete` | `evt_get` traz **tudo** numa chamada: evento + colunas + itens + programação + painelistas + patrocinadores + convidados + métricas |
| Checklist | `evt_cols_save`, `evt_item_add`, `evt_item_update`, `evt_item_remove` | `evt_item_update` usa a RPC de merge |
| Sub-entidades | `evt_sub_save`, `evt_sub_remove` | **Um par genérico** para os 4 tipos, com whitelist de tabela/campos |
| Convidados | `evt_convidado_import` | Cola a lista; emoji vira status (✅ confirmado, ❌ recusado) |
| Cotas/metas | `evt_cotas_save`, `evt_meta_save` | Gravam em `metadata` **com merge** |
| Base de contatos | `evt_contato_*` (7 ops) | Inclui import de texto, de linhas (xlsx) e as duas pontes com o pipeline |
| Pauta | `evt_pauta` | Agenda da semana cruzando **todos** os eventos ativos |
| Score | `evt_sponsor_*`, `evt_golden_*`, `evt_ref_note_*` (14 ops) | Só com a base regulatória |

> ⚠️ **Ao portar para REST, atenção:** 35 das 36 operações leem o payload de
> `POST body` **ou** `query string` indiferentemente. **`evt_get` é a exceção** — lê
> `req.query.id` direto. Um cliente que mande `{id}` no corpo recebe 400.

### O par genérico de sub-entidades
Em vez de 8 endpoints (save/remove × 4 tipos), há **um** par que recebe `kind` e consulta
uma whitelist:

```js
EVT_SUB = {
  programacao:  { table: "evt_programacao",  fields: [...] },
  painelista:   { table: "evt_painelistas",  fields: [...], enums: { status: [...] } },
  patrocinador: { table: "evt_patrocinadores", fields: [...], enums: { status: [...] } },
  convidado:    { table: "evt_convidados",   fields: [...], enums: { status: [...] } }
}
```
Campo fora da whitelist é ignorado; valor fora do enum é rejeitado. Vale copiar o padrão:
adicionar um novo tipo de sub-entidade é uma entrada no objeto, não um endpoint novo.

---

## 4. AS REGRAS QUE UM PORTE INGÊNUO PERDE

**Merge atômico por célula.** O front salva **uma** célula por vez, e o backend nunca
reescreve o objeto inteiro — usa `valores || patch` num único UPDATE no Postgres:

```sql
create or replace function evt_item_patch(p_id uuid, p_patch jsonb)
returns evt_checklist_itens ...
  update evt_checklist_itens set valores = valores || p_patch where id = p_id ...
```

Sem isso, dois curadores editando **células diferentes da mesma linha** se sobrescrevem
(lost update). Um porte que faça read-modify-write na aplicação reintroduz o bug em
silêncio — e ele só aparece quando duas pessoas trabalham juntas, que é justamente
quando importa.

**Estágio é a fonte de verdade; status é derivado.** No pipeline de patrocínio:
`Alvo → Contatado → Reunião → Proposta → Fechado / Associado / Perdido`.
O ponto contra-intuitivo: **`Associado` mapeia para "recusado"** de propósito — receita de
associação não é receita de patrocínio e não pode entrar na soma de arrecadado.

**A regra da linha morta.** Estar num estágio ativo **sem** próxima-ação e data é tratado
como defeito visível (barra âmbar); com data vencida, vermelho. É disciplina de processo
codificada na interface — a origem do módulo é justamente contas que paravam sem ninguém
perceber.

**Dedup em três escopos diferentes**, e a diferença é intencional:
- convidados: unique `(evento_id, nome)` — mesmo nome pode estar em dois eventos
- base: unique **global** `(nome, empresa)` — a pessoa não duplica a cada evento importado
- envios padrão: por nome normalizado em JS (não no banco)

**LGPD — quem tem contato e quem não tem.** `evt_contatos` e `evt_convidados` guardam
e-mail (há relação com o evento). A tabela de contato do **decisor prospectado** guarda
só nome, cargo e LinkedIn — **sem e-mail nem telefone**, porque não há relação prévia. E
**CPF nunca é persistido**: o import de planilha descarta qualquer coluna que comece com
"cpf", avisando o usuário.

**Métricas são calculadas, nunca armazenadas.** Percentual do checklist, arrecadado,
pipeline, confirmados — tudo derivado na leitura. Não existe contador desnormalizado
para manter em sincronia.

**Cotas e metas vivem em `metadata` com merge.** Salvar cotas não pode apagar as metas.
Update direto do jsonb perde dado a cada gravação.

> ⚠️ **Defeito conhecido:** a função que faz backfill dos "itens de envio padrão" em
> eventos antigos grava o D-x como **texto na observação**, sem preencher o `offset`.
> Esses itens nunca ganham prazo derivado nem entram na pauta da semana. No porte,
> preencha o `offset` de verdade.

---

## 5. FRONTEND

Uma view com lista → detalhe → **8 abas** (Dados, Checklist, Programação, Painelistas,
Patrocínio, Convidados, Prospecção, Pauta).

O que merece atenção no porte:

- **`renderChecklistPlanilha`** — agrupa por área, com progresso e colapso por seção,
  esconde a coluna "categoria" (redundante com o agrupamento) e oferece um select para
  mover o item de área. Linha vencida em vermelho, ≤7 dias em âmbar.
- **`evtCell`** — renderiza a célula conforme `type` da coluna: `check`, `date`, `num`,
  `select`, `url`, texto. A coluna `prazo` mostra o **hint do prazo derivado** (`D-10·08-06`)
  quando está vazia.
- **Import/export de planilha** — SheetJS **vendorizado** no repo (`vendor/xlsx.full.min.js`,
  ~950 KB). Motivo: a versão publicada no npm/jsDelivr parou numa release antiga com CVE
  de prototype pollution; o dist oficial vem de `cdn.sheetjs.com`. Parse e geração são
  **100% no navegador** — o backend só recebe linhas já normalizadas.
- **Export `.md` do evento** — one-pager para virar arte/apresentação.

---

## 6. DEPENDÊNCIAS

**NPM:** `@supabase/supabase-js`. **Front:** SheetJS (vendorizado) só para xlsx.

**Env:** `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`. (`ANTHROPIC_API_KEY` só para o gerador
de ângulo comercial do Score — opcional e fora deste pacote.)

**Plataforma:** o módulo base é leve. Só o Score precisa de timeout longo (60 s no
original) por causa do scan de contratos.

---

## 7. O QUE TROCAR AO PORTAR

1. **Roteamento** `?type=` → REST (lembrando da exceção do `evt_get`).
2. **Autenticação** — não vem no módulo.
3. **Duas FKs opcionais** para as tabelas de pessoas/empresas do sistema de origem
   (`evt_painelistas.person_id`, `evt_patrocinadores.company_id`). **Remova-as** se não
   houver equivalente — o código já trata os campos como opcionais.
4. **O seed** (`EVT_SEED`) tem itens do domínio do cliente original — inclusive detalhes
   como as dimensões do painel de LED, que vieram dos PDFs reais de produção. Troque
   pelos seus, **mantendo o formato `{item, categoria, obs, offset}`**.
5. **Variáveis de CSS**: duas usadas pelo módulo (`--surface-2`, `--green-bright`) não
   existem no design system de origem — só funcionam pelo fallback inline. Defina-as.
6. **Score de Patrocinador**: fora do pacote (§2).

---

## 8. ORDEM SUGERIDA

1. Schema **Nível 1** + a RPC de merge.
2. `evt_list`/`evt_get`/`evt_save` + lista e detalhe.
3. **Checklist com colunas dinâmicas** + o merge atômico. ← aqui já substitui a planilha
4. Auto-dating D-x (offset + prazo derivado + cores).
5. Nível 2 (programação, painelistas, convidados) com o par genérico de sub-entidades.
6. Pipeline de patrocínio + regra da linha morta.
7. Nível 3 (base de contatos) + as duas pontes com o pipeline.
8. Import/export xlsx e a pauta da semana.

Os passos 3 e 4 são o coração: entregam sozinhos o motivo de o módulo existir.
