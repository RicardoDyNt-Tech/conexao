-- Alertas com janela de horário: "sair depois de" e "chegar até" (Bahia, no dia da viagem),
-- iguais aos filtros da busca. Preço-alvo e poucos lugares olham a combinação mais barata
-- DENTRO da janela. Idempotente.

alter table watched_dates add column if not exists depart_after time;
alter table watched_dates add column if not exists arrive_by time;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'watched_dates_window_chk') then
    alter table watched_dates add constraint watched_dates_window_chk
      check (depart_after is null or arrive_by is null or depart_after < arrive_by);
  end if;
end $$;

-- O app pode escolher a janela (criar e editar).
grant insert (depart_after, arrive_by) on watched_dates to authenticated;
grant update (depart_after, arrive_by) on watched_dates to authenticated;

create or replace function reset_watch_alert_state() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.max_price is distinct from old.max_price then new.price_alerted := null; end if;
  if new.min_seats_alert is distinct from old.min_seats_alert then new.seats_alerted_key := null; end if;
  -- Mudou a janela de horário: a melhor opção pode ser outra, então os dois avisos recomeçam.
  if new.depart_after is distinct from old.depart_after or new.arrive_by is distinct from old.arrive_by then
    new.price_alerted := null; new.seats_alerted_key := null;
  end if;
  if new.active and not old.active then new.price_alerted := null; new.seats_alerted_key := null; end if;
  return new;
end $$;

-- Assinaturas/retornos mudaram: remove as versões antigas antes de recriar.
drop function if exists watch_best(int, int, date);
drop function if exists watch_status();
drop function if exists evaluate_watch_alerts();

create or replace function watch_best(p_origin int, p_dest int, p_date date,
  p_depart_after time default null, p_arrive_by time default null)
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
  -- Janela de horário (Bahia, no dia da viagem). Filtrar depois do SQL de cruzamento é seguro:
  -- o que find_connections descarta como dominado é pior e cai nos mesmos filtros.
  where (p_depart_after is null or (c.departure_at at time zone 'America/Bahia') >= p_date + p_depart_after)
    and (p_arrive_by is null or (c.arrival_at at time zone 'America/Bahia') <= p_date + p_arrive_by)
  limit 1
$$;

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
  depart_after time,
  arrive_by time,
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
         w.max_price, w.min_seats_alert, w.telegram_chat_id, w.depart_after, w.arrive_by, w.last_alerted_at,
         b.total_price, b.service_fee, b.departure_at, b.arrival_at, b.via_city, b.min_seats, b.data_as_of
  from watched_dates w
  join cities co on co.id = w.origin_city_id
  join cities cd on cd.id = w.dest_city_id
  left join lateral watch_best(w.origin_city_id, w.dest_city_id, w.travel_date, w.depart_after, w.arrive_by) b on true
  where w.active and w.user_id = auth.uid()
    and w.travel_date >= (now() at time zone 'America/Bahia')::date
  order by w.travel_date, co.name
$$;

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
  depart_after time,
  arrive_by time,
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
           w.min_seats_alert as seats_limit, w.depart_after as after_t, w.arrive_by as by_t,
           w.price_alerted, w.seats_alerted_key, x.*
    from watched_dates w
    join cities co on co.id = w.origin_city_id
    join cities cd on cd.id = w.dest_city_id
    cross join lateral watch_best(w.origin_city_id, w.dest_city_id, w.travel_date, w.depart_after, w.arrive_by) x
    where w.active and w.travel_date >= (now() at time zone 'America/Bahia')::date
  )
  select wid, 'price', chat, o_id, o_name, d_id, d_name, dt, target, seats_limit, after_t, by_t,
         b.total_price, b.service_fee, b.departure_at, b.arrival_at, b.via_city, b.min_seats, b.seats_leg,
         b.option_key, b.data_as_of
  from b
  where target is not null and b.total_price <= target
    and (price_alerted is null or b.total_price < price_alerted)
  union all
  select wid, 'seats', chat, o_id, o_name, d_id, d_name, dt, target, seats_limit, after_t, by_t,
         b.total_price, b.service_fee, b.departure_at, b.arrival_at, b.via_city, b.min_seats, b.seats_leg,
         b.option_key, b.data_as_of
  from b
  where seats_limit is not null and b.min_seats is not null and b.min_seats <= seats_limit
    and seats_alerted_key is distinct from b.option_key
  order by 8, 2
$$;

revoke execute on function watch_best(int, int, date, time, time) from public, anon;
grant  execute on function watch_best(int, int, date, time, time) to authenticated, service_role;
revoke execute on function watch_status() from public, anon;
grant  execute on function watch_status() to authenticated, service_role;
revoke execute on function evaluate_watch_alerts() from public, anon, authenticated;
grant  execute on function evaluate_watch_alerts() to service_role;
