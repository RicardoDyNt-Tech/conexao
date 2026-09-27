# Handoff — Conexão

> Estado no commit `76efb17` (branch `claude/new-session-turxww`). Leia junto com `CLAUDE.md`
> (regras), `docs/plano.md` (plano e fases) e `docs/fontes.md` (fontes, achados e incidentes).

## 1. Resumo

App pessoal (Ricardo e Caroline, dois Androids) para achar ônibus **Feira de Santana ⇄ Catu (BA)
com 1 conexão**, via Alagoinhas ou Salvador, combinando os dois trechos em **qualquer horário**, e
não só as poucas conexões prontas que os sites vendem.

- **Coletor** (Node + Playwright, no PC Windows do Ricardo): abre as páginas públicas da ClickBus e
  do Quero Passagem e lê o JSON que a própria página recebe. Grava no Supabase.
- **Banco** (Supabase free, projeto `conexao`, ref `sknunyuvrjngmrvcsaly`): viagens, cruzamento de
  horários em SQL, status do coletor, pedidos "atualizar agora" e alertas.
- **App** (PWA React, no ar em `https://conexao.servorico.workers.dev`): busca, combinações, "monte
  você mesmo", alertas e status. Usa só a anon key + RLS.
- **Telegram**: avisos de bloqueio/falha do coletor e alertas de preço/lugares.

Custo zero, sem LLM no runtime, nada da infraestrutura da AutoLabs.

## 2. Situação agora

| Item | Estado |
|---|---|
| Fase 1 — coletor ClickBus | ✅ pronta; gate passou em 26/09/2026 |
| Fase 2 — banco e cruzamento | ✅ validada |
| Fase 3 — agendamento, "atualizar agora", Telegram | ✅ (`notify:test` ok) |
| Fase 4 — app PWA | ✅ no ar (`conexao.servorico.workers.dev`) |
| Fase 5a — Quero Passagem como 2ª fonte | ✅ validada com coleta real (10/10 e 12/10) |
| Fase 5b — datas monitoradas e alertas | ✅ código pronto e testado; **aplicação e teste real pendentes** |
| Fase 5c — sites da Rota e da Cidade Sol como fontes | 🔄 Parte 1 (spike) pronta e ensaiada; **rodar no PC** |
| Fase 5 — calendário de menor preço | ⏳ não começado |
| Etapa 2 — qualquer rota | ⏳ depois |

**Operação:**
- **ClickBus bloqueou o IP do Ricardo** (site inteiro 403, até no Chrome normal) depois de ~100
  páginas numa noite de testes. A **tarefa agendada está desativada** (`Disable-ScheduledTask`) até
  o site voltar a abrir no Chrome normal.
- **Quero Passagem funciona**: spike e 1ª coleta real (16 páginas) sem bloqueio.
- Os dados de 10/10 e 12/10 no banco vêm só do QP.

**Migrations aplicadas no remoto** (confirme com `npx supabase@latest migration list`):

| Migration | Aplicada? |
|---|---|
| `20260927000100_schema` a `20261001000100_app_status` | ✅ |
| `20261002000100_multi_source` | ✅ (as buscas já mostram a fonte) |
| `20261003000100_watched_dates` | ❓ não confirmado |
| `20261004000100_min_layover_20` | ❓ não confirmado |
| `20261005000100_watch_time_window` | ❓ não confirmado |

Sem as três últimas, a tela **Alertas** do app dá erro e a folga mínima continua em 60 min.

## 3. Arquitetura

```
PC do Ricardo (Windows)                      Supabase (conexao)                 Celulares
─────────────────────────                    ───────────────────                ─────────
Agendador de Tarefas 07:00                   tabelas + RLS                      PWA (React)
  run-scheduled.ps1                          trips, trips_best (view)           anon key + RLS
   1. collect --legs all --days 5 --watched  find_connections()      ◄───────── busca, combinações
   2. worker --once   (pedidos do app)       find_second_legs()                 monte você mesmo
   3. alerts          (Telegram)             date_coverage()                    alertas, status
npm run worker (opcional, fica ouvindo) ──►  collector_status()                 "atualizar agora"
Chrome + perfil persistente (Playwright)     watch_status(), evaluate_…()       ──► collect_requests
   ClickBus: /web/api/v6/trips               collect_requests (Realtime)
   Quero Passagem: /search/{JWT} por GDS     watched_dates
Telegram Bot API ◄── avisos
```

