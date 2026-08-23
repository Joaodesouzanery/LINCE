# Pacote de extração — Módulo Eventos

Tudo que é preciso para recriar o módulo noutro sistema, sem acesso ao repositório da LINCE.

```
eventos-export/
├── LEIA-ME.md                         ← você está aqui
├── PACOTES-NPM.txt
├── docs/
│   └── MODULO-EVENTOS-EXTRACAO.md     ← o guia completo
└── supabase/
    └── schema-eventos.sql             ← DDL idempotente, separado em 3 níveis
```

## Comece por aqui

1. Leia o **§1 do guia** — em especial "a planilha vira dado, sem virar rigidez" e o
   auto-dating D-x. São as duas ideias que fazem o módulo valer.
2. Aplique o **Nível 1** do `schema-eventos.sql` (2 tabelas + 1 função).
3. Siga a **ordem do §8**. Os passos 3 e 4 já entregam o valor central.

## Em uma linha

Substitui a planilha compartilhada da produção de um evento por um sistema que mantém a
flexibilidade dela (colunas criadas pelo usuário) e acrescenta o que planilha não faz:
cronograma que se re-data sozinho, pipeline com próxima-ação obrigatória e uma base de
contatos que sobrevive ao evento.

## Os três níveis — porte só o que usar

| Nível | Tabelas | Entrega |
|---|---|---|
| **1 — núcleo** | `evt_eventos`, `evt_checklist_itens` + RPC | Checklist-planilha por área, com prazo derivado |
| **2 — produção** | programação, painelistas, patrocinadores, convidados | O evento inteiro |
| **3 — relacional** | `evt_contatos` | Base cross-evento (funil de associados) |

## O que NÃO vem junto

- **O "Score de Patrocinador"** (7 tabelas + 14 endpoints). Ele pontua empresas usando
  contratos públicos, doações eleitorais e grafo societário — sem essa base de dados
  regulatórios não faz sentido. Explicado no §2 do guia.
- **Autenticação.** É do sistema hospedeiro.
- **Envio de e-mail/convite.** O módulo organiza; não dispara nada.

## Dois pontos de atenção, marcados com ⚠️ no guia

1. `evt_get` é a **única** operação que não aceita payload no corpo — só query string.
2. O backfill de "itens de envio padrão" grava o D-x como texto, sem preencher o `offset`:
   esses itens não ganham prazo derivado. Corrija no porte.
