# Pacote de extração — Módulo Financeiro (Balancete)

Tudo que é preciso para recriar o módulo noutro sistema, sem acesso ao repositório da LINCE.

```
financeiro-export/
├── LEIA-ME.md                            ← você está aqui
├── PACOTES-NPM.txt                       ← dependências (é uma só)
├── docs/
│   └── MODULO-FINANCEIRO-EXTRACAO.md     ← o guia: o que faz, como, e o que trocar
└── supabase/
    └── schema-financeiro.sql             ← DDL idempotente (2 tabelas + bucket)
```

## Comece por aqui

1. Leia o **§1 do guia** (o que o módulo faz e o fluxo do usuário) — 2 minutos.
2. Aplique o **`schema-financeiro.sql`** no seu Postgres/Supabase.
3. Siga a **ordem de implementação do §8**. Depois do passo 4 (o parser do extrato)
   o módulo já economiza tempo de verdade.

## Em uma linha

Cola-se o texto do extrato bancário; sai um Balancete com despesas numeradas, carta de
justificativa por despesa (valor por extenso), Nota Fiscal anexada e página de
assinaturas — pronto para PDF.

## O que NÃO vem junto

- **Autenticação.** O módulo assume que quem chegou pode tudo; o controle de acesso é do
  sistema hospedeiro.
- **Faturamento/contabilidade.** Não é um ERP: ele formaliza a prestação de contas, não
  faz lançamento contábil nem plano de contas.
- **Integração bancária (Open Finance).** A entrada é texto colado, de propósito — sem
  credencial de banco no sistema.

## Dois defeitos conhecidos, corrija no porte

Estão marcados com ⚠️ no guia:
1. A trava de "balancete fechado" **falha aberto** (ignora erro de leitura).
2. No parser, o lookahead de detalhe roda **antes** do teste de linha de saldo — a linha
   seguinte a um saldo é engolida.