## 4. Repositório

| Pasta | O quê |
|---|---|
| `collector/` | Coletor (Node 20.12+, TypeScript, Playwright). `src/sources/<fonte>.ts` = uma fonte por módulo. |
| `collector/scripts/` | `install-task.ps1`, `run-scheduled.ps1`, `uninstall-task.ps1` (Windows, UTF-8 com BOM + CRLF). |
| `collector/config/legs.json` | Trechos só para modo offline (os reais vêm do banco). |
| `supabase/migrations/` | 9 migrations; as recentes são idempotentes. `supabase/seed.sql` = 4 cidades, slugs e hubs. |
| `db-tests/` | Testes do banco em PGlite (Postgres em memória, sem tocar no remoto). |
| `web/` | App PWA (React + Vite + TS). |
| `test/fixtures/` | Respostas reais usadas nos testes (ClickBus e `qp/`), sem tokens. |
| `docs/` | `plano.md`, `fontes.md`, este handoff. |

## 5. Fontes de dados

**ClickBus**: a página `clickbus.com.br/onibus/{origem}/{destino}?departureDate=AAAA-MM-DD` recebe
`bff.clickbus.com/web/api/v6/trips`. A API exige assinatura por URL (`st-cb-px`, anti-bot); por isso
só lemos o que a página recebe. Slugs: `feira-de-santana-todos`, `alagoinhas-ba`, `salvador-ba`,
`catu-ba`. Sem viagens na data, ela devolve as da próxima data (`alternativeDate`): tratamos como
`empty` com a próxima data no detalhe.

**Quero Passagem**: a página `queropassagem.com.br/onibus/{origem}-para-{destino}?ida=DD-MM-AAAA`
faz uma chamada `/search/{JWT}` por GDS (a maioria vem vazia; quase tudo no GDS 1). Slugs:
`feira-de-santana-ba`, `alagoinhas`, `salvador-ba`, `catu`. Cada viagem tem `id` estável (igual entre
GDS) e `price` (vitrine) + `tax` (taxa no pagamento, ~30%, mínimo R$ 5). O campo `tag` é um token e
**nunca** é gravado. Sem link de compra por viagem: o "Comprar" leva à página de busca.

**Dias de operação observados**: Feira → Alagoinhas é raro (ClickBus: só terça na semana de 27/09;
QP: sábado 10/10 e segunda 12/10). Via Salvador tem ônibus todo dia. Detalhes em `docs/fontes.md`.

## 6. Regras de coleta (inegociáveis, resumo do CLAUDE.md)

- Só páginas públicas no Chrome instalado com perfil persistente; **nunca** chamar APIs direto,
  forjar/reaproveitar tokens ou resolver captcha.
- Uma página por vez, **15–30 s** entre páginas, home do site antes da 1ª busca, ordem dos trechos
  sorteada por dia.
- **Teto de 120 páginas/dia** (todas as fontes somadas; `DAILY_PAGE_LIMIT`).
- Bloqueio (401/403/429/captcha): para a rodada, grava `blocked`, **quarentena de 24 h daquela
  fonte** (`collector/.quarantine.<fonte>.json`), **um** aviso no Telegram. As outras fontes seguem.
  `--ignore-quarantine` só para uso manual consciente.
- Tokens nunca vão para arquivo, log ou fixture (ocultados como `<jwt>`).

## 7. Banco

**Tabelas**: `cities` (id IBGE), `city_source_ids` (slug por fonte), `route_hubs`, `trips`,
`price_history` (trigger), `leg_stats`, `collector_runs` (status por trecho × data, `round_id`,
`detail`), `collect_requests`, `watched_dates`.

**View `trips_best`**: o mesmo ônibus em várias fontes vira 1 linha (chave: origem, destino, data,
viação normalizada por `normalize_company()`, saída, chegada), com o menor preço de vitrine
(empate: coleta mais recente), `sources` e `offers` (preço, taxa e link de cada fonte). Só trechos
diretos (`parts_count = 1`).

