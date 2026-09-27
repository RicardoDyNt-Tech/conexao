-- Fase 2: esquema base (docs/plano.md, seção 5).
-- Horários sempre em timestamptz; as fontes são interpretadas em America/Bahia pelo coletor.

create table cities (
  id int primary key,                 -- código IBGE
  name text not null,
  uf char(2) not null,
  lat numeric(9,6),
  lng numeric(9,6)
);

create table city_source_ids (
  city_id int not null references cities on delete cascade,
  source text not null,               -- 'clickbus' | 'queropassagem'
  source_slug text not null,
  primary key (city_id, source),
  unique (source, source_slug)        -- o coletor traduz slug → cidade
);

-- Etapa 1: hubs fixos. Etapa 2: curadoria manual + descoberta.
create table route_hubs (
  origin_city_id int not null references cities,
  dest_city_id int not null references cities,
  hub_city_id int not null references cities,
  primary key (origin_city_id, dest_city_id, hub_city_id),
  check (hub_city_id <> origin_city_id and hub_city_id <> dest_city_id)
);

create table trips (
  id bigint generated always as identity primary key,
  source text not null,
  source_trip_id text not null,       -- clickbus: parts[0].tripId
  origin_city_id int not null references cities,
  dest_city_id int not null references cities,
  travel_date date not null,          -- data de saída (horário local)
  company text,
  company_slug text,
  origin_station text,
  origin_station_id int,
  dest_station text,
  dest_station_id int,
  departure_at timestamptz not null,
  arrival_at timestamptz not null,    -- usa a data de chegada da fonte (pode virar o dia)
  service_class text,
  price numeric(10,2),
  original_price numeric(10,2),
  seats_available int,
  seats_total int,
  is_low_fare boolean,
  parts_count int not null default 1, -- >1 = conexão vendida pronta pela fonte
  buy_url text,
  fetched_at timestamptz not null default now(),
  unique (source, source_trip_id),
  check (arrival_at > departure_at)
);
create index trips_leg_date_idx on trips (origin_city_id, dest_city_id, travel_date);

create table price_history (
  id bigint generated always as identity primary key,
  source text not null,
  source_trip_id text not null,
  price numeric(10,2),
  seats_available int,
  observed_at timestamptz not null default now()
);
create index price_history_trip_idx on price_history (source, source_trip_id, observed_at);

-- Já alimentada na Etapa 1; base da descoberta de rotas na Etapa 2.
create table leg_stats (
  origin_city_id int not null references cities,
  dest_city_id int not null references cities,
  has_service boolean,
  avg_daily_trips numeric(6,2),
  last_checked_at timestamptz,
  primary key (origin_city_id, dest_city_id)
);

create table collector_runs (
  id bigint generated always as identity primary key,
  source text not null,
  origin_city_id int references cities,
  dest_city_id int references cities,
  travel_date date not null,
  status text not null check (status in ('ok', 'empty', 'blocked', 'error')),
  trips_found int,
  error text,
  started_at timestamptz,
  finished_at timestamptz
);
create index collector_runs_leg_idx on collector_runs (origin_city_id, dest_city_id, started_at desc);

-- "Atualizar agora": o app insere, o coletor atende quando o PC estiver ligado.
create table collect_requests (
  id bigint generated always as identity primary key,
  origin_city_id int not null references cities,
  dest_city_id int not null references cities,
  travel_date date not null,
  requested_by uuid default auth.uid() references auth.users,
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'error')),
  created_at timestamptz not null default now(),
  done_at timestamptz
);

create table watched_dates (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users,
  origin_city_id int not null references cities,
  dest_city_id int not null references cities,
  travel_date date not null,
  max_price numeric(10,2),
  min_seats_alert int default 5,
  telegram_chat_id text,
  last_alerted_at timestamptz,
  active boolean not null default true
);

-- Histórico: grava quando o preço ou os assentos mudam (inclusive na 1ª observação).
create function log_trip_price_change() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT'
     or new.price is distinct from old.price
     or new.seats_available is distinct from old.seats_available then
    insert into price_history (source, source_trip_id, price, seats_available, observed_at)
    values (new.source, new.source_trip_id, new.price, new.seats_available, new.fetched_at);
  end if;
  return new;
end $$;

create trigger trips_price_history
after insert or update on trips
for each row execute function log_trip_price_change();

-- ---------------------------------------------------------------------------
-- RLS. Leitura: só usuários autenticados (cadastro público desligado; 2 convidados).
-- Escrita: só service_role (que ignora RLS), exceto collect_requests.
-- anon não tem política nenhuma → não lê nada.
-- ---------------------------------------------------------------------------
alter table cities           enable row level security;
alter table city_source_ids  enable row level security;
alter table route_hubs       enable row level security;
alter table trips            enable row level security;
alter table price_history    enable row level security;
alter table leg_stats        enable row level security;
alter table collector_runs   enable row level security;
alter table collect_requests enable row level security;
alter table watched_dates    enable row level security;

create policy read_authenticated on cities           for select to authenticated using (true);
create policy read_authenticated on city_source_ids  for select to authenticated using (true);
create policy read_authenticated on route_hubs       for select to authenticated using (true);
create policy read_authenticated on trips            for select to authenticated using (true);
create policy read_authenticated on price_history    for select to authenticated using (true);
create policy read_authenticated on leg_stats        for select to authenticated using (true);
create policy read_authenticated on collector_runs   for select to authenticated using (true);
create policy read_authenticated on collect_requests for select to authenticated using (true);
create policy read_authenticated on watched_dates    for select to authenticated using (true);

-- O app só pode criar pedido pendente em nome do próprio usuário.
create policy insert_own_pending on collect_requests for insert to authenticated
  with check (requested_by = auth.uid() and status = 'pending' and done_at is null);

-- Grants explícitos: não depender dos privilégios padrão do projeto Supabase.
-- O que cada papel vê de fato continua decidido pelas políticas de RLS acima.
revoke all on cities, city_source_ids, route_hubs, trips, price_history, leg_stats,
              collector_runs, collect_requests, watched_dates from anon, authenticated;
grant select on cities, city_source_ids, route_hubs, trips, price_history, leg_stats,
                collector_runs, collect_requests, watched_dates to authenticated;
grant insert on collect_requests to authenticated;
grant all on cities, city_source_ids, route_hubs, trips, price_history, leg_stats,
             collector_runs, collect_requests, watched_dates to service_role;
