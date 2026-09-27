-- Fase 2: gravação da coleta e cruzamento de horários.
-- Todo cruzamento fica aqui no SQL (não duplicar no front).

-- ---------------------------------------------------------------------------
-- record_leg_result: o coletor chama uma vez por trecho × data.
-- Numa transação só: upsert em trips, remove viagens que sumiram da fonte,
-- registra collector_runs e atualiza leg_stats.
-- ---------------------------------------------------------------------------
create function record_leg_result(
  p_source text,
  p_from_slug text,
  p_to_slug text,
  p_date date,
  p_status text,
  p_trips jsonb default '[]',
  p_error text default null,
  p_started_at timestamptz default now(),
  p_finished_at timestamptz default now()
) returns bigint
language plpgsql set search_path = public as $$
declare
  v_origin int;
  v_dest int;
  v_run_id bigint;
  v_found int := coalesce(jsonb_array_length(p_trips), 0);
begin
  select city_id into v_origin from city_source_ids where source = p_source and source_slug = p_from_slug;
  select city_id into v_dest   from city_source_ids where source = p_source and source_slug = p_to_slug;
  if v_origin is null or v_dest is null then
    raise exception 'slug desconhecido em city_source_ids: % → % (%)', p_from_slug, p_to_slug, p_source;
  end if;

  if p_status in ('ok', 'empty') then
    insert into trips as t (
      source, source_trip_id, origin_city_id, dest_city_id, travel_date,
      company, company_slug, origin_station, origin_station_id, dest_station, dest_station_id,
      departure_at, arrival_at, service_class, price, original_price,
      seats_available, seats_total, is_low_fare, parts_count, buy_url, fetched_at)
    select
      p_source, r.source_trip_id, v_origin, v_dest, r.travel_date,
      r.company, r.company_slug, r.origin_station, r.origin_station_id, r.dest_station, r.dest_station_id,
      r.departure_at, r.arrival_at, r.service_class, r.price, r.original_price,
      r.seats_available, r.seats_total, r.is_low_fare, coalesce(r.parts_count, 1), r.buy_url, p_finished_at
    from jsonb_to_recordset(p_trips) as r (
      source_trip_id text, travel_date date, company text, company_slug text,
      origin_station text, origin_station_id int, dest_station text, dest_station_id int,
      departure_at timestamptz, arrival_at timestamptz, service_class text,
      price numeric, original_price numeric, seats_available int, seats_total int,
      is_low_fare boolean, parts_count int, buy_url text)
    on conflict (source, source_trip_id) do update set
      travel_date = excluded.travel_date,
      company = excluded.company, company_slug = excluded.company_slug,
      origin_station = excluded.origin_station, origin_station_id = excluded.origin_station_id,
      dest_station = excluded.dest_station, dest_station_id = excluded.dest_station_id,
      departure_at = excluded.departure_at, arrival_at = excluded.arrival_at,
      service_class = excluded.service_class, price = excluded.price,
      original_price = excluded.original_price, seats_available = excluded.seats_available,
      seats_total = excluded.seats_total, is_low_fare = excluded.is_low_fare,
      parts_count = excluded.parts_count, buy_url = excluded.buy_url,
      fetched_at = excluded.fetched_at;

    -- Viagem que não veio nesta coleta (lotou/cancelada) sai da busca.
    -- Só em ok/empty: com blocked/error não sabemos o estado real, então mantemos.
    delete from trips t
    where t.source = p_source and t.origin_city_id = v_origin and t.dest_city_id = v_dest
      and t.travel_date = p_date
      and t.source_trip_id not in (select e->>'source_trip_id' from jsonb_array_elements(p_trips) e);
  end if;

  insert into collector_runs (source, origin_city_id, dest_city_id, travel_date, status,
                              trips_found, error, started_at, finished_at)
  values (p_source, v_origin, v_dest, p_date, p_status,
          case when p_status in ('ok', 'empty') then v_found end, p_error, p_started_at, p_finished_at)
  returning id into v_run_id;

  if p_status in ('ok', 'empty') then
    -- Média das últimas coletas de cada data (30 dias), para não contar a mesma data 2×.
    insert into leg_stats as s (origin_city_id, dest_city_id, has_service, avg_daily_trips, last_checked_at)
    select v_origin, v_dest, max(x.trips_found) > 0, round(avg(x.trips_found), 2), p_finished_at
    from (
      select distinct on (travel_date) trips_found
      from collector_runs
      where source = p_source and origin_city_id = v_origin and dest_city_id = v_dest
        and status in ('ok', 'empty') and travel_date >= p_date - 30
      order by travel_date, started_at desc, id desc
    ) x
    on conflict (origin_city_id, dest_city_id) do update set
      has_service = excluded.has_service,
      avg_daily_trips = excluded.avg_daily_trips,
      last_checked_at = excluded.last_checked_at;
  end if;

  return v_run_id;
end $$;

