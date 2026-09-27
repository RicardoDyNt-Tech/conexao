-- Fase 5b: datas monitoradas e alertas no Telegram.
-- Regras (docs/plano.md, F9):
--   * preço-alvo: a combinação mais barata da data (preço de vitrine) ficou <= max_price.
--     Avisa de novo só se ficar ainda mais barata; mudar o alvo recomeça a contagem.
--   * assentos acabando: a combinação mais barata tem algum trecho com <= min_seats_alert
--     lugares. Uma vez por combinação.
-- O app só vê e edita os próprios alertas. A avaliação e o registro do envio são do coletor
-- (service_role). Idempotente.

alter table watched_dates alter column user_id set default auth.uid();
alter table watched_dates add column if not exists price_alerted numeric(10,2);   -- último preço avisado
alter table watched_dates add column if not exists seats_alerted_key text;        -- combinação já avisada
alter table watched_dates add column if not exists created_at timestamptz not null default now();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'watched_dates_max_price_chk') then
    alter table watched_dates add constraint watched_dates_max_price_chk check (max_price is null or max_price > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'watched_dates_min_seats_chk') then
    alter table watched_dates add constraint watched_dates_min_seats_chk
      check (min_seats_alert is null or min_seats_alert between 1 and 50);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'watched_dates_chat_chk') then
    alter table watched_dates add constraint watched_dates_chat_chk
      check (telegram_chat_id is null or telegram_chat_id ~ '^-?[0-9]{1,20}$');
  end if;
end $$;

-- Um alerta ativo por pessoa × sentido × data.
create unique index if not exists watched_dates_one_active_idx
  on watched_dates (user_id, origin_city_id, dest_city_id, travel_date) where active;

-- Mudou o alvo ou o limite de lugares: volta a poder avisar.
create or replace function reset_watch_alert_state() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.max_price is distinct from old.max_price then new.price_alerted := null; end if;
  if new.min_seats_alert is distinct from old.min_seats_alert then new.seats_alerted_key := null; end if;
  if new.active and not old.active then new.price_alerted := null; new.seats_alerted_key := null; end if;
  return new;
end $$;
drop trigger if exists watched_dates_reset_alert_state on watched_dates;
create trigger watched_dates_reset_alert_state
before update on watched_dates
for each row execute function reset_watch_alert_state();

-- RLS: cada um com os seus alertas. Datas entre hoje e hoje + 30 (o coletor vai até 30 dias).
drop policy if exists read_authenticated on watched_dates;
drop policy if exists watched_read_own on watched_dates;
create policy watched_read_own on watched_dates for select to authenticated using (user_id = auth.uid());
drop policy if exists watched_insert_own on watched_dates;
create policy watched_insert_own on watched_dates for insert to authenticated
  with check (user_id = auth.uid() and active
              and travel_date between (now() at time zone 'America/Bahia')::date
                                  and (now() at time zone 'America/Bahia')::date + 30);
drop policy if exists watched_update_own on watched_dates;
create policy watched_update_own on watched_dates for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists watched_delete_own on watched_dates;
create policy watched_delete_own on watched_dates for delete to authenticated using (user_id = auth.uid());

-- O app escolhe o que monitorar; o estado dos avisos (price_alerted etc.) é só do coletor.
revoke insert, update, delete on watched_dates from authenticated;
grant insert (origin_city_id, dest_city_id, travel_date, max_price, min_seats_alert, telegram_chat_id)
  on watched_dates to authenticated;
grant update (max_price, min_seats_alert, telegram_chat_id, active) on watched_dates to authenticated;
grant delete on watched_dates to authenticated;

-- A combinação mais barata de uma data (mesma regra de find_connections, ordenada por preço).
create or replace function watch_best(p_origin int, p_dest int, p_date date)
returns table (
  total_price numeric,
  service_fee numeric,          -- taxa cobrada no pagamento (QP), fora do preço comparado
  departure_at timestamptz,
  arrival_at timestamptz,
  kind text,
  via_city text,
  min_seats int,                -- menor nº de lugares entre os trechos
  seats_leg int,                -- trecho com menos lugares (1 ou 2)
  option_key text,              -- identifica a combinação (ids dos trechos)
  data_as_of timestamptz
)
language sql stable set search_path = public as $$
  select c.total_price,
         coalesce(c.leg1_service_fee, 0) + coalesce(c.leg2_service_fee, 0),
         c.departure_at, c.arrival_at, c.kind, c.via_city,
         least(c.leg1_seats, c.leg2_seats),
         case when c.leg2_seats is not null and (c.leg1_seats is null or c.leg2_seats < c.leg1_seats) then 2 else 1 end,
         c.leg1_trip_id || '-' || coalesce(c.leg2_trip_id::text, '0'),
         c.data_as_of
  from find_connections(p_origin, p_dest, p_date, p_order => 'price') c
  limit 1
