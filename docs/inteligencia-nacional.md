# Inteligência Nacional — diagnóstico e plano (F-INT1)

> Auditoria transversal dos módulos de inteligência (Inteligência Nacional, Radar, Monitor DOU, Grafo,
> Monitores, Consultas, Agenda, Agenda Regulatória, Legislativo) e das conexões com Dossiês e Painéis.
> Três auditorias read-only (métricas · processos · conexões). Decisões: 4 frentes aprovadas; fórmulas
> na filosofia **"honestas e simples"** (renomear volume, expor truncamento, separar componentes, agregar R$).

## 1. Mapa de frescor (o que atualiza sozinho e o que envelhece em silêncio)

**Automatizado:** DOU diário (cron Vercel 12h UTC) + reprocessa atos de pessoal (12h30) · votos do colegiado
diário (Actions) · QSA incremental diário · eventos/pauta da Câmara + digest de painéis diário ·
parlamentares/proposições/votações/comissões **semanal** (segunda).

**SEM automação (congela na data do último run manual):** `ingest:pncp` (**contratos** — alimentam grafo,
radar, giratória, score de patrocinador), `load:agenda` (agenda regulatória formal), `backfill:themes` (temas),
`load:tse-*` (doações/bens/filiação), `load:tcu` (jurisprudence), `load:receita-socio`, `score:sponsors`.
Único indicador de frescor na UI é o pill do DOU (`app.js:5899`); PNCP parado há meses é indistinguível de
PNCP de ontem.

## 2. Bugs de precisão — dado ERRADO na tela hoje (Frente 1)

| # | Onde | Problema |
|---|---|---|
| 1 | `intelligence.js:452` + `app.js:5241` | **Resumo diário trunca em 50 atos** e exibe contagens por agência como se fossem o total do dia; `truncated` calculado e ignorado pelo front |
| 2 | `intelligence.js:404-405` | **trend**: `limit(5000)` com ordem ASCENDENTE corta os dias **mais recentes** — a curva "cai" artificialmente; total do dashboard = janela truncada |
| 3 | `intelligence.js:600` | **giratoria**: dedup por pessoa avalia só o 1º mandato em ordem arbitrária — pode descartar exatamente o mandato com self-dealing; `contract_during_mandate` calculado mas não altera severity; **e o front nunca chama `type=giratoria`** (o Radar usa a versão fraca que marca "porta giratória" p/ qualquer sócio de MEI) |
| 4 | `intelligence.js:2208/2295/2460/2623` | **`/ativ/i` casa "INATIVA"** — empresa inativa passa como ativa em 4 verificações (political_risk, radar_intel, correlações regra 2) |
| 5 | `intelligence.js:646-670` | **agency_stats**: "alertas abertos" capado em 5 (`.limit(5)` + `.length`); contagens sem filtro `source_name='DOU'`; baseline calculado diferente do motor de anomalias (semanas zeradas fora, semana parcial dentro) — duas telas, dois números, mesmo rótulo |
| 6 | `intelligence.js:534` + `app.js:5215-5231` | **radar 30/60/90**: mistura UTC/local nas fronteiras dos baldes; card de MANDATO diz "Fornecedor nao identificado" e rodapé `PNCP//`; limit 500 sem flag |
| 7 | `app.js:5201` | Front mostra `docs` (total histórico) ao lado do score construído com `docs_90d` — números não relacionados lado a lado |
| 8 | `app.js:4166` + `lib/ingest.js:144-148` | **Monitor por CNPJ é decorativo**: a UI ensina a digitar CNPJ mas o front nunca envia `cpf_cnpj` — o padrão normalizado ("12 345 678...") jamais casa com texto. E o matching é substring pura: sem fronteira de palavra ("ANA" casa "ANALISE") e sem `normalizeNameKey` ("SILVA, RICARDO" não casa "Ricardo Silva") |
| 9 | `api/dou-feed.js:16,37-40` | **Filtro de agência do DOU quebrado**: filtra em JS DEPOIS do `limit(100)` — agência de menor volume devolve vazio mesmo com atos na base |
| 10 | `api/graph.js:179-343` | **Grafo não-reproduzível**: `limit` por tabela SEM `order()` (dois requests idênticos → grafos diferentes); `truncated` só olha `relationships`; `safe()` engole erro e a camada some sem marca |
| 11 | `app.js:3914-3933` | Badges do Radar contam o array completo; as listas renderizam `slice(0,20)`/`slice(0,15)` — "47 conexões" com 20 na tela, sem indicação |
| 12 | `intelligence.js:2434,2517` | **correlations**: regra 1 sem dedup (pessoa com 6 empresas = 6 cards high idênticos, empurram o resto p/ fora do corte); regra 4 rotula o card com o nome do MONITOR como se fosse pessoa; sem dedup entre regras |
| 13 | `app.js:5257` + `api/rss-feeds.js:255-299` | Consultas/Agenda: fallback-DOU invisível (o front não lê `data.source`) — o usuário não sabe que está vendo títulos do DOU, não consultas abertas |

## 3. Fórmulas enganosas (Frente 2 — filosofia "honesta e simples")

