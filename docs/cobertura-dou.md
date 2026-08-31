# Cobertura do acervo DOU — medição de 31/08/2026

Este documento existe para o número não virar folclore. Toda afirmação aqui traz o
método, para poder ser refeita e contestada.

## Como foi medido

Comparação entre o que está em `documents` (`source_name='DOU'`) e o que o DOU
publicou, usando **a mesma função `matchAgency`** dos dois lados — ou seja, a diferença
não vem de critério de classificação.

- **Denominador**: `https://www.in.gov.br/leiturajornal?data=DD-MM-AAAA&secao=do1|do2|do3`,
  campo `jsonArray`, filtrado por `hierarchyList` via `matchAgency`.
- **Numerador**: contagem em `documents` por `published_at`.
- Só dias úteis (o DOU não circula em fim de semana).

## O que foi encontrado

### Julho/2026 — 15 dias úteis

| Agência | Banco | Publicado | Cobertura |
|---|---|---|---|
| ANTT | 30 | 377 | 8% |
| ANP | 24 | 237 | 10% |
| ANCINE | 4 | 39 | 10% |
| ANEEL | 45 | 362 | 12% |
| ANAC | 28 | 227 | 12% |
| ANM | 75 | 586 | 13% |
| ANATEL | 44 | 343 | 13% |
| ANA | 6 | 39 | 15% |
| ANVISA | 83 | 383 | 22% |
| ANTAQ | 34 | 148 | 23% |
| ANS | 14 | 59 | 24% |
| **TOTAL** | **387** | **2.800** | **14%** |

**11 dos 15 dias úteis fecharam com ZERO atos.** Só 21/07 (178), 27/07 (125), 30/07 (38)
e 31/07 (46) registraram algo.

### Acervo inteiro — 13/02/2026 a 10/08/2026, 127 dias úteis

| | |
|---|---|
| Dias úteis no intervalo | 127 |
| Vazios (0 atos) | **34 (27%)** |
| Ocupados | 93 (73%) |
| Completude média dos ocupados (amostra de 8 dias) | **81%** |

**Degradação temporal** (amostra): fev/mar a **90–97%**, mai–ago a **56–57%**.

## Conclusão

- **O acervo global está em ~72%**, não em 14%. Os 14% são de julho, o pior mês.
- **O período recente (mai–ago) estava em ~56%** — e é ele que alimenta qualquer relatório atual.
- Faltavam **~13 mil atos**: ~6.800 em dias vazios + ~6.240 em dias parciais.

> **Atualização 31/08/2026:** a Fase A recuperou **7.610 atos** e mai–ago subiu para **76%**.
> Restam os dias parciais (Fase B), bloqueada pela Camada 3.

## Causa

Não é fonte incompleta. É **ingestão que falhou em silêncio**:

1. `scripts/backfill-dou.js` capturava o erro por data, somava zero e terminava com
   `exit 0` — o workflow ficava verde ingerindo nada. *(corrigido em 31/08/2026)*
2. Não havia alarme de ausência: dia útil fechando vazio não avisava ninguém.
   *(corrigido: `scripts/checar-ingestao.js`, no workflow com `if: always()`)*

## Recuperação

| Fase | Dias | Recupera | Mecanismo | Situação |
|---|---|---|---|---|
| **A — dias vazios** | 45 (8 feriados) | **7.610 atos** | Camada 1 (particionamento temporal), risco zero | **CONCLUÍDA em 31/08/2026** |
| **B — dias parciais** | 97 | ~6.200 atos | Camada 3 (guarda textual) a 100% | **bloqueada** |

### Resultado da Fase A (31/08/2026)

`node scripts/backfill-vazios.js` — 45 dias processados, 8 sem edição (feriados),
**0 falhas, 7.610 atos inseridos**.

**Aceite 1 — dias úteis vazios restantes: 8**, e todos são feriados confirmados:
Carnaval (16–17/02), Sexta-feira Santa (03/04), Tiradentes (20–21/04), Dia do Trabalho
(01/05), Corpus Christi (04–05/06). **Zero dias recuperáveis restantes.**

**Aceite 2 — cobertura de mai–ago: 56% → 76%** (amostra de 8 dias).

| Dia | Banco | Publicado | Cobertura | |
|---|---|---|---|---|
| 2026-05-14 | 73 | 128 | 57% | parcial (Fase B) |
| 2026-06-11 | 132 | 236 | 56% | parcial (Fase B) |
| 2026-07-21 | 178 | 224 | 79% | parcial (Fase B) |
| 2026-07-27 | 125 | 218 | 57% | parcial (Fase B) |
| 2026-08-05 | 98 | 174 | 56% | parcial (Fase B) |
| **2026-08-13** | **194** | **194** | **100%** | **recuperado pela Fase A** |
| **2026-08-19** | **171** | **171** | **100%** | **recuperado pela Fase A** |
| **2026-08-25** | **220** | **220** | **100%** | **recuperado pela Fase A** |
| **TOTAL** | **1.191** | **1.565** | **76%** | |

O padrão confirma a separação das fases: **todo dia tocado pela Fase A está em 100%**;
os que seguem em 56–57% são exatamente os dias parciais que a Fase B trata. Os 76% são
a média entre os dois grupos — não um teto do método.

A Fase B está bloqueada por um motivo medido: recolher um dia já servido pelo INLABS
pela fonte pública reconhece **0 de 225** registros por `content_hash` (os ids são de
sistemas diferentes), e o título normalizado **não é chave** — 130 registros públicos
casam com 114 do banco, porque título colide dentro da própria fonte ("Despacho" repete
no mesmo dia). Até a Camada 3 estar em 100%, `persistDou` **recusa** gravar em dia já
servido por outra fonte (`PARTICAO_VIOLADA`).

## Regra de exibição

Nenhuma contagem histórica aparece na interface sem **carimbo de janela e cobertura**.
Um número de acervo sem cobertura declarada está errado por baixo e não se sabe de quanto.
