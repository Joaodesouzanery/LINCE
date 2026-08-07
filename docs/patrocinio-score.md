# Score de Patrocinador — análise + proposta (MVP)

> Aplicar a lógica de um motor GTM (prospecção outbound) à **captação de patrocinadores** do módulo Eventos.
> Documento de decisão: deep-research (com fontes) + tese LINCE + proposta enxuta + o que fica de fora.
> Revisado em 3 rodadas de crítica interna. **Pré-requisito: entrevista com os diretores do IRIS antes do schema.**

## Sumário executivo
Vale construir um **"Score de Patrocinador" enxuto** — **não** o motor GTM completo (fila/worker/disparo/CRM de rights não
cabem p/ fechar 10–15 patrocinadores por evento). O ouro é a **camada de score**: a LINCE já tem os sinais de fit que
ninguém tem no Brasil (contratos PNCP com os órgãos do tema, doações TSE, grafo societário, CNAE, screening). O mercado
pontua patrocinador de forma **heurística e rasa** — é **whitespace**. Proposta: um recurso na aba Patrocínio que ranqueia
empresas por fit **com evidência**, sugere cota, gera um ângulo, e alimenta o pipeline `evt_patrocinadores` que já existe.
O IRIS entra com o **relacionamento** (os ex-diretores conhecem os players); a LINCE entra com **dado + score + ângulo**.
Disparo de e-mail e deliverability ficam de fora — de propósito.

