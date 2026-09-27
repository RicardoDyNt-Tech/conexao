# Coletor (Fase 1)

Node + TypeScript + Playwright. Abre a página pública de busca da ClickBus no **Chrome instalado**
(`channel: 'chrome'`, perfil persistente em `.profile/`) e lê a resposta de `/web/api/v6/trips`
que a própria página recebe. Regras de coleta: ver `../CLAUDE.md`.

```bash
cd collector
npm install            # não precisa de "playwright install": usa o Chrome do PC
npm test               # parser + fusos, com a fixture de ../test/fixtures
npm run spike          # 5 trechos da config "spike", próxima segunda, headless
npm run spike -- --headed
npm run collect -- --from salvador-ba --to catu-ba --date 2026-10-05
npm run collect -- --legs all                             # 5 dias; começa hoje (depois das 20:00, amanhã)
npm run collect -- --legs all --days 3 --start 2026-10-05
npm run collect -- --legs all --dates 2026-10-10,2026-10-12   # datas específicas
```

- `--dates`: lista separada por vírgula (sem repetição, em ordem, nada no passado, até 30);
  não combina com `--days`/`--start`. Vale também com `--from/--to`. Conta no teto diário de páginas.
- Saída: resumo por trecho com status `ok | empty | blocked | error` (`skipped` = não rodou porque a rodada parou num bloqueio).
- JSON bruto e normalizado vão para `output/` (fora do Git). `--no-save` desliga.
- Gentileza: 15–30 s entre páginas; home da ClickBus aberta alguns segundos antes da 1ª busca;
  ordem dos trechos sorteada a cada dia. Nada de headers ou tokens: só o navegador normal.
- Bloqueio (HTTP 401/403/429 ou página de captcha) interrompe a rodada (código de saída 3) e grava
  uma **quarentena de 24 h** em `.quarantine.json`: até lá, `collect` e `worker` não abrem página
  nenhuma e não mandam novos avisos. O app mostra a mesma quarentena (deduzida de `collector_runs`).
- `--ignore-quarantine`: uso manual consciente (ex.: depois de confirmar que o site abre no seu
  Chrome). Roda mesmo em quarentena; se não houver bloqueio, a quarentena acaba.
- **Teto diário de páginas**: 120 por dia (`DAILY_PAGE_LIMIT` no `.env`), somando rodadas, pedidos,
  spike e a home. Contador em `.page-budget.json`, zera à meia-noite (America/Bahia). Ao atingir,
  a rodada para no ponto em que está (as datas mais próximas já foram coletadas), o resto vira
  `skipped` e sai **um** aviso no Telegram por dia. Pedidos do app ficam `pending` até o dia seguinte.
  Conta típica: 1 rodada × 41 = 41 páginas, sobrando ~79 para pedidos e testes.
- Trechos: vêm do banco (`route_hubs` → origem→hub e hub→destino, traduzidos por `city_source_ids`).
  `config/legs.json` é só fallback offline (`--offline` ou sem credenciais no `.env`).
- Gravação: cada trecho × data chama `record_leg_result` no Supabase (upsert em `trips`,
  remove viagens que sumiram, `collector_runs`, `leg_stats`). Usa `SUPABASE_SERVICE_ROLE_KEY`
  do `.env` da raiz do repo; falha ao gravar não para a rodada.
- `BROWSER_EXECUTABLE=/caminho/chrome` troca o Chrome por outro binário (só para testes fora do PC).

## Agendamento (Fase 3)

A tarefa roda `scripts/run-scheduled.ps1` **1× por dia, às 07:00** (com atraso aleatório de até 10 min):
coleta `--legs all --days 5`, depois atende os pedidos "atualizar agora" pendentes
(`worker --once`). Só roda com você logado; se o PC estava desligado no horário, roda
assim que ele ligar (StartWhenAvailable). Log em `logs/AAAA-MM-DD_HHMM.log` (ficam os 30 últimos).

```powershell
cd C:\dev\conexao\collector
powershell -ExecutionPolicy Bypass -File .\scripts\install-task.ps1     # instalar
Start-ScheduledTask -TaskName 'Conexao - coletor'                        # testar agora
Get-ScheduledTaskInfo -TaskName 'Conexao - coletor'                      # LastTaskResult 0 = ok
Get-ChildItem .\logs | Sort-Object Name | Select-Object -Last 1 | Get-Content -Wait   # acompanhar o log
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-task.ps1   # remover
```

Pelo Agendador de Tarefas (`taskschd.msc`): Biblioteca → **Conexao - coletor** → botão direito →
**Executar**. A coluna "Resultado da última execução" mostra `0x0` quando deu certo;
`0x3` = bloqueio da ClickBus; `0x1` = erro (veja o log).

Parâmetros opcionais do instalador: `-Times '06:30'` (ou dois horários: `-Times '07:00','19:00'`), `-RandomDelayMinutes 0`.

Pausar/retomar sem desinstalar: `Disable-ScheduledTask -TaskName 'Conexao - coletor'` /
`Enable-ScheduledTask -TaskName 'Conexao - coletor'`.

## "Atualizar agora" (worker)

```bash
npm run worker            # fica rodando: Realtime + polling a cada 60 s; Ctrl+C para sair
npm run worker -- --once  # atende os pendentes e sai
```

- O app cria pedidos com `select request_collect(origem, destino, data)`: se já houver pedido
  pending/running para o mesmo par e data, devolve o mesmo id (sem duplicar).
- Para cada pedido: a direta origem→destino e, para cada hub do par, origem→hub e hub→destino,
  na data pedida. Status: `pending → running → done | error` (motivo em `collect_requests.error`).
