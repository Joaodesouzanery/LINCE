---
name: search-first
description: Antes de escrever código novo, procure soluções, utilitários, helpers e padrões que já existem no repositório ou em libs já instaladas. Use ao iniciar qualquer feature, ao "criar uma função para X", ao adicionar dependência, ou quando sentir que está reinventando algo.
when_to_use: Dispara ao começar uma tarefa de implementação, antes de criar um novo arquivo/função/dependência.
---

## Regra

Não escreva do zero antes de confirmar que já não existe. Reusar > recriar.

## Passos

1. **Grepe o repo** pelo conceito e por nomes prováveis (`onlyDigits`, `escapeHtml`, `formatCnpj`, `requestJson`...). Procure em `lib/`, `utils/`, `helpers/`, `common/`.
2. **Veja as dependências já instaladas** (`package.json`) antes de adicionar uma nova. Uma dep nova é dívida: bundle, cold start, superfície de segurança.
3. **Cheque os padrões vizinhos**: como o código ao lado resolve o mesmo problema (fetch, erro, estado, estilo). Siga o padrão existente.
4. Se achar algo reutilizável, **estenda/parametrize** em vez de duplicar.
5. Só escreva novo quando confirmar que (a) não existe e (b) nenhuma opção existente serve com pequeno ajuste.

## Sinais de que você está reinventando

- Uma função utilitária "genérica" (formatação, validação, slug, debounce) — quase sempre já existe.
- Copiar-colar de outro arquivo com pequenas mudanças → extraia e reuse.
- Adicionar lib para algo que a linguagem/stdlib já faz.

## Saída esperada

Antes de codar, diga em 1 linha: "reusando `X` de `caminho`" ou "não existe equivalente, criando novo porque ...".
