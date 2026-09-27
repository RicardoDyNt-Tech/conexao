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
```

- Saída: resumo por trecho com status `ok | empty | blocked | error` (`skipped` = não rodou porque a rodada parou num bloqueio).
- JSON bruto e normalizado vão para `output/` (fora do Git). `--no-save` desliga.
- Gentileza: 15–30 s entre páginas; home da ClickBus aberta alguns segundos antes da 1ª busca;
  ordem dos trechos sorteada a cada dia. Nada de headers ou tokens: só o navegador normal.
- Bloqueio (HTTP 401/403/429 ou página de captcha) interrompe a rodada (código de saída 3) e grava
  uma **pausa de 6 h** em `.cooldown.json`: até lá, `collect` e `worker` não abrem página nenhuma
  e não mandam novos avisos. Para encerrar a pausa antes (só se tiver certeza), apague o arquivo.
- **Teto diário de páginas**: 120 por dia (`DAILY_PAGE_LIMIT` no `.env`), somando rodadas, pedidos,
  spike e a home. Contador em `.page-budget.json`, zera à meia-noite (America/Bahia). Ao atingir,
  a rodada para no ponto em que está (as datas mais próximas já foram coletadas), o resto vira
  `skipped` e sai **um** aviso no Telegram por dia. Pedidos do app ficam `pending` até o dia seguinte.
  Conta típica: 2 rodadas × 41 = 82 páginas, sobrando ~38 para pedidos e testes.
- Trechos: vêm do banco (`route_hubs` → origem→hub e hub→destino, traduzidos por `city_source_ids`).
  `config/legs.json` é só fallback offline (`--offline` ou sem credenciais no `.env`).
- Gravação: cada trecho × data chama `record_leg_result` no Supabase (upsert em `trips`,
  remove viagens que sumiram, `collector_runs`, `leg_stats`). Usa `SUPABASE_SERVICE_ROLE_KEY`
  do `.env` da raiz do repo; falha ao gravar não para a rodada.
- `BROWSER_EXECUTABLE=/caminho/chrome` troca o Chrome por outro binário (só para testes fora do PC).

## Agendamento (Fase 3)

A tarefa roda `scripts/run-scheduled.ps1` às **07:00 e 19:00** (com atraso aleatório de até 10 min):
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

Parâmetros opcionais do instalador: `-Times '06:30','18:30'`, `-RandomDelayMinutes 0`.

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
- Bloqueio da ClickBus: avisa no Telegram e entra na pausa de 6 h; o worker continua rodando, mas
  não pega pedidos até a pausa acabar (eles ficam `pending`).

## Telegram

Variáveis no `.env` da raiz: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.

```bash
npm run notify:test   # manda "Conexão: Telegram OK"
```

- Bloqueio (captcha/403): **uma** mensagem imediata com o horário em que a pausa de 6 h acaba;
  a rodada para, e nada mais é avisado durante a pausa. Vale para `collect` e `worker`.
- Rodada agendada (`--notify`): resumo só se houver erro, bloqueio ou falha ao gravar no banco;
  e aviso se a rodada inteira falhar (ex.: Supabase fora do ar).
- Sem as variáveis, nada é enviado (só um aviso no log).
