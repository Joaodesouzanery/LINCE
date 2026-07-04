---
name: error-handling
description: Tratamento de erro consistente — falhar alto, nunca engolir exceção, mensagens úteis e degradação graciosa. Use ao escrever try/catch, chamadas async/fetch, integração com API/banco, ou ao ver catch vazio / erro silencioso.
when_to_use: Dispara ao lidar com operações que podem falhar (I/O, rede, parsing, async).
---

## Princípios

1. **Falhe alto, cedo e claro.** Erro engolido é bug que aparece longe da causa.
2. **Nunca `catch {}` vazio.** Se capturar, faça algo: logar, converter, propagar.
3. **Distinga erro esperado de inesperado.** Esperado (404, input inválido) → trate e siga. Inesperado → não mascare.
4. **Mensagem útil.** Diga o que falhou e o próximo passo — sem vazar stack/segredo pro usuário.

## Padrões

- `Promise.allSettled` quando falhas parciais são aceitáveis (uma fonte cai, o resto segue).
- Degradação graciosa: sem credencial/dado, mostre estado "sem dado/pendente" — não tela branca.
- Timeout e/ou retry com backoff em rede transiente; distinga transiente de fatal.
- Erro de fronteira (API handler): retorne status coerente (400 input, 401/403 auth, 404 ausente, 5xx interno) e JSON `{ ok:false, error }` consistente.
- Valide antes de usar: `const x = arr.find(...); if (!x) return;`.

## Anti-padrões (procure e corrija)

- `catch(e){}` ou `catch(e){ /* ignore */ }`.
- `.catch(() => {})` que esconde falha real (ver [[silent-failure-hunter]] agent).
- Logar e continuar como se nada tivesse acontecido quando o estado ficou inválido.
- Mensagem genérica ("algo deu errado") sem contexto pra depurar.
