# Conexão

Projeto pessoal do Ricardo. Buscador de passagens de ônibus com até 1 conexão.
**Etapa atual: 1** (só Feira de Santana ⇄ Catu, BA, via Alagoinhas e via Salvador). A Etapa 2 (qualquer rota) vem depois: não fechar portas para ela.

Leia antes de qualquer tarefa: `docs/handoff.md` (estado atual e pendências), `docs/plano.md` e `docs/fontes.md`.

## Restrições
- Custo zero: Supabase free (projeto pessoal `conexao`), Cloudflare Pages, Telegram Bot API, GitHub.
- Nenhuma dependência da infraestrutura da AutoLabs (n8n, VPS, uazapi).
- Sem LLM no runtime. Busca e combinação são determinísticas.

## Coleta de dados — regras inegociáveis
- A coleta usa **Playwright com o Chrome instalado** (`channel: 'chrome'`) e **perfil persistente**, abrindo **páginas públicas** de busca e **interceptando a resposta JSON que a própria página recebe** (ClickBus: `/web/api/v6/trips`; Quero Passagem: `/search/{JWT}`, uma por GDS).
- **Nunca** forjar, gerar, reaproveitar ou copiar tokens/assinaturas anti-bot (`st-cb-px`, `fp-cb`, JWTs de busca etc.). Nunca chamar esses endpoints diretamente fora do navegador. Nunca tentar resolver captcha.
- Se o site devolver captcha, 403 ou bloqueio: **parar a rodada**, registrar `status = 'blocked'` em `collector_runs`, avisar no Telegram. Não insistir.
- Se o site devolver bloqueio: **quarentena de 24 h daquela fonte** (`collector/.quarantine.<fonte>.json`; o app deduz a mesma de `collector_runs`) sem abrir página nenhuma nela (rodadas e pedidos seguem pelas outras fontes), com **um único** aviso no Telegram. `--ignore-quarantine` só para uso manual consciente.
- Tokens dos sites (JWT de `/search/`, campo `tag` do QP) **nunca** vão para arquivos, logs ou fixtures: são ocultados (`<jwt>`) antes de gravar.
- Uma página por vez, pausa aleatória de **15–30 s** entre páginas. Nunca paralelizar contra o mesmo site.
- Cada rodada abre a home do site e espera alguns segundos antes da 1ª busca; a ordem dos trechos é sorteada a cada dia.
- Uso pessoal e baixo volume: **teto de 120 páginas/dia** no coletor (`DAILY_PAGE_LIMIT`, contador em `collector/.page-budget.json`, zera à meia-noite de America/Bahia; conta rodadas, pedidos, spike e a home). Rodada agendada: **1× por dia (07:00)**, 8 trechos × 5 dias = 40 páginas + home.

## Regras de design (para escalar sem reescrever)
- Nada de "Feira", "Catu" etc. hardcoded no código: cidades, slugs e hubs vêm do banco (`cities`, `city_source_ids`, `route_hubs`).
- Cada fonte é um módulo em `collector/src/sources/<fonte>.ts` com a mesma interface: recebe (origem, destino, data) e devolve trips normalizadas.
- Cruzamento de horários só no SQL (`find_connections`, `find_second_legs`), lendo de `trips_best` (o mesmo ônibus em várias fontes vira 1 linha, com as ofertas de cada uma). Não duplicar no front.
- Preço comparado = preço de vitrine de cada site; a taxa cobrada no pagamento (QP) fica em `service_fee`, fora da comparação.
- Datas: persistir em `timestamptz`; interpretar os horários das fontes no fuso `America/Bahia`. Usar sempre a **data de chegada** que a fonte informa (há viagens que chegam no dia seguinte).

## Operação
- Falha de um trecho nunca interrompe a rodada; tudo registrado em `collector_runs`.
- Respostas reais usadas em teste ficam em `test/fixtures/` (sem dados pessoais, cookies ou tokens).
- Segredos só em `.env` (fora do Git). A `service_role` do Supabase fica **só** no `.env` do coletor, nunca no front.
- Supabase: projeto `conexao`, ref `sknunyuvrjngmrvcsaly`, região sa-east-1. A conta Supabase da AutoLabs **não** deve ser usada aqui.

## Como trabalhar
- Fase por fase, conforme `docs/plano.md`. Ao fim de cada fase, pare e mostre o resultado antes de seguir.
- Mudanças pequenas, com testes. Explique decisões não óbvias em comentários curtos.
- O app (`web/`) usa só a anon key + RLS e lê o banco via `find_connections`, `find_second_legs`, `date_coverage`, `collector_status` e selects simples.
- Idioma: código e nomes em inglês; docs, mensagens de commit e explicações em português.
