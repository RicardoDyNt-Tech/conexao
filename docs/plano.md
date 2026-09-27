# Plano de construção — Conexão (buscador de ônibus com conexão)

> **Versão 4 (26/09/2026).** Substitui as versões anteriores. Muda por causa do resultado da Fase 0: as APIs de busca da ClickBus e do Quero Passagem exigem tokens gerados pelo próprio site a cada busca. Por isso **o coletor passa a usar um navegador automatizado (Playwright) no PC do Ricardo**.
> Escopo: **uso pessoal**, **custo R$ 0**, nada da infraestrutura da AutoLabs.
> Detalhes técnicos das fontes: `docs/fontes.md`.

---

## TL;DR

- **Etapa 1 — só Feira de Santana ⇄ Catu** (via Alagoinhas e via Salvador). **Etapa 2 — qualquer rota**, construída em cima da mesma base.
- **Coletor:** Node + Playwright no **seu PC Windows**. Ele abre as páginas públicas de busca da ClickBus como um usuário normal e **lê a resposta JSON que a própria página recebe** (`/web/api/v6/trips`). Não forja nem reaproveita tokens.
- **Banco:** Supabase (projeto pessoal `conexao`, ref `sknunyuvrjngmrvcsaly`).
- **App:** PWA no Cloudflare Pages, instalável nos dois Androids.
- **Alertas:** bot do Telegram.
- **O coração do app:** combinar os dois trechos em **qualquer horário**, e não só as poucas conexões prontas que os sites vendem. Inclui o modo **"monte você mesmo"**: escolha o 1º ônibus e veja só os 2º ônibus compatíveis.
- **Contrapartida do plano B:** a coleta só roda com o PC ligado.

---

## 1. O que a Fase 0 descobriu (resumo)

| Item | Resultado |
|---|---|
| Fonte principal | **ClickBus**, `GET bff.clickbus.com/web/api/v6/trips?from=&to=&departureDate=&clientId=2`, JSON com horário, preço, assentos, viação, classe e rodoviária. |
| Proteção | Header `st-cb-px` = assinatura por URL (anti-bot). Sem ela: 403. **Não contornar.** |
| Caminho escolhido | Navegador automatizado carrega `clickbus.com.br/onibus/{from}/{to}?departureDate=AAAA-MM-DD` e intercepta a resposta de `v6/trips`. |
| Slugs ClickBus | `feira-de-santana-todos`, `alagoinhas-ba`, `salvador-ba`, `catu-ba` |
| Salvador → Catu (dom 04/10) | 18 viagens, 06:00–23:00 (Cidade Sol + Rota) |
| Feira → Alagoinhas | Sem oferta no domingo na ClickBus. A confirmar em dia útil. |
| Bilhete único Feira → Catu | ClickBus: não. **Quero Passagem: sim, mas só 3 opções de madrugada** (R$ 73–100). Isso valida o app. |
| Quero Passagem | Página pública `?ida=DD-MM-AAAA`. Dados completos via `/search/{JWT}` (token do servidor). Fica como **2ª fonte** na Fase 5, pelo mesmo método (navegador). |
| Descartados | API oficial ClickBus (só parceiros), GeckoAPI (paga e sem garantia de dados por viagem), chamadas diretas com tokens copiados. |

---

## 2. Como o app funciona

```
1. Coletor (PC) abre a página de cada trecho × data → captura v6/trips → grava em trips
2. App pede: Feira → Catu, 10/10
3. find_connections (SQL) cruza TODOS os trechos:
      Feira→Alagoinhas × Alagoinhas→Catu
      Feira→Salvador   × Salvador→Catu
   com folga entre 20 min e 4 h (era 60 min; reduzido a pedido), usando a HORA REAL de chegada do 1º ônibus
4. App mostra as combinações: saída, chegada final, espera, preço total
5. Modo "monte você mesmo": escolho o 1º ônibus → vejo só os 2º compatíveis
```

**Trechos monitorados na Etapa 1 (8):**
- Ida: Feira → Alagoinhas, Alagoinhas → Catu, Feira → Salvador, Salvador → Catu
- Volta: Catu → Alagoinhas, Alagoinhas → Feira, Catu → Salvador, Salvador → Feira

---

## 3. Requisitos

### Etapa 1

