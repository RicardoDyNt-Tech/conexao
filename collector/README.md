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
npm run collect -- --legs all --days 7
```

- Saída: resumo por trecho com status `ok | empty | blocked | error` (`skipped` = não rodou porque a rodada parou num bloqueio).
- JSON bruto e normalizado vão para `output/` (fora do Git). `--no-save` desliga.
- Bloqueio (HTTP 401/403/429 ou página de captcha) interrompe a rodada; código de saída 3.
- Trechos: vêm do banco (`route_hubs` → origem→hub e hub→destino, traduzidos por `city_source_ids`).
  `config/legs.json` é só fallback offline (`--offline` ou sem credenciais no `.env`).
- Gravação: cada trecho × data chama `record_leg_result` no Supabase (upsert em `trips`,
  remove viagens que sumiram, `collector_runs`, `leg_stats`). Usa `SUPABASE_SERVICE_ROLE_KEY`
  do `.env` da raiz do repo; falha ao gravar não para a rodada.
- `BROWSER_EXECUTABLE=/caminho/chrome` troca o Chrome por outro binário (só para testes fora do PC).