**Funções**:

| Função | Quem usa | O quê |
|---|---|---|
| `record_leg_result(...)` | coletor | upsert em `trips`, remove viagens que sumiram, `collector_runs`, `leg_stats` |
| `find_connections(origem, destino, data, min 20 min, max 4 h, ordem, …)` | app, alertas | diretas + 1 conexão; por 1º ônibus só o 2º que chega mais cedo; sem dominadas; ordem por chegada/preço/duração |
| `find_second_legs(1º ônibus, destino, …)` | app | todos os 2º ônibus com `compatible` e motivo |
| `date_coverage(origem, destino, data)` | app | quais trechos já foram coletados na data |
| `collector_status()` | app | última rodada, quarentena por fonte, pedidos na fila, datas com dados |
| `request_collect` / `claim_collect_request` | app / coletor | fila do "atualizar agora", com deduplicação |
| `watch_best`, `watch_status`, `evaluate_watch_alerts`, `mark_watch_alert` | app / coletor | alertas |

**RLS**: leitura só para autenticados; escrita só `service_role`, exceto `collect_requests` (inserir
pedido próprio) e `watched_dates` (cada um vê e edita os próprios alertas).

## 8. Coletor: comandos

```powershell
cd C:\dev\conexao\collector
npm run collect -- --legs all                        # todas as fontes, 5 dias a partir de hoje (amanhã depois das 20:00)
npm run collect -- --source queropassagem --legs all --dates 2026-10-10,2026-10-12
npm run collect -- --source clickbus --from salvador-ba --to catu-ba --date 2026-10-10
npm run collect -- --legs all --watched              # + datas monitoradas (até 30 dias)
npm run worker          # fica ouvindo pedidos do app (Realtime + polling 60 s); --once = atende e sai
npm run alerts          # avalia os alertas e manda no Telegram
npm run notify:test     # "Conexão: Telegram OK"
npm run spike / spike:qp
npm test; npm run typecheck
```

**Agendamento**: `powershell -ExecutionPolicy Bypass -File .\scripts\install-task.ps1` registra a
tarefa "Conexao - coletor" 1× por dia às 07:00 (StartWhenAvailable, só com usuário logado, atraso
aleatório de até 10 min). Logs em `collector/logs/` (30 últimos). `Enable-/Disable-ScheduledTask`
para ligar/pausar.

**`.env` na raiz** (fora do Git): `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
(só aqui, nunca no front), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `DAILY_PAGE_LIMIT` (120),
`APP_URL` (link nos alertas).

**Arquivos de estado** em `collector/` (fora do Git): `.profile/` (perfil do Chrome),
`.quarantine.<fonte>.json`, `.page-budget.json`, `.collector.lock` (uma coleta por vez),
`output/` (JSON bruto, sem tokens).

## 9. App

Telas: **Login** (link mágico, cadastro desligado) · **Buscar** (sentido vindo do banco, atalhos de
data, "sair depois de" / "chegar até") · **Combinações** (espera, "conexão apertada" < 90 min,
troca de rodoviária, fonte e "Comprar" por trecho, dois preços quando o ônibus está nas duas
fontes, "Dados de HH:MM" com aviso > 12 h, dois estados vazios) · **Monte você mesmo** · **Atualizar
agora** (pedido + status via Realtime) · **Alertas** (preço-alvo, lugares, janela de horário, chat
do Telegram opcional) · **Status** (por fonte). Toda hora exibida em America/Bahia. Service worker
só guarda o app shell, nunca dados.

Rodar local: `cd web; copy .env.example .env.local` (anon key), `npm ci`, `npm run dev`. Deploy e
configuração do Supabase (URLs de redirect, usuários com Auto Confirm, SMTP) em `web/README.md`.

## 10. Decisões tomadas

| Decisão | Escolha |
|---|---|
| Método de coleta | Navegador real lendo o JSON da página (não chamar APIs com tokens) |
| Onde roda o coletor | PC do Ricardo (IP residencial); a coleta só acontece com o PC ligado |
| Frequência | 1 rodada/dia às 07:00, 5 dias à frente (+ datas monitoradas até 30 dias) |
| Preço comparado entre fontes | Preço de vitrine; taxa do QP à parte em `service_fee` (opção 1) |
| Duplicatas entre fontes | View `trips_best` (menor preço, com as ofertas de cada fonte) |
| Folga entre ônibus | **20 min a 4 h** (era 60 min; mudado a pedido); "apertada" continua < 90 min |
| Resultados por padrão | Por 1º ônibus, só o 2º que chega mais cedo; sem combinações dominadas; ordem por chegada |
| Alertas | Preço-alvo avisa de novo só se ficar mais barato; lugares 1× por combinação; janela de horário opcional |
| Quarentena | Por fonte, 24 h, aviso único |
| Rotas no app | Hash (`#/r?...`), sem configuração de redirect no host |