| # | Requisito | Prioridade |
|---|---|---|
| F1 | Buscar Feira → Catu ou Catu → Feira por data | Must |
| F2 | Listar **todas** as combinações viáveis (via Alagoinhas e via Salvador) | Must |
| F3 | **Modo "monte você mesmo"**: escolher o 1º ônibus e ver só os 2º compatíveis, com a chegada final | Must |
| F4 | Filtros: "sair depois de", "chegar até", folga mínima/máxima (padrão 20 min – 4 h), classe, viação | Must |
| F5 | Ordenar por preço total, chegada, duração total, menor espera | Must |
| F6 | Sinalizar conexão apertada (< 90 min) e troca de rodoviária | Must |
| F7 | Link de compra de cada trecho + "dados de HH:MM" | Must |
| F8 | "Atualizar agora" → pedido na fila; o coletor atende quando o PC estiver ligado | Should |
| F9 | Datas monitoradas + alerta no Telegram (preço abaixo de R$ X, assentos acabando) | Should |
| F10 | Calendário de menor preço por dia | Should |
| F11 | Conexões prontas do Quero Passagem como opção extra | Could (Fase 5) |

### Não funcionais
- **Custo:** R$ 0.
- **Coleta gentil:** 1 página por vez, 15–30 s de intervalo aleatório entre páginas, home do site antes da 1ª busca, ordem dos trechos sorteada, **1 rodada por dia** (07:00) para os **próximos 5 dias** (~41 páginas/dia), mais os pedidos manuais e as datas monitoradas até 30 dias. Após um bloqueio: quarentena de 24 h. Teto de 120 páginas/dia no coletor. *(Ajustado em 10/2026, depois de um 403 com ~100 páginas numa noite de testes com 8–15 s e 7 dias.)*
- **Resiliência:** a falha de um trecho não para a rodada; tudo fica registrado em `collector_runs`.
- **Observabilidade:** Telegram avisa se uma rodada falhar ou se a ClickBus começar a devolver captcha/403.
- **Busca no app:** < 2 s (lê só do banco).

---

## 4. Arquitetura

```
┌───────────────── PC do Ricardo (Windows) ─────────────────┐
│ Agendador de Tarefas → 07:00 e 19:00                       │
│ collector (Node + TypeScript + Playwright, Chrome real)    │
│  ├─ source clickbus: abre a página, intercepta v6/trips    │
│  ├─ normaliza → upsert trips / price_history / leg_stats   │
│  ├─ escuta collect_requests (Realtime) enquanto roda       │
│  └─ ao fim: avalia watched_dates → Telegram                │
└──────────────────────────┬────────────────────────────────┘
                           │ service_role (só no .env do PC)
                           ▼
┌──────────── Supabase (conexao / sknunyuvrjngmrvcsaly) ─────┐
│ cities, city_source_ids, route_hubs, trips, price_history, │
│ leg_stats, collector_runs, collect_requests, watched_dates │
│ RPC: find_connections(), find_second_legs()                │
│ Auth: magic link, só os 2 e-mails (cadastro desligado)     │
└──────────────────────────┬────────────────────────────────┘
                           │ anon key + RLS
                           ▼
          PWA React + Vite (Cloudflare Pages) — 2 Androids
```

### Decisões

| Decisão | Escolha | Por quê |
|---|---|---|
| Coleta | **Playwright no PC**, com o **Chrome instalado** (`channel: 'chrome'`) e **perfil persistente** | Anti-bot comercial costuma bloquear navegador automatizado em datacenter e perfis "zerados". Um IP residencial com perfil estável é o mais confiável. |
| Headless | Tentar headless; se a ClickBus bloquear, rodar em janela minimizada | Decidir no spike da Fase 1. |
| Agendamento | **Agendador de Tarefas do Windows** | Grátis e nativo. |
| "Atualizar agora" | Tabela `collect_requests` + Realtime/polling pelo coletor | Sem servidor extra. Só funciona com o PC ligado, e a UI deixa isso claro. |
| Cruzamento | **SQL** (`find_connections`, `find_second_legs`) | Determinístico, rápido e testável. |
| Edge Functions / pg_cron | **Não usar na Etapa 1** | Não são necessários. O coletor já mantém o Supabase ativo. |
| GitHub Actions | Só teste opcional no futuro | Se o Playwright passar lá, o PC deixa de ser obrigatório. |

---

## 5. Modelo de dados

