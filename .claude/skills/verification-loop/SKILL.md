---
name: verification-loop
description: Antes de dar uma tarefa como concluída, verifique de verdade — rode o código, os testes, o lint/typecheck e observe o comportamento real. Use ao finalizar qualquer mudança, antes de dizer "pronto/funciona", antes de commit ou PR.
when_to_use: Dispara ao encerrar uma implementação ou correção, antes de reportar sucesso.
---

## Regra de ouro

"Deve funcionar" não é verificação. Verificar é **executar e observar**.

## Checklist antes de dizer "pronto"

1. **Roda?** Execute o app/função no caminho que você mudou e observe a saída real.
2. **Testes** passam? Rode a suíte (não só o arquivo que mexeu). Reporte números.
3. **Lint / typecheck / build** limpos? Rode e cole o resultado.
4. **Caso de borda** que você mudou: teste vazio/erro/limite, não só o feliz.
5. **Regressão**: o que estava funcionando continua? (fluxo adjacente)
6. **Sem ruído**: nenhum `console.log` de debug, TODO solto, código morto.

## Honestidade no report

- Se um teste falha, **diga** com a saída — não esconda.
- Se pulou um passo (ex.: não deu pra rodar E2E), **diga qual e por quê**.
- Só afirme "verificado" o que você realmente executou. Distinga "rodei e vi" de "revisei o código".

## Para web/serverless (stack do repo)

- Consulta real por CNPJ/endpoint no deploy ou local; confira status HTTP e corpo.
- Estados de UI: loading, vazio e erro — todos renderizam sem quebrar.
- `node --check` nos arquivos JS alterados quando não há build.
