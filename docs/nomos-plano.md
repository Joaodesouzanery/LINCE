# LINCE como NOMOS — Blueprint de Painéis Curados

> Documento de produto. Objetivo: transformar a LINCE no equivalente ao NOMOS
> (nomosapp.com.br) como **produto de painéis curados / white-label**, comandado
> pelo time (staff cura e alimenta; cliente consome painel read-only + alertas).

## Tese
Virar o NOMOS **não é um produto novo** — é uma **camada fina de curadoria sobre
motores que já rodam**. O coração é o **Painel**: o time cura um painel por
tema/cliente que agrega proposições, stakeholders, órgãos e eventos. Esse objeto
espelha **1:1** o CRUD de monitores que a LINCE já tem (`monitor_*` em
`api/intelligence.js`) e cada item é hidratado por endpoints já no ar
(`enrichProposicoes`, `dossier-person`, agenda). O perfil de stakeholder do NOMOS
(propostas + votos + fidelidade) **já foi construído** no módulo legislativo (M20).

## Modelo — comando central
A LINCE continua o **motor privado**. O cliente recebe um **painel read-only** +
alertas, curado pelo time. Não é entregar a ferramenta crua — é entregar o
resultado, sob comando. Encaixa na Auth + RLS que já existe (dono do painel,
papéis, compartilhamento).

```
Seu time  ──cura──►  Motor LINCE  ──vigia/hidrata──►  Cliente (read-only)
importa PLs         tramitação, votos,               vê só o painel dele
prioriza/tags       patrimônio, vínculos,            recebe alertas
monitora            agenda, alertas                  não comanda nada
```

## NOMOS × LINCE hoje
| Feature NOMOS | LINCE hoje | O que falta |
|---|---|---|
| Perfil de stakeholder (propostas + votos + fidelidade) | ✅ pronto (M20) | comissões, discursos, rede social |
| Proposição: tramitação, situação, autor | ✅ pronto (M20) | — |
| **Painel** (agrega + curadoria por item) | ❌ falta | o objeto painel + painel_items (**F1**) |
| Importar proposições por lista | 🟡 busca existe | parse + resolve + confirmar (**F1/F2**) |
| Alertas (e-mail/in-app, tempo real/diário) | 🟡 webhook | e-mail (Resend) + frequência (**F3**) |
| Agenda do Congresso ("sua proposição na pauta") | 🟡 agenda de agências | eventos Câmara/Senado × painel (**F4**) |
| Relatórios do painel | 🟡 PDF de dossiê | relatório consolidado (**F3**) |
| White-label (painéis por cliente, papéis) | ❌ falta | painel_membros + read-only (**F5**) |
| Fontes (estaduais, redes, discursos, 53 notícias) | 🟡 DOU/PNCP/TSE/agências | notícias + estaduais (**F7**); X é pago |
| Sentinela (assistente de IA) | ❌ falta | Bloco H / **F8** — opcional, no fim |

## O diferencial (por que não é um clone)
O painel do NOMOS só **agrega** (proposição/stakeholder/órgão/evento). O painel da
LINCE agrega **e aprofunda**: como o parlamentar é apenas uma `people`, clicar num
stakeholder do painel já abre o dossiê investigativo — **patrimônio (TSE), rede
societária (QSA), porta-giratória/self-dealing e doações de campanha**. "Acompanhe
o PL X" vira "acompanhe o PL X, quem o propôs, o que possui, como vota e quem o
financia". Nenhum concorrente cruza monitoramento com essa camada.

## Plano em 8 fases
Ordenado por valor/dependência. **F1 (Painel Core) é a fundação de que quase tudo
depende.** Cada fase reaproveita motores existentes e respeita as travas do Hobby
(sem novo `api/*.js`; ingestão via GitHub Actions).

- **F1 — Painel Core (coração):** tabelas `paineis` + `painel_items`; ~9 types
  multiplexados em `intelligence.js` (painel_list/get/save/delete + item_add/
  update/remove + import_resolve/confirm), molde `monitor_*`; hidratação
  polimórfica; **um módulo "Painéis" na sidebar** com abas (Dados Gerais /
  Proposições / Stakeholders / Órgãos / Eventos).
- **F2 — Import por lista:** colar "PEC 42/2024" → resolver por número/ano →
  confirmar (determinístico). *(Incorporado à F1 para o painel nascer usável.)*
- **F3 — Alertas + relatório por painel:** `lib/mailer.js` (Resend, gated) +
  frequência/canal por painel + relatório PDF. Reusa o matcher do cron +
  `lib/notify` + `buildPrintDoc`.
- **F4 — Agenda do Congresso:** `legislative_eventos` (Câmara `/eventos`) ×
  `painel_items(proposição)` = "sua proposição está na pauta".
- **F5 — White-label:** `painel_membros` + papéis + read-only por cliente
  (Supabase Auth/RLS).
- **F6 — Stakeholder completo:** comissões, discursos, rede social. *(Comissões +
  discursos incorporados à Rodada 1; rede social/X é pago → adiar.)*
- **F7 — Breadth de fontes:** notícias curadas + estaduais (`esfera/uf`). X fica
  fora (pago).
- **F8 — IA (Sentinela):** resumo de painel / digest de notícias — opcional, no
  fim, degradando sem chave.

## Restrições (não-negociáveis)
- **Vercel Hobby · 12/12 funções:** zero novo `api/*.js`. Todo endpoint novo
  multiplexa em `api/intelligence.js` (como `votos_*` e `monitor_*`).
- **2/2 crons Vercel:** toda ingestão nova vai para **GitHub Actions**.
- **Um modelo único:** `paineis` + `painel_items`. Vínculo painel↔alerta é
  `painel_items(item_kind='monitor')`.
- **IA só no fim** (F8, opcional, degrada sem chave). **LGPD:** CPF nunca
  persistido (mascarado); vínculos por `person_id`; match por nome com flag de
  homônimo.
- **Fora do MVP:** X/Twitter (API paga) e proposições/diários estaduais em escala
  (fonte fragmentada) — entram fatiados, por valor, depois do núcleo.

## Estado de execução
- **Rodada 1 (em andamento):** F1 (Painel Core) + fechar lacunas do stakeholder
  (fidelidade real, comissões, discursos). Schema M21.
- Cada fase: revisão adversarial (Workflow) → corrigir → commit+deploy.
