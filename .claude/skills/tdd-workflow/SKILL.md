---
name: tdd-workflow
description: Desenvolvimento guiado por testes — escreva o teste que falha antes do código que passa (red-green-refactor). Use ao implementar lógica de negócio, corrigir bug (teste que reproduz primeiro), ou quando pedir "com testes"/"TDD".
when_to_use: Dispara ao criar/alterar lógica testável ou ao corrigir um bug reproduzível.
---

## Ciclo (red → green → refactor)

1. **Red**: escreva o menor teste que captura o comportamento desejado. Rode e veja falhar (prova que o teste testa algo).
2. **Green**: escreva o mínimo de código para passar. Sem generalizar além do necessário.
3. **Refactor**: limpe com os testes verdes te protegendo. Rode de novo.

## O que testar

- **Caminho feliz** + **casos de borda** (vazio, nulo, limites, duplicado, entrada inválida).
- **Bugs**: comece pelo teste que reproduz o bug; ele vira teste de regressão.
- Contrato público (entrada→saída), não detalhe interno.

## Pirâmide

- **Unit** (maioria): funções puras, rápido.
- **Integração**: módulos + I/O real (banco, API) onde importa.
- **E2E** (poucos): fluxos críticos ponta-a-ponta.

## Regras

- Nunca marque tarefa como pronta com teste vermelho ou pulado sem dizer.
- Não ajuste o teste para passar escondendo bug — corrija o código.
- Teste determinístico: sem depender de relógio/rede/ordem. Injete dependências.
- Se o projeto não tem runner de teste, proponha um antes; não finja cobertura.

Feche sempre com o [[verification-loop]] rodando a suíte de verdade.
