-- Folga mínima padrão entre o 1º e o 2º ônibus: 60 min → 20 min (pedido do Ricardo).
-- Só muda o valor padrão de p_min_layover; o resto das funções é igual a 20261002000100.
-- create or replace mantém as permissões. watch_best (alertas) usa o padrão e acompanha.
-- Idempotente.

create or replace function find_connections(
  p_origin int,
  p_dest int,
  p_date date,
  p_min_layover interval default '20 min',
  p_max_layover interval default '4 h',
  p_order text default 'arrival',          -- 'arrival' | 'price' | 'duration'
  p_earliest_only boolean default true,    -- para cada 1º ônibus, só o 2º que chega mais cedo
  p_hide_dominated boolean default true    -- esconde opções dominadas
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
  leg1_source text,
  leg1_service_fee numeric,
  leg1_offers jsonb,                -- todas as fontes com esse ônibus (preço + link)
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
  leg2_source text,
  leg2_service_fee numeric,
  leg2_offers jsonb,
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
           t.source as l1_source, t.service_fee as l1_fee, t.offers as l1_offers,
           null::bigint as l2_id, null::text as l2_company, null::text as l2_class,
           null::text as l2_from, null::text as l2_to,
           null::timestamptz as l2_dep, null::timestamptz as l2_arr, null::numeric as l2_price,
           null::int as l2_seats, null::text as l2_url,
           null::text as l2_source, null::numeric as l2_fee, null::jsonb as l2_offers,
           t.departure_at as dep, t.arrival_at as arr, null::interval as wait,
           t.arrival_at - t.departure_at as dur, t.price as total,
           null::boolean as same_st, t.fetched_at as as_of,
           1::bigint as rn
    from trips_best t
    where t.origin_city_id = p_origin and t.dest_city_id = p_dest and t.travel_date = p_date

    union all

    select 'connection', h.id, h.name,
           t1.id, t1.company, t1.service_class, t1.origin_station, t1.dest_station,
           t1.departure_at, t1.arrival_at, t1.price, t1.seats_available, t1.buy_url,
           t1.source, t1.service_fee, t1.offers,
           t2.id, t2.company, t2.service_class, t2.origin_station, t2.dest_station,
           t2.departure_at, t2.arrival_at, t2.price, t2.seats_available, t2.buy_url,
           t2.source, t2.service_fee, t2.offers,
           t1.departure_at, t2.arrival_at, t2.departure_at - t1.arrival_at,
           t2.arrival_at - t1.departure_at, t1.price + t2.price,
           -- Sem id de rodoviária numa das pontas (ex.: QP): não dá para afirmar que é a mesma.
           case when t1.dest_station_id is null or t2.origin_station_id is null then null
                else t1.dest_station_id = t2.origin_station_id end,
           least(t1.fetched_at, t2.fetched_at),
           -- Empate na chegada: mais barato, depois o que sai mais tarde (espera menor).
           row_number() over (partition by t1.id
                              order by t2.arrival_at, t2.price, t2.departure_at desc, t2.id)
    from trips_best t1
    join trips_best t2
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
         l1_source, l1_fee, l1_offers,
         l2_id, l2_company, l2_class, l2_from, l2_to, l2_dep, l2_arr, l2_price, l2_seats, l2_url,
         l2_source, l2_fee, l2_offers,
         dep, arr, wait, dur, total, same_st, as_of
  from best
  order by case when p_order = 'price' then total end,
           case when p_order = 'duration' then dur end,
           arr, total, dep desc;
end $$;

create or replace function find_second_legs(
  p_first_trip_id bigint,
  p_dest int,
  p_min_layover interval default '20 min',
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
  source text,
  service_fee numeric,
  offers jsonb,
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
         t2.source, t2.service_fee, t2.offers,
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
  join trips_best t2
    on t2.origin_city_id = t1.dest_city_id
   and t2.dest_city_id = p_dest
   and t2.travel_date between t1.travel_date and t1.travel_date + 1
  where t1.id = p_first_trip_id
  order by t2.departure_at
$$;
