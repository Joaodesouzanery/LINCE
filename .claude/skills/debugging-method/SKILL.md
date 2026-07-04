---
name: debugging-method
description: Método de depuração disciplinado — reproduzir, isolar, formular hipótese, testar, corrigir a causa raiz (não o sintoma). Use ao investigar bug, comportamento inesperado, teste vermelho intermitente ou "não sei por que isso quebra".
when_to_use: Dispara ao diagnosticar falha, erro em runtime, ou resultado inesperado.
---

## Método

1. **Reproduza** de forma confiável. Sem repro, você está adivinhando. Anote os passos exatos e o resultado observado vs esperado.
2. **Isole**: reduza ao menor caso que ainda falha. Bissecção — desligue metades até achar a origem. `git bisect` se regressão.
3. **Hipótese única**: formule UMA causa provável e como confirmá-la. Não mude cinco coisas de uma vez.
4. **Confirme com evidência**: log direcionado, breakpoint, ou um teste que expõe o bug (ver [[tdd-workflow]]). Leia a mensagem/stack de verdade — a resposta costuma estar lá.
5. **Corrija a causa**, não o sintoma. Se só some o erro sem entender por quê, você mascarou.
6. **Regressão**: adicione teste que falharia com o bug antigo. Rode a suíte (ver [[verification-loop]]).

## Táticas

- Erro em produção sem repro local: compare ambiente (env vars, versão, dado real).
- Intermitente: suspeite de tempo/ordem/estado compartilhado/rede.
- "Funciona na minha máquina": isole a diferença de ambiente, não ignore.
- Cheque suposições primeiro: o dado é o que você acha? a função é chamada? o valor chega?

## Não faça

- Trocar código no escuro até "parar de dar erro".
- Silenciar o erro com try/catch para o sintoma sumir (ver [[error-handling]]).