## 11. Incidentes e aprendizados

- **403 da ClickBus no IP** (início de outubro/2026): ~100 páginas numa noite, pausas de 8–15 s.
  Levou a: 15–30 s, 1 rodada/dia de 5 dias, teto de 120 páginas, quarentena de 24 h, home antes e
  ordem sorteada. Se voltar a bloquear, **reduzir volume ou reavaliar a fonte, não contornar**.
- **Tokens no zip do spike do QP**: a ocultação não pegava JWT em base64 (URL de
  `/search-connections/` e campo `tag`). Corrigido; fixtures conferidas sem tokens.
- **`__name is not defined`**: o `tsx` injeta helper em funções passadas a `page.evaluate`; código
  que roda na página fica em string.
- **Migration não idempotente**: `round_id` já existia no remoto e o push falhou. Desde então, as
  migrations usam `if not exists` / `create or replace` / `drop … if exists`.

## 12. Pendências e próximos passos

1. **Aplicar e testar a Fase 5b**: `npx supabase@latest db push` (3 migrations), criar um alerta
   Feira → Catu 10/10 com alvo R$ 100 e rodar `npm run alerts`. Deve chegar o aviso; rodando de
   novo, nada.
2. **Religar a coleta diária** quando a ClickBus abrir no Chrome normal:
   `Enable-ScheduledTask -TaskName 'Conexao - coletor'` (cerca de 82 páginas/dia com as duas fontes).
3. **Caroline**: login dela depende de SMTP próprio ou de ela ser membro da organização no Supabase;
   alertas no Telegram dela precisam do chat id (ela manda "oi" ao bot → `getUpdates`).
4. **Merge para `main`**: todo o trabalho está em `claude/new-session-turxww`. Conferir de qual
   branch o Cloudflare publica.
5. **Ideias sugeridas, não pedidas**: editar alerta no app (hoje é apagar e criar), botão "Conectar
   Telegram", filtro de folga mínima/máxima na busca (F4 do plano), limiar da "conexão apertada",
   worker iniciando com o login do Windows.
6. **Fase 5 restante**: calendário de menor preço por dia (F10).
7. **Etapa 2** (qualquer rota): replanejar; com coleta via navegador, cada rota nova custa muitas páginas.

## 13. Como trabalhar nesta base

- **Claude Code na nuvem não acessa** ClickBus, Quero Passagem, IBGE nem o Supabase remoto (rede
  bloqueada, sem `.env`). Tudo que toca site ou banco real roda **no PC do Ricardo**, com os
  comandos passados por aqui. Nunca rodar coletas "para testar".
- No PC a CLI do Supabase é `npx supabase@latest`. Mostrar migrations antes do `db push`.
- Validar sempre com as três suítes (todas sem rede):
  ```bash
  cd collector && npm test && npm run typecheck   # 94 testes
  cd db-tests  && npm test                        # 76 testes (aplica todas as migrations no PGlite)
  cd web       && npm test && npm run build       # 39 testes
  ```
- Captura de fonte nova: ensaiar contra um site falso (Playwright `ctx.route`) antes de rodar no PC.
- Fase por fase: ao fim de cada uma, parar e mostrar o resultado. Código em inglês; docs, commits e
  explicações em português.
