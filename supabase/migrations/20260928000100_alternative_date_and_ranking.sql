-- Ajustes da validação da Fase 2 (27/09/2026).
-- 1. Sem viagens na data pedida, a ClickBus devolve as da próxima data (alternativeDate):
--    a execução vira 'empty' com a próxima data em collector_runs.detail.
-- 2. find_connections: 1 opção por 1º ônibus (o 2º que chega mais cedo), sem combinações
--    dominadas e ordenação escolhível. find_second_legs não muda (devolve tudo).

alter table collector_runs add column detail text;

drop function record_leg_result(text, text, text, date, text, jsonb, text, timestamptz, timestamptz);

create function record_leg_result(
  p_source text,
  p_from_slug text,
  p_to_slug text,
  p_date date,
  p_status text,
  p_trips jsonb default '[]',
  p_error text default null,
  p_detail text default null,
  p_started_at timestamptz default now(),
  p_finished_at timestamptz default now()
) returns bigint
language plpgsql set search_path = public as $$
declare
  v_origin int;
  v_dest int;
  v_run_id bigint;
  -- Só conta viagens da data pedida: sem viagens no dia, a ClickBus devolve as da próxima data.
  v_found int := (select count(*) from jsonb_array_elements(coalesce(p_trips, '[]')) e
                  where (e->>'travel_date')::date = p_date);
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
    -- Só na data pedida: viagens de outra data (próxima disponível) são gravadas, mas
    -- a resposta não diz nada sobre as demais viagens daquela data.
    delete from trips t
    where t.source = p_source and t.origin_city_id = v_origin and t.dest_city_id = v_dest
      and t.travel_date = p_date
      and t.source_trip_id not in (select e->>'source_trip_id' from jsonb_array_elements(p_trips) e);
  end if;

  insert into collector_runs (source, origin_city_id, dest_city_id, travel_date, status,
                              trips_found, error, detail, started_at, finished_at)
  values (p_source, v_origin, v_dest, p_date, p_status,
          case when p_status in ('ok', 'empty') then v_found end, p_error, p_detail, p_started_at, p_finished_at)
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

drop function find_connections(int, int, date, interval, interval);

create function find_connections(
  p_origin int,
  p_dest int,
  p_date date,
  p_min_layover interval default '60 min',
  p_max_layover interval default '4 h',
  p_order text default 'arrival',          -- 'arrival' | 'price' | 'duration'
  p_earliest_only boolean default true,    -- para cada 1º ônibus, só o 2º que chega mais cedo
  p_hide_dominated boolean default true    -- esconde opções dominadas (ver abaixo)
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
language plpgsql stable set search_path = public as $$
#variable_conflict use_column
begin
  if p_order not in ('arrival', 'price', 'duration') then
    raise exception 'p_order inválido: % (use arrival, price ou duration)', p_order;
  end if;

  return query
  with opts as (
    select 'direct'::text as o_kind, null::int as o_via_id, null::text as o_via,
           t.id as l1_id, t.company as l1_company, t.service_class as l1_class,
           t.origin_station as l1_from, t.dest_station as l1_to,
           t.departure_at as l1_dep, t.arrival_at as l1_arr, t.price as l1_price,
           t.seats_available as l1_seats, t.buy_url as l1_url,
           null::bigint as l2_id, null::text as l2_company, null::text as l2_class,
           null::text as l2_from, null::text as l2_to,
           null::timestamptz as l2_dep, null::timestamptz as l2_arr, null::numeric as l2_price,
           null::int as l2_seats, null::text as l2_url,
           t.departure_at as dep, t.arrival_at as arr, null::interval as wait,
           t.arrival_at - t.departure_at as dur, t.price as total,
           null::boolean as same_st, t.fetched_at as as_of,
           1::bigint as rn
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
           least(t1.fetched_at, t2.fetched_at),
           -- Empate na chegada: mais barato, depois o que sai mais tarde (espera menor).
           row_number() over (partition by t1.id
                              order by t2.arrival_at, t2.price, t2.departure_at desc, t2.id)
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
  ),
  kept as (
    select * from opts where not p_earliest_only or rn = 1
  ),
  -- Dominada: existe outra que sai no mesmo horário ou depois, chega no mesmo horário
  -- ou antes e custa igual ou menos, sendo melhor em pelo menos um dos três.
  -- Empate total nos três: fica só uma (a de menor id).
  best as (
    select k.* from kept k
    where not p_hide_dominated or not exists (
      select 1 from kept o
      where o.dep >= k.dep and o.arr <= k.arr and o.total <= k.total
        and (o.dep > k.dep or o.arr < k.arr or o.total < k.total
             or (o.l1_id, coalesce(o.l2_id, 0)) < (k.l1_id, coalesce(k.l2_id, 0)))
    )
  )
  select o_kind, o_via_id, o_via,
         l1_id, l1_company, l1_class, l1_from, l1_to, l1_dep, l1_arr, l1_price, l1_seats, l1_url,
         l2_id, l2_company, l2_class, l2_from, l2_to, l2_dep, l2_arr, l2_price, l2_seats, l2_url,
         dep, arr, wait, dur, total, same_st, as_of
  from best
  order by case when p_order = 'price' then total end,
           case when p_order = 'duration' then dur end,
           arr, total, dep desc;
end $$;

revoke execute on function record_leg_result(text, text, text, date, text, jsonb, text, text, timestamptz, timestamptz) from public, anon, authenticated;
grant  execute on function record_leg_result(text, text, text, date, text, jsonb, text, text, timestamptz, timestamptz) to service_role;
revoke execute on function find_connections(int, int, date, interval, interval, text, boolean, boolean) from public, anon;
grant  execute on function find_connections(int, int, date, interval, interval, text, boolean, boolean) to authenticated, service_role;