```sql
create table cities (
  id int primary key,               -- código IBGE
  name text not null, uf char(2) not null,
  lat numeric, lng numeric
);

create table city_source_ids (
  city_id int references cities, source text,   -- 'clickbus' | 'queropassagem'
  source_slug text not null,                    -- 'feira-de-santana-todos', 'catu' ...
  primary key (city_id, source)
);

create table route_hubs (                        -- Etapa 1: hubs fixos. Etapa 2: curadoria manual.
  origin_city_id int references cities, dest_city_id int references cities,
  hub_city_id int references cities,
  primary key (origin_city_id, dest_city_id, hub_city_id)
);

create table trips (
  id bigint generated always as identity primary key,
  source text not null,
  source_trip_id text not null,                  -- clickbus: parts[0].tripId
  origin_city_id int references cities, dest_city_id int references cities,
  travel_date date not null,                     -- data de saída
  company text, company_slug text,
  origin_station text, origin_station_id int,
  dest_station text, dest_station_id int,
  departure_at timestamptz not null,
  arrival_at timestamptz not null,               -- usa arrival.date (vira o dia)
  service_class text,
  price numeric(10,2), original_price numeric(10,2),
  seats_available int, seats_total int,
  is_low_fare boolean,
  buy_url text,
  fetched_at timestamptz not null default now(),
  unique (source, source_trip_id)
);
create index on trips (origin_city_id, dest_city_id, travel_date);

create table price_history (
  source text, source_trip_id text, price numeric(10,2), seats_available int,
  observed_at timestamptz default now()
);

create table leg_stats (                         -- já alimentada na Etapa 1; base da Etapa 2
  origin_city_id int, dest_city_id int, has_service boolean,
  avg_daily_trips numeric, last_checked_at timestamptz,
  primary key (origin_city_id, dest_city_id)
);

create table collector_runs (
  id bigint generated always as identity primary key,
  source text, origin_city_id int, dest_city_id int, travel_date date,
  status text,                                   -- ok | empty | blocked | error
  trips_found int, error text,
  started_at timestamptz, finished_at timestamptz
);

create table collect_requests (                  -- "atualizar agora"
  id bigint generated always as identity primary key,
  origin_city_id int, dest_city_id int, travel_date date,
  requested_by uuid references auth.users,
  status text default 'pending',                 -- pending | running | done | error
  created_at timestamptz default now(), done_at timestamptz
);

create table watched_dates (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users,
  origin_city_id int, dest_city_id int, travel_date date,
  max_price numeric(10,2), min_seats_alert int default 5,
  telegram_chat_id text, last_alerted_at timestamptz,
  active boolean default true
);
```

### Funções

- **`find_connections(origin, dest, date, min_layover='20 min', max_layover='4 h')`**: diretas + 1 conexão por qualquer cidade H (`t1.dest = t2.origin`), com espera, duração total, preço total, `same_station` e `data_as_of`.
- **`find_second_legs(first_trip_id, dest, min_layover, max_layover)`**: para o modo "monte você mesmo". Recebe o 1º ônibus escolhido e devolve os 2º compatíveis com a chegada final.

**Casos de borda com teste obrigatório:**
- Viagem que chega no dia seguinte (confirmado: Salvador 23:00 → Catu 00:20).
- Conexão atravessando a meia-noite (2º trecho em `date + 1`).
- Troca de rodoviária no hub.
- Trecho sem viagens no dia (Feira → Alagoinhas no domingo).
- Dados velhos (`fetched_at` > 12 h): mostrar aviso.

---

## 6. Interface (PWA)

1. **Buscar**: sentido (Feira → Catu / Catu → Feira), data, "sair depois de", "chegar até".
2. **Resultados**: combinações ordenáveis.
   ```
   R$ 58,20 · sai 14:30 · chega 18:40 · espera 1h05      [via Alagoinhas]
   14:30 Rota        Feira → Alagoinhas   R$ 40,63   [comprar]
   16:45 Cidade Sol  Alagoinhas → Catu    R$ 17,57   [comprar]
   dados de 07:12
   ```
3. **Monte você mesmo**: duas colunas.
   - Esquerda: todos os 1º ônibus do dia (Feira → Salvador e Feira → Alagoinhas).
   - Ao tocar num deles, a direita mostra os 2º compatíveis, cada um com "chega às HH:MM" e a espera.
   - Os incompatíveis aparecem esmaecidos, com o motivo ("sai antes de você chegar").
4. **Datas monitoradas + alertas.**
5. **Status**: última coleta, se o PC está coletando, botão "atualizar agora" (com aviso "depende do PC ligado").

