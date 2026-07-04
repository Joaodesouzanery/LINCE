---
name: frontend-and-react-patterns
description: Padrões de frontend (HTML/CSS/JS e React) — estados loading/empty/error, acessibilidade (ARIA/teclado/contraste/foco), escape de HTML contra XSS, e performance de render. Use ao construir UI, componentes, telas, ou revisar frontend.
when_to_use: Dispara ao criar/alterar interface, componentes React, ou markup/estilo.
---

## Estados (nunca esqueça os 3)

- **Loading**: feedback visível durante fetch (spinner/skeleton), não tela congelada.
- **Empty**: diga por que está vazio (sem busca? sem resultado? sem credencial?) — mensagem específica, não genérica.
- **Error**: mensagem útil + ação; degrade em vez de quebrar (ver [[error-handling]]).

## Acessibilidade (a11y)

- Elementos interativos são `button`/`a` reais (ou com `role` + `tabindex` + handler de teclado).
- `aria-label`/`alt` onde o texto não é óbvio; foco visível; ordem de tabulação lógica.
- Contraste suficiente (texto ≥ 4.5:1); não comunique só por cor.

## Segurança de render (crítico)

- **Escape TODO conteúdo externo** antes de injetar em HTML (`escapeHtml`); nada de `innerHTML` com dado de terceiro sem sanitizar.
- `href`/`src` externos: só `http(s):` (ver [[security-review]]).

## Performance

- React: `key` estável em listas; memoize (`useMemo`/`memo`) trabalho caro; evite recriar handlers/objetos em render quente.
- Vanilla: throttle/`requestAnimationFrame` em eventos de alta frequência (scroll/pointermove/resize); não re-renderize o DOM inteiro a cada pixel.
- Lazy-load do que é pesado e não crítico; imagens dimensionadas.

## Consistência

- Reutilize componentes/utilitários existentes (ver [[search-first]]); siga o design system/tokens do projeto.
