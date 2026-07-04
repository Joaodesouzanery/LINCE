---
name: documentation-lookup
description: Consulte a documentação oficial antes de assumir assinatura de API, opção de config, comportamento de lib ou limite de plataforma. Use ao integrar uma lib/serviço novo, ao não ter certeza de um parâmetro, ou antes de afirmar "a API faz X".
when_to_use: Dispara ao usar API/lib/serviço cujo comportamento exato você não tem certeza.
---

## Regra

Não invente API. Verifique antes de escrever contra ela — chute custa retrabalho e bug sutil.

## Passos

1. **Fonte primária primeiro**: doc oficial da lib/serviço, versão que o projeto usa (confira `package.json`).
2. **Confirme a assinatura**: nome, ordem/tipo dos parâmetros, retorno, erros lançados, se é async.
3. **Limites e cotas**: rate limit, tamanho máximo, paginação, plano (ex.: teto de funções/crons do provedor).
4. **Exemplos oficiais** > posts aleatórios. Cuidado com resposta desatualizada de versão antiga.
5. Se a doc contradiz sua memória, **a doc vence**. Cite de onde tirou.

## Para modelos/LLM da Anthropic

Não responda de memória sobre modelos, preços, limites, tool use ou caching da Anthropic — consulte a referência oficial (há uma skill dedicada `claude-api` no ambiente). IDs mudam entre versões.

## Boas práticas

- Prefira a versão exata instalada; comportamento muda entre majors.
- Anote no código/PR a decisão baseada em doc quando não for óbvia.
- Sem acesso à doc? Diga que é suposição e marque para confirmar — não afirme como fato.