---

## 7. Roadmap — Etapa 1

### Fase 1 — Coletor ClickBus (2–3 dias) · **GATE**
- [x] Repo `conexao`, `CLAUDE.md`, `docs/plano.md`, `docs/fontes.md`, fixture `trips-salvador-ba_catu-ba_2026-10-04.json`.
- [x] **Spike:** script Playwright abre `clickbus.com.br/onibus/salvador-ba/catu-ba?departureDate=...`, intercepta `v6/trips` e salva o JSON. Testar headless e com janela; 5 trechos seguidos com pausa.
- [x] Gate (26/09/2026: 5/5 ok em headless e janela; seguimos em headless): se capturar os 5 sem bloqueio → seguir. Se houver bloqueio/captcha, ajustar (perfil persistente, janela, pausas maiores). Se continuar bloqueando, parar e reavaliar.
- [x] Parser `v6/trips` → modelo normalizado, com testes usando a fixture (inclui a chegada no dia seguinte).
- [x] CLI: `npm run collect -- --legs all --days 7` e `--from salvador-ba --to catu-ba --date 2026-10-04`.

### Fase 2 — Banco e cruzamento (1–2 dias)
- [x] Migrations, seed (4 cidades + slugs + hubs), RLS/allowlist.
- [x] Coletor grava no Supabase (upsert + `price_history` + `leg_stats` + `collector_runs`).
- [x] `find_connections` e `find_second_legs` + testes dos casos de borda.
- [x] Validar 2 datas comparando com a busca manual nos sites.

### Fase 3 — Agendamento (0,5 dia)
- [x] Agendador de Tarefas: 07:00 e 19:00, próximos 5 dias, 8 trechos.
- [x] `collect_requests` (atualizar agora).
- [x] Telegram: bot + aviso de falha/bloqueio (+ pausa de 6 h após bloqueio).

### Fase 4 — PWA (3–4 dias)
- [x] Buscar, Resultados, **Monte você mesmo**, Status (web/, testes com Vitest + Testing Library).
- [x] Login (magic link), manifest, service worker.
- [ ] Deploy no Cloudflare Pages, URLs no Supabase, instalação nos dois Androids.
- [ ] **Marco: MVP utilizável.** Usar numa viagem real.

### Fase 5 — Extras (2–3 dias)
- [x] Datas monitoradas + alertas de preço/assentos (Fase 5b): tela Alertas no app, coleta das datas monitoradas (`--watched`, até 30 dias), `npm run alerts` no fim da rodada diária. Preço-alvo avisa de novo só se ficar mais barato; assentos, uma vez por combinação.
- [ ] Calendário de menor preço.
- [x] 2ª fonte: Quero Passagem (Fase 5a, antecipada após o 403 da ClickBus): spike, parser, `--source`, quarentena por fonte, `trips_best`, app com as duas fontes. Conexões prontas do QP são gravadas (`parts_count` > 1) mas ficam fora do cruzamento.

**Etapa 1: ~2–3 fins de semana.**

### Etapa 2 — Qualquer rota (depois)
Autocomplete, descoberta automática de hubs (curadoria + geografia + `leg_stats`) e busca sob demanda. **Atenção:** com o coletor via navegador, cada busca nova de uma rota abre ~10–25 páginas, o que leva alguns minutos. Replanejar essa etapa quando chegar a hora.

---

## 8. Riscos

| Risco | Mitigação |
|---|---|
| ClickBus bloqueia o navegador automatizado | Chrome real, perfil persistente, pausas aleatórias, baixo volume; Quero Passagem como 2ª fonte. |
| PC desligado → dados velhos | "Dados de HH:MM" em todo card, aviso quando > 12 h; rodada extra ao ligar o PC. |
| Termos de uso | Uso estritamente pessoal, volume baixo, só páginas públicas, sem contornar tokens. Não sou advogado: o risco é baixo, mas não é zero. |
| A ClickBus muda o site/endpoint | Parser isolado + fixture + alerta de falha. |
| Perder o 2º ônibus | Folga mínima de 20 min (escolha do Ricardo), aviso de conexão apertada (< 90 min). |
| Feira → Alagoinhas raro/inexistente em alguns dias | Via Salvador sempre como alternativa. |

---

## 9. Próxima ação

Abrir o Claude Code na pasta `conexao` e colar o prompt de `docs/prompt-fase-1.md`.