## 1. Deep-research (com fontes)
- **Como é vendido / quem decide / timing:** comprador = marketing/"partnerships" (VP Marketing/CMO), com **CFO** cada vez mais dentro (patrocínio virou "investimento em pipeline"); ciclo **curto, ancorado na data** — outbound 8–12 semanas antes, lista travada 6–8, abordagem 2–4; o "sim" depende da **densidade de ICP no evento**. ([Vendelux](https://vendelux.com/event-marketing/event-sponsorship))
- **Sinais de patrocinador provável:** overlap de público, **relacionamento existente**, **histórico de patrocínio em eventos similares**, timing (expansão/lançamento/verba), receita/porte. ([Sponsorship Collective](https://sponsorshipcollective.com/blog/ultimate-sponsorship-prospecting-formula/), [qgiv](https://www.qgiv.com/blog/prospecting-and-scoring-event-sponsorships-for-your-nonprofit/))
- **O scoring do mercado é fraco = a lacuna:** frameworks públicos param em nome/setor/headcount/contato + "categorize por receita" — **sem rubrica quantitativa com evidência**. ([qgiv](https://www.qgiv.com/blog/prospecting-and-scoring-event-sponsorships-for-your-nonprofit/), [SponsorFlo](https://www.sponsorflo.ai/blog/sponsorship-prospecting-strategies))
- **Cotas/preços:** 3–5 tiers (3–4 padrão); entrada US$1–5k, topo 3–4×; enterprise US$50–200k; precifica a 50–70% do valor entregue. **As cotas do IRIS (50/30/15k) estão na banda.** ([AnyRoad](https://blog.anyroad.com/post/event-sponsorship-packages), [i4a](https://www.i4a.com/blog/event-sponsorship-packages/))
- **Ferramentas = dois campos + buraco no meio:** CRM de patrocínio (wehave/KORE/SponsorCX) só faz **pós-venda** (rights/entregáveis 40–100/contrato, portal, renovação 90/60/30). Não fazem prospecção/scoring. ([wehave](https://www.wehave.io/insights/what-is-a-sponsorship-crm)) Dados GTM (ZoomInfo/Apollo) só **contato genérico** ([ZoomInfo](https://pipeline.zoominfo.com/sales/best-sales-pipeline-management-software-tools)). **Prospecção inteligente com dado regulatório BR não existe.**
- **Benchmarks:** ciclo B2B ~6,5 meses (deals <US$25k ~90 dias, [Glue Up](https://www.glueup.com/blog/sales-funnel-conversion-rate-benchmarks)); **80% dos leads de evento nunca recebem follow-up**; ~3,5 toques p/ fechar lead de evento vs 8+ no frio. ([Vendelux stats](https://vendelux.com/event-marketing/event-marketing-statistics))
- **Brasil / setor regulado:** captação = pesquisar empresas de público similar + histórico; p/ org **sem fins lucrativos** (o IRIS é), cabe o ângulo **fiscal/institucional**. ([Associatec](https://www.associatec.com.br/patrocinadores-para-eventos-associacao/), [Conecta](https://conectaassociacoes.com.br/patrocinio-eventos-associativos/))

## 2. Tese LINCE (por que aqui é único)
1. **Fosso de dados:** fit de patrocinador é exatamente o que a LINCE mede com dado público — quem **contrata com os órgãos do tema** (PNCP), **doa no setor** (TSE), está **próximo no grafo** dos players. Prova, não adivinha.
2. **O gap de "contato-decisor" (fraqueza da LINCE) é preenchido pelo IRIS:** ex-diretores já conhecem os players. LINCE dá **dado+score+ângulo+cota sugerida**; o IRIS dá **o relacionamento** e faz a abordagem. Disparo/deliverability ficam de fora.
3. **Whitespace real** — ninguém cruza inteligência de empresa BR com prospecção de patrocínio.

## 3. A rubrica (o coração)
**Determinística = 100 pts, só dado público** (versionada — tabela, não constante):
- **Fit ~45:** **contrato com o órgão-alvo é o EIXO** (a aresta que ninguém tem); CNAE é sinal menor e ruidoso. Evidência: ids/valores de contrato, cnae.
- **Sinal / porte ~30:** Σvalor dos contratos + **recência**. `fit+sinal vence fit sozinho ~2:1` (uma conta que acabou de fazer algo ganha de fit limpo parado). Evidência: soma, `max(signed_at)`.
- **Propensão ~25:** doações **PJ** (TSE) + proximidade no grafo. *(era "engajamento" — nome errado; isto é propensão/fit ampliado.)* Evidência: doações, arestas.
- **Evidência obrigatória:** cada categoria cita um id real (contrato/doação/aresta); **sem evidência → categoria capada a 50% + `capped`** (o "78 confiante" da spec virado invariante, não pedido de prompt).
- **Timing (camada de ação, não pontos):** tier → **semana relativa ao evento** (tier1 na janela de 10 sem, tier3 espera a de 4); **flag do ciclo orçamentário BR (out–dez)** — evento H1 abordado em fev chega tarde.
- **Guarda-corpo:** screening = **BLOQUEIO DURO** (sancionada/impedida sai; não vai a review) — **e reverificado na aprovação** (status muda entre a semana 10 e a 4).

**Relacionamento NÃO pontua.** (Tier1 começa em 80; um campo de 20 pts não puxa sozinho — e um campo à mão que pontua vira a válvula onde toda empresa que um diretor gosta ganha 20 e você nunca separa o que o dado previu do que a opinião empurrou.) → **Override manual de tier:** o operador promove a conta, gravando **quem promoveu + justificativa**, como **decisão humana** registrada, separada dos pontos.

**Cota sugerida = campo determinístico** (porte + Σcontratos → faixa recomendada), **separada do texto do ângulo** — é o que faz o operador chegar pedindo 50k em vez de 15k.

## 4. Disciplina que salva o sistema (restaurada da spec)
- **Arquivos de referência** (`won-language` / motivo-de-perda / objeção) — de **entrevista com os diretores**. É o que faz o **ângulo** sair útil em vez de genérico bem formatado; é o insumo que ninguém copia.
- **Loop de resultado:** desfecho (abordado/**respondeu**/recusou/fechou + **valor** + motivo) ligado ao score.
- **Rubrica versionada** + **snapshot de evidência (`as_of`)**: re-pontuar histórico recalcula pesos sobre a **mesma evidência**, isolando rubrica × crescimento de contracts/donations. (Sem snapshot, você atribui à rubrica um efeito que veio do banco.)
- **Golden set formal** (~25 empresas com o tier que os diretores dariam). **Calibra SÓ o determinístico** (relacionamento em branco) — senão é circular (a rubrica conteria o próprio golden). Se o dado público sozinho concorda com quem passou 10 anos no setor ⇒ fosso real. Histórico de concordância por versão de rubrica (ver se melhora).
- **Validação = indicador ANTECEDENTE:** **taxa de resposta à 1ª abordagem por tier** (chega em semanas) + **valor da cota fechada por tier** (tier3 que assina 50k > tier1 que assina 15k). **Não** "taxa de fechamento" (nunca tem significância com poucos eventos/ano). Com amostra pequena (tier pode ter n=2), **mostrar a contagem, não o % (barra suprimida se n<5)** — % sobre n=2 é ruído com cara de autoridade.

## 5. Output, supressão e governança
- **Shortlist com teto** (~10 abordagens por **cota disponível**, cortada no tier) — não ranking aberto de milhares (4.000 linhas ⇒ trabalha as 30 primeiras e esquece). Resto fica no banco, consultável.
- **Supressão entre eventos:** a mesma empresa não é requeimada em N eventos no ano. Janela **por desfecho**: 12m recusou · **permanente** opt-out · **sem supressão** para quem **fechou** (assinou = melhor prospect do próximo). Nasce no `decide` com janela curta "em abordagem" (protege entre aprovação e resposta) e é atualizada pelo desfecho.
- **Governança 10-80-10:** operador **aprova**; **evidência contratual SEMPRE visível na aprovação** (nunca colapsada) — a decisão de abordar é registrada com o operador vendo o que ela implica.

## 6. LGPD + ótica de conflito
- Empresas são públicas; **só doador PJ** (CNPJ público); **sem CPF** (o de PF já é mascarado). Contato/disparo fora de escopo.
- **Conflito de interesse:** um instituto de ex-diretores usando a pegada regulatória (contrato com o órgão) p/ prospectar patrocínio de empresas reguladas é opticamente carregado no Brasil. Defesa: dado público + **evidência sempre à vista** na aprovação + **screening como bloqueio duro** (não flag). É sinal, não juízo.

## 7. Arquitetura (não overbuildar)
O motor GTM completo (pg_cron + worker Deno/Node com SKIP LOCKED + Edge Functions + pgvector + Storage + Realtime) é p/
escala de milhares always-on — não cabe no Vercel Hobby nem na escala de seminário. Aqui:
- **Score em LOTE assíncrono com status** (síncrono estoura no 1º run real): endpoint cria um `run`, `scripts/score-sponsors.js` processa, front mostra status. Sem worker/pgmq.
- **Notas de modelagem** (aprendidas na revisão): CNPJ **sempre normalizado (dígitos) em coluna gerada** em toda chave/join/supressão; `empresa_key` **sempre = CNPJ normalizado** (resolve `company_id → companies.cnpj` no sourcing; fallback a company_id só p/ quem não tem CNPJ) — senão dá duplicata silenciosa entre runs; unique **por run** (permite re-pontuar); re-score = **run novo com `rescore_of`** apontando o original (a tela lê o run corrente); o **ângulo grava `angulo_fontes`** (ref_notes + evidência injetadas — diagnóstico da única etapa não determinística).
- Reusa `contracts`/`companies`/`relationships`/`campaign_donations`/screening + `lib/anthropic` (ângulo gated) + o pipeline `evt_patrocinadores`.

## 8. Ordem de construção
0. **Entrevista com os diretores do IRIS — ANTES do schema.** Alimenta golden set + arquivos de referência, e **pode revelar um critério que não está na rubrica**. Barato descobrir antes; caro depois. (A rubrica é versionada/tabela, então o código não muda — mas os pesos/eixos saem daqui.)
1. **Score determinístico** (rubrica versionada + evidência + timing + screening-bloqueio + cota sugerida).
2. **Loop de resultado** (desfecho + validação por tier) — **antes de qualquer ângulo**.
3. **Golden set formal** + calibrar (só o determinístico).
4. **Ângulo Claude por ÚLTIMO**, alimentado pelos arquivos de referência (mesma conversa). É a cereja e a parte que degrada em silêncio sem o passo 3 — sai fluente, plausível, e não convence quem já ouviu dez propostas de cota.

## 9. Fora de escopo (deliberado)
Motor de fila/worker (pgmq/Deno) · disparo de e-mail + deliverability (SPF/DKIM/warmup) · CRM de rights/entregáveis/renovação (à la wehave) · roteamento multi-modelo · prospecção de convidados/painelistas.

---
*Fontes web citadas inline. Deliverable de decisão — a implementação segue o plano F-EVT4.*