-- ---------------------------------------------------------------------------
-- find_connections: diretas + 1 conexão por qualquer cidade H.
-- A espera usa a hora REAL de chegada do 1º ônibus; o 2º pode sair em p_date ou p_date + 1.
-- ---------------------------------------------------------------------------
create function find_connections(
  p_origin int,
  p_dest int,
  p_date date,
  p_min_layover interval default '60 min',
  p_max_layover interval default '4 h'
) returns table (
  kind text,                        -- 'direct' | 'connection'
  via_city_id int,
  via_city text,
  leg1_trip_id bigint,
  leg1_company text,
  leg1_service_class text,
  leg1_origin_station text,
  leg1_dest_station text,
  leg1_departure_at timestamptz,
  leg1_arrival_at timestamptz,
  leg1_price numeric,
  leg1_seats int,
  leg1_buy_url text,
  leg2_trip_id bigint,
  leg2_company text,
  leg2_service_class text,
  leg2_origin_station text,
  leg2_dest_station text,
  leg2_departure_at timestamptz,
  leg2_arrival_at timestamptz,
  leg2_price numeric,
  leg2_seats int,
  leg2_buy_url text,
  departure_at timestamptz,
  arrival_at timestamptz,
  layover interval,
  total_duration interval,
  total_price numeric,
  same_station boolean,
  data_as_of timestamptz
)
language sql stable set search_path = public as $$
  select 'direct', null::int, null::text,
         t.id, t.company, t.service_class, t.origin_station, t.dest_station,
         t.departure_at, t.arrival_at, t.price, t.seats_available, t.buy_url,
         null::bigint, null, null, null, null, null::timestamptz, null::timestamptz, null::numeric, null::int, null,
         -- Aliases únicos: o ORDER BY do union usa os nomes do 1º bloco.
         t.departure_at as final_departure_at, t.arrival_at as final_arrival_at,
         null::interval, t.arrival_at - t.departure_at, t.price as total_price,
         null::boolean, t.fetched_at
  from trips t
  where t.origin_city_id = p_origin and t.dest_city_id = p_dest and t.travel_date = p_date

  union all

  select 'connection', h.id, h.name,
         t1.id, t1.company, t1.service_class, t1.origin_station, t1.dest_station,
         t1.departure_at, t1.arrival_at, t1.price, t1.seats_available, t1.buy_url,
         t2.id, t2.company, t2.service_class, t2.origin_station, t2.dest_station,
         t2.departure_at, t2.arrival_at, t2.price, t2.seats_available, t2.buy_url,
         t1.departure_at, t2.arrival_at, t2.departure_at - t1.arrival_at,
         t2.arrival_at - t1.departure_at, t1.price + t2.price,
         -- Sem id de rodoviária numa das pontas: não dá para afirmar que é a mesma.
         case when t1.dest_station_id is null or t2.origin_station_id is null then null
              else t1.dest_station_id = t2.origin_station_id end,
         least(t1.fetched_at, t2.fetched_at)
  from trips t1
  join trips t2
    on t2.origin_city_id = t1.dest_city_id
   and t2.dest_city_id = p_dest
   and t2.travel_date between p_date and p_date + 1
   and t2.departure_at between t1.arrival_at + p_min_layover and t1.arrival_at + p_max_layover
  join cities h on h.id = t1.dest_city_id
  where t1.origin_city_id = p_origin
    and t1.travel_date = p_date
    and t1.dest_city_id not in (p_origin, p_dest)

  order by total_price, final_arrival_at, final_departure_at
$$;

-- ---------------------------------------------------------------------------
-- find_second_legs: modo "monte você mesmo". Dado o 1º ônibus, devolve TODOS os
-- 2º trechos do hub (no dia do 1º e no seguinte), marcando os incompatíveis e o motivo.
-- ---------------------------------------------------------------------------
create function find_second_legs(
  p_first_trip_id bigint,
  p_dest int,
  p_min_layover interval default '60 min',
  p_max_layover interval default '4 h'
) returns table (
  trip_id bigint,
  company text,
  service_class text,
  origin_station text,
  dest_station text,
  departure_at timestamptz,
  arrival_at timestamptz,
  price numeric,
  seats_available int,
  buy_url text,
  fetched_at timestamptz,
  layover interval,                 -- negativo quando sai antes da chegada do 1º
  total_duration interval,
  total_price numeric,
  same_station boolean,
  compatible boolean,
  reason text
)
language sql stable set search_path = public as $$
  select t2.id, t2.company, t2.service_class, t2.origin_station, t2.dest_station,
         t2.departure_at, t2.arrival_at, t2.price, t2.seats_available, t2.buy_url, t2.fetched_at,
         t2.departure_at - t1.arrival_at,
         t2.arrival_at - t1.departure_at,
         t1.price + t2.price,
         case when t1.dest_station_id is null or t2.origin_station_id is null then null
              else t1.dest_station_id = t2.origin_station_id end,
         t2.departure_at - t1.arrival_at between p_min_layover and p_max_layover,
         case
           when t2.departure_at < t1.arrival_at then 'sai antes de você chegar'
           when t2.departure_at - t1.arrival_at < p_min_layover then 'espera abaixo do mínimo'
           when t2.departure_at - t1.arrival_at > p_max_layover then 'espera acima do limite'
         end
  from trips t1
  join trips t2
    on t2.origin_city_id = t1.dest_city_id
   and t2.dest_city_id = p_dest
   and t2.travel_date between t1.travel_date and t1.travel_date + 1
  where t1.id = p_first_trip_id
  order by t2.departure_at
$$;

-- Permissões. Funções de busca: só autenticados (security invoker → RLS vale).
-- record_leg_result: só o coletor (service_role).
revoke execute on function record_leg_result(text, text, text, date, text, jsonb, text, timestamptz, timestamptz) from public, anon, authenticated;
grant  execute on function record_leg_result(text, text, text, date, text, jsonb, text, timestamptz, timestamptz) to service_role;
revoke execute on function find_connections(int, int, date, interval, interval) from public, anon;
grant  execute on function find_connections(int, int, date, interval, interval) to authenticated, service_role;
revoke execute on function find_second_legs(bigint, int, interval, interval) from public, anon;
grant  execute on function find_second_legs(bigint, int, interval, interval) to authenticated, service_role;
revoke execute on function log_trip_price_change() from public, anon, authenticated;