- Pedido `running` há mais de 30 min (PC desligou no meio) volta para a fila.
- Uma coleta por vez: o worker e a rodada agendada compartilham uma trava (`.collector.lock`);
  quem chega depois espera.
- Bloqueio da ClickBus: avisa no Telegram e entra na quarentena de 24 h; o worker continua rodando,
  mas não pega pedidos até ela acabar (eles ficam `pending`).

## Telegram

Variáveis no `.env` da raiz: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.

```bash
npm run notify:test   # manda "Conexão: Telegram OK"
```

- Bloqueio (captcha/403): **uma** mensagem imediata, "bloqueado até HH:MM de DD/MM" (24 h);
  a rodada para, e nada mais é avisado durante a quarentena. Vale para `collect` e `worker`.
- Rodada agendada (`--notify`): resumo só se houver erro, bloqueio ou falha ao gravar no banco;
  e aviso se a rodada inteira falhar (ex.: Supabase fora do ar).
- Sem as variáveis, nada é enviado (só um aviso no log).

## Spike do Quero Passagem (Fase 5a)

```bash
npm run spike:qp                          # 3 trechos de config/legs.json ("spikeQp"), 2026-10-10, headless
npm run spike:qp -- --date 2026-10-12     # outra data
```

- Mesmo Chrome, perfil, trava e teto diário do coletor; abre a home do QP antes, 15–30 s entre páginas.
- Só observa a página: grava as respostas JSON que ela recebe (`/search/` em arquivos próprios),
  o DOM (cards com horário e preço, JSON-LD) e um print, em `output/qp/<data>/<origem>_<destino>/`.
- JWTs são ocultados em tudo o que é gravado (`<jwt>` + claims do payload).
- Bloqueio (HTTP 401/403/429, ou captcha sem nenhum resultado): para na hora e grava a
  quarentena **só do QP** (`.quarantine.queropassagem.json`, 24 h).

## Fontes (Fase 5a)

```bash
npm run collect -- --legs all                                    # todas as fontes (padrão), uma de cada vez
npm run collect -- --source queropassagem --legs all --dates 2026-10-10,2026-10-12
npm run collect -- --source clickbus --from salvador-ba --to catu-ba --date 2026-10-10
```

- `--source clickbus|queropassagem|all`. Os slugs de cada fonte vêm de `city_source_ids`
  (QP: `feira-de-santana-ba`, `alagoinhas`, `salvador-ba`, `catu`); `--from/--to` exigem `--source`.
- **Quarentena por fonte** (`.quarantine.clickbus.json`, `.quarantine.queropassagem.json`): a
  ClickBus bloqueada não impede o QP. O `.quarantine.json` antigo vale como ClickBus.
- O teto diário de páginas continua **um só** (todas as fontes somadas).
- Quero Passagem: a página faz uma chamada `/search/` por GDS; o coletor espera 5 s sem chamada
  em andamento (teto 45 s). Preço = vitrine; a taxa vai para `service_fee`. Mesmo ônibus de vários
  GDS vira 1 (id do QP).

## Datas monitoradas e alertas (Fase 5b)

```bash
npm run collect -- --legs all --days 5 --watched   # janela + datas monitoradas no app (até 30 dias)
npm run alerts                                      # avalia e manda os avisos no Telegram
```

- A rodada agendada já faz os dois (`run-scheduled.ps1`); os alertas rodam mesmo depois de um
  bloqueio, porque só leem o banco.
- **Preço-alvo**: a combinação mais barata da data (preço de vitrine) ficou ≤ alvo. Avisa de novo
  só se ficar ainda mais barata; mudar o alvo no app recomeça.
- **Poucos lugares**: a combinação mais barata tem trecho com ≤ N lugares. Uma vez por combinação.
- **Janela de horário** (opcional, por alerta): "sair depois de" / "chegar até" (Bahia, no dia da
  viagem). Preço-alvo e poucos lugares olham a mais barata dentro da janela; mudar a janela recomeça os avisos.
- Destino: o chat informado no alerta ou `TELEGRAM_CHAT_ID`. `APP_URL` (opcional) põe o link da
  busca no aviso. O aviso só é marcado como enviado depois de o Telegram confirmar.
- Cada data monitorada fora da janela de 5 dias custa ~5 páginas por fonte (direta + 2 hubs × 2
  trechos) e conta no teto diário.

## Spike dos sites das viações (Fase 5c)

```bash
npm run spike:webrodoviaria                    # Cidade Sol e Rota, 2 trechos cada, 2026-10-10, headless
npm run spike:webrodoviaria -- --only rota     # só uma viação
```

- Abre a Venda Web de cada viação (`config/legs.json`, "spikeWebrodoviaria"), **preenche o formulário
  como um usuário** (digita o começo da cidade, escolhe a sugestão, data, "pesquisar") e grava:
  campos do formulário (`form.fields.json`), passos (`steps.json`), rede (`network.json`: URL, método,
  status, tipo, tamanho, corpo do POST), respostas XHR (`NN_<fase>.json|txt`), HTML e print do resultado
  e da aba do dia seguinte (para saber se troca por XHR ou recarrega).
- ViewState, tokens, CSRF, sessão e valores longos saem ocultos (`<redacted>`) em tudo o que é gravado.
- Mesmas regras: 15–30 s entre páginas, teto diário, quarentena **por viação** (`rota`, `cidadesol`).
- Saída em `output/webrodoviaria/<viação>/<data>/<origem>_<destino>/`.