$$;

-- Tela "Alertas" do app: os alertas ativos do usuário, com a melhor opção de agora.
create or replace function watch_status()
returns table (
  id bigint,
  origin_city_id int,
  origin_city text,
  dest_city_id int,
  dest_city text,
  travel_date date,
  max_price numeric,
  min_seats_alert int,
  telegram_chat_id text,
  last_alerted_at timestamptz,
  best_price numeric,
  best_service_fee numeric,
  best_departure_at timestamptz,
  best_arrival_at timestamptz,
  best_via text,
  best_min_seats int,
  data_as_of timestamptz
)
language sql stable set search_path = public as $$
  select w.id, w.origin_city_id, co.name, w.dest_city_id, cd.name, w.travel_date,
         w.max_price, w.min_seats_alert, w.telegram_chat_id, w.last_alerted_at,
         b.total_price, b.service_fee, b.departure_at, b.arrival_at, b.via_city, b.min_seats, b.data_as_of
  from watched_dates w
  join cities co on co.id = w.origin_city_id
  join cities cd on cd.id = w.dest_city_id
  left join lateral watch_best(w.origin_city_id, w.dest_city_id, w.travel_date) b on true
  where w.active and w.user_id = auth.uid()
    and w.travel_date >= (now() at time zone 'America/Bahia')::date
  order by w.travel_date, co.name
$$;

-- Coletor: alertas a enviar agora (não altera nada; o envio é registrado com mark_watch_alert).
create or replace function evaluate_watch_alerts()
returns table (
  watch_id bigint,
  kind text,                    -- 'price' | 'seats'
  telegram_chat_id text,
  origin_city_id int,
  origin_city text,
  dest_city_id int,
  dest_city text,
  travel_date date,
  max_price numeric,
  min_seats_alert int,
  total_price numeric,
  service_fee numeric,
  departure_at timestamptz,
  arrival_at timestamptz,
  via_city text,
  min_seats int,
  seats_leg int,
  option_key text,
  data_as_of timestamptz
)
language sql stable set search_path = public as $$
  with b as (
    select w.id as wid, w.telegram_chat_id as chat, w.origin_city_id as o_id, co.name as o_name,
           w.dest_city_id as d_id, cd.name as d_name, w.travel_date as dt, w.max_price as target,
           w.min_seats_alert as seats_limit, w.price_alerted, w.seats_alerted_key, x.*
    from watched_dates w
    join cities co on co.id = w.origin_city_id
    join cities cd on cd.id = w.dest_city_id
    cross join lateral watch_best(w.origin_city_id, w.dest_city_id, w.travel_date) x
    where w.active and w.travel_date >= (now() at time zone 'America/Bahia')::date
  )
  select wid, 'price', chat, o_id, o_name, d_id, d_name, dt, target, seats_limit,
         b.total_price, b.service_fee, b.departure_at, b.arrival_at, b.via_city, b.min_seats, b.seats_leg,
         b.option_key, b.data_as_of
  from b
  where target is not null and b.total_price <= target
    and (price_alerted is null or b.total_price < price_alerted)
  union all
  select wid, 'seats', chat, o_id, o_name, d_id, d_name, dt, target, seats_limit,
         b.total_price, b.service_fee, b.departure_at, b.arrival_at, b.via_city, b.min_seats, b.seats_leg,
         b.option_key, b.data_as_of
  from b
  where seats_limit is not null and b.min_seats is not null and b.min_seats <= seats_limit
    and seats_alerted_key is distinct from b.option_key
  order by 8, 2
$$;

-- Coletor: registra que o aviso saiu (só depois do envio dar certo).
create or replace function mark_watch_alert(p_watch_id bigint, p_kind text, p_price numeric, p_option_key text)
returns void
language sql set search_path = public as $$
  update watched_dates set
    price_alerted = case when p_kind = 'price' then p_price else price_alerted end,
    seats_alerted_key = case when p_kind = 'seats' then p_option_key else seats_alerted_key end,
    last_alerted_at = now()
  where id = p_watch_id
$$;

revoke execute on function watch_best(int, int, date) from public, anon;
grant  execute on function watch_best(int, int, date) to authenticated, service_role;
revoke execute on function watch_status() from public, anon;
grant  execute on function watch_status() to authenticated, service_role;
revoke execute on function evaluate_watch_alerts() from public, anon, authenticated;
grant  execute on function evaluate_watch_alerts() to service_role;
revoke execute on function mark_watch_alert(bigint, text, numeric, text) from public, anon, authenticated;
grant  execute on function mark_watch_alert(bigint, text, numeric, text) to service_role;
revoke execute on function reset_watch_alert_state() from public, anon, authenticated;
