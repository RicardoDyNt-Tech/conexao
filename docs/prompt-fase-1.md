# Prompt — Fase 1 (colar no Claude Code)

> Antes de colar, confira que a pasta `conexao/` tem:
> - `CLAUDE.md`
> - `docs/plano.md`, `docs/fontes.md`
> - `test/fixtures/trips-salvador-ba_catu-ba_2026-10-04.json`
> - `.env` com `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (não é usado ainda, mas já fica pronto)
> - Node 20+ e Google Chrome instalados

---

```
Leia CLAUDE.md, docs/plano.md e docs/fontes.md. Estamos na Etapa 1, Fase 1
(coletor ClickBus). Não mexa no Supabase nem crie front nesta fase.

Objetivo: um coletor em Node + TypeScript + Playwright que abre a página pública
de busca da ClickBus, intercepta a resposta JSON de /web/api/v6/trips que a própria
página recebe e devolve as viagens normalizadas.

Passos:

1. Spike (pasta collector/):
   - Projeto Node + TypeScript + Playwright usando o Chrome instalado
     (channel: 'chrome') e perfil persistente em collector/.profile (no .gitignore).
   - Script que abre https://www.clickbus.com.br/onibus/{from}/{to}?departureDate={AAAA-MM-DD},
     espera a resposta cuja URL contém "/web/api/v6/trips" (timeout 30 s),
     e salva o JSON em collector/output/.
   - Rode para estes 5 trechos, com pausa aleatória de 8–15 s entre eles, primeiro
     em headless e depois com janela visível, e me diga o resultado de cada modo:
       salvador-ba → catu-ba, alagoinhas-ba → catu-ba, feira-de-santana-todos → salvador-ba,
       feira-de-santana-todos → alagoinhas-ba, catu-ba → salvador-ba
     Use a próxima segunda-feira como data.
   - Se aparecer captcha, 403 ou a resposta não chegar: pare, não insista, e me
     mostre o que aconteceu. Não tente contornar a proteção de nenhuma forma.

2. Parser (só se o spike funcionar):
   - src/sources/clickbus.ts: função que recebe o JSON de v6/trips e devolve
     NormalizedTrip[] conforme o mapeamento em docs/fontes.md (seção 3):
     source_trip_id = parts[0].tripId, departure/arrival com a data que vem em
     cada ponta (fuso America/Bahia), preço, assentos, viação, classe, rodoviárias,
     buy_url.
   - Testes com a fixture test/fixtures/trips-salvador-ba_catu-ba_2026-10-04.json:
     18 viagens; a das 23:00 chega 2026-10-05 00:20; preços e assentos corretos.

3. CLI:
   - npm run collect -- --from salvador-ba --to catu-ba --date 2026-10-05
   - npm run collect -- --legs all --days 7   (lê a lista de trechos de um
     arquivo de config local por enquanto; na Fase 2 virá do banco)
   - Saída: resumo por trecho (qtde de viagens, status ok/empty/blocked/error).

Ao terminar, pare e me mostre: resultado do spike (headless vs janela),
testes passando e um exemplo de saída do CLI. Não avance para a Fase 2.
```