- **Score de agência = volume disfarçado de risco** (`intelligence.js:466-511`): `docs_90d` domina; min-max
  entre agências garante sempre um 100 e um 0 (não comparável entre execuções); o componente "alertas" é na
  prática o contador da palavra "multa" (substring crua, severity high, `lib/ingest.js:98-108`) — e os alertas
  de pessoa (nomeação/exoneração) nunca são contados no bucket da agência. → **Dividir em "Atividade (90d)" ×
  "Sinais de risco"**, sem min-max escondido, janela visível, sanção com word boundary.
- **Nenhuma métrica agrega R$**: `contracts.value` existe e é carregado em vários pontos; contrato de R$ 2 mil
  pesa igual a R$ 200 mi em tudo. → total a vencer por agência, ordenar oportunidades por valor.
- **political_risk** (`intelligence.js:2177-2255`): `party_links.length*15` (2 filiações antigas = teto),
  `amount` carregado e ignorado, `campaign_donations` (a tabela boa) não consultada, sem decaimento temporal,
  self-dealing sem overlap temporal (contrato de 2015 × mandato de 2022 pontua), label `porta_giratoria`
  existe no front e nunca é emitido. → doações reais com decaimento, overlap exigido, patrimônio com evolução.
- **Anomalias** (`weeklyAgencyAnalysis`): semana PARCIAL comparada com semanas completas (o patch `midweek` é
  curativo); `2x` fixo sem desvio (baseline 3±3 dispara sempre; 200±5 nunca); só `current===0` conta como
  silêncio. → pro-rata da semana parcial nesta leva; z-score/MAD fica p/ leva 2 com calibração.
- **radar_intel**: "risco" = ter CNPJ (1 regra); consultas via `%audi%` (casa "auditoria"/"audiovisual") em vez
  do FTS `search_tsv` que já existe. → usar o motor da giratória corrigida + FTS.
- **Correlações não persistem**: recalculadas a cada request, nunca viram `alerts`, nunca notificam (o webhook
  só recebe alertas da tabela). Alertas antigos não expiram (contam no score p/ sempre).

## 4. Dado que existe e não conversa (Frente 3)

- **`jurisprudence` (TCU/CADE) é write-only** — zero SELECTs no repo. FKs prontas p/ empresa e agência.
- **Dossiê de pessoa** não mostra: atos do DOU que a citam (a origem do mandato!), contratos das empresas dela
  (o join já existe no political_risk), pauta das proposições de autoria.
- **Dossiê de empresa** não mostra: doações onde ela é DOADORA (`donor_document` indexado), jurisprudence,
  mandatos de sócios (metade inversa da porta giratória). **Contraparte** do Gerador não mostra contratos.
- **DOU → dossiê**: entidades resolvidas na ingestão viram pills MORTAS no feed (`app.js:1370`); aresta
  `mentions` existe no enum e nunca é escrita (8 de 11 kinds nunca escritos; grafo BFS usa `owns` = código morto).
- **Painéis não recebem nada da inteligência**: anomalias/contratos-a-vencer/consultas dos órgãos do painel
  (motores prontos), comissão×pauta (`body_memberships.orgao_sigla` × `evento_pauta.orgao_sigla` — "seu
  stakeholder preside o colegiado que vota sua proposição"), `item_kind` evento/monitor aceito e não hidratado.
- **Votação legislativa**: endpoints `votos_leg_*` prontos (`intelligence.js:324`) e o front NUNCA os chama.
- **Legislativo**: o acervo persistido (proposições/votações/pauta) nunca aparece — a view abre vazia pedindo
  busca; o bloco de histórico do backend é código morto pelo front.
- **Gerador**: `person_id` vem no payload dos decisores/riscos e o render descarta; risks×directors é a mesma
  lista duplicada (double-counting no prompt da IA).

## 5. Plano (4 frentes, nesta ordem)

1. **F1 · Correções de precisão** — os 13 itens da tabela acima. Muda o que o usuário JÁ vê.
2. **F4 · Processos** — workflow `inteligencia.yml` (PNCP diário, temas diário, agenda semanal, TSE mensal);
   **frescor por fonte** no dashboard (via `data_health`); backfill de monitores ao criar (hoje monitor novo só
   vale amanhã) + matcher no backfill-dou; matcher sobre proposições/contratos; agenda regulatória com
   histórico de status (hoje delete+insert destrói a transição); dedup entre as 3 abas de agenda; contagem de
   atos descartados na ingestão.
3. **F2 · Métricas honestas** — score dividido, R$ agregado, political_risk com doações+decaimento+overlap,
   radar com giratória boa + FTS, pro-rata na semana parcial, correlações críticas persistidas em `alerts`
   (webhook) com TTL. *Fórmulas novas passam por revisão de domínio antes do commit.*
4. **F3 · Conexões** — DOU→dossiê + `mentions`; jurisprudence ligada (dossiês, gerador, political_risk);
   dossiês enriquecidos; contraparte com contratos; gerador→dossiê + dedup; painéis alimentados pela
   inteligência + comissão×pauta; votação legislativa com UI; Legislativo abrindo com acervo; consultas/agenda
   com ações (+painel/+monitor); grafo com comissões/autoria/contratos-no-modo-nó.

**Fora desta leva:** z-score/MAD e pesos em tabela versionada (leva 2, calibrada); e-mail de monitores
(Resend); Senado nas votações nominais; OCR.

---
*Referências de linha correspondem ao estado do repo na data deste documento; ver git blame em caso de drift.*
