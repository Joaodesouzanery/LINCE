---
name: security-review
description: Revisão de segurança do código — OWASP, secrets, validação de input, XSS/CSP/CORS, autenticação e exposição de dados. Use ao mexer em auth, entrada de usuário, upload, query, render de HTML, endpoints, ou ao pedir "revisão de segurança".
when_to_use: Dispara ao tocar autenticação, input do usuário, dados sensíveis, rotas de API ou renderização de conteúdo externo.
---

## Foco (OWASP + práticas)

### Injeção
- SQL/NoSQL: use parâmetros/prepared statements, nunca concatene input em query.
- Comando/shell: evite; se inevitável, valide e escape rigorosamente.

### XSS (crítico em web)
- Escape TODO conteúdo externo antes de ir para HTML (`escapeHtml`).
- `href`/`src` de fonte externa: só aceite `http(s):` — bloqueie `javascript:`/`data:`.
- `innerHTML`/`dangerouslySetInnerHTML`: evite; se usar, sanitize.

### Secrets
- Nada de chave/token hardcoded ou commitado. Use env vars.
- Segredo nunca vai pro bundle do cliente. Só `service_role`/keys no servidor.
- `.env` no `.gitignore`; versione só `.env.example`.

### Input & saída
- Valide tipo, tamanho e formato na borda (servidor manda, cliente é conveniência).
- Não vaze stack trace / detalhe interno em erro pro usuário (ver [[error-handling]]).

### AuthZ/AuthN & dados
- Cheque autorização por recurso, não só autenticação.
- RLS ligado no Supabase; `service_role` só server-side.
- CORS restrito ao necessário; sem `*` em rota autenticada.

## Saída

Liste por severidade (crítico/alto/médio/baixo) com `arquivo:linha`, o risco concreto e a correção. Dual-use/pentest com autorização é ok; recuse ajuda a ataque sem contexto legítimo.
