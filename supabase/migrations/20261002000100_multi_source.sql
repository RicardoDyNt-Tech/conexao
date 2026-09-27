-- Fase 5a: Quero Passagem como 2ª fonte.
-- 1. trips.service_fee: taxa cobrada só no pagamento (QP). A comparação usa o preço de vitrine.
-- 2. normalize_company(): "Rota Transportes" (QP) e "rota-transportes" (ClickBus) → "rota".
-- 3. trips_best: o mesmo ônibus em várias fontes vira 1 linha (menor preço; empate: fetched_at
--    mais recente), com a lista de fontes e as ofertas (preço + link de cada uma). Só trechos
--    diretos (parts_count = 1): conexão vendida pronta não entra no cruzamento.
-- 4. find_connections / find_second_legs leem de trips_best e devolvem as ofertas.
-- 5. collector_status(): quarentena e última rodada POR FONTE.
-- Idempotente (pode rodar de novo): if not exists / create or replace / drop … if exists.

alter table trips add column if not exists service_fee numeric(10,2);

create or replace function normalize_company(p text) returns text
language sql immutable set search_path = public as $$
  select nullif(trim(both '-' from regexp_replace(
    regexp_replace(
      regexp_replace(
        lower(translate(coalesce(p, ''),
          'ÁÀÂÃÄáàâãäÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÇç',
          'AAAAAaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCc')),
        '[^a-z0-9]+', '-', 'g'),
      -- palavras genéricas que variam entre os sites
      '(^|-)(auto|viacao|transportes?|turismo|empresa|expresso|ltda|sa|s-a)(?=-|$)', '\1', 'g'),
    '-+', '-', 'g')), '')
$$;

create or replace function record_leg_result(
  p_source text,
  p_from_slug text,
  p_to_slug text,
  p_date date,
  p_status text,
  p_trips jsonb default '[]',
  p_error text default null,
  p_detail text default null,
  p_started_at timestamptz default now(),
  p_finished_at timestamptz default now(),
  p_round_id uuid default null
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
      departure_at, arrival_at, service_class, price, original_price, service_fee,
      seats_available, seats_total, is_low_fare, parts_count, buy_url, fetched_at)
    select
      p_source, r.source_trip_id, v_origin, v_dest, r.travel_date,
      r.company, r.company_slug, r.origin_station, r.origin_station_id, r.dest_station, r.dest_station_id,
      r.departure_at, r.arrival_at, r.service_class, r.price, r.original_price, r.service_fee,
      r.seats_available, r.seats_total, r.is_low_fare, coalesce(r.parts_count, 1), r.buy_url, p_finished_at
    from jsonb_to_recordset(p_trips) as r (
      source_trip_id text, travel_date date, company text, company_slug text,
      origin_station text, origin_station_id int, dest_station text, dest_station_id int,
      departure_at timestamptz, arrival_at timestamptz, service_class text,
      price numeric, original_price numeric, service_fee numeric, seats_available int, seats_total int,
      is_low_fare boolean, parts_count int, buy_url text)
    on conflict (source, source_trip_id) do update set
      travel_date = excluded.travel_date,
      company = excluded.company, company_slug = excluded.company_slug,
      origin_station = excluded.origin_station, origin_station_id = excluded.origin_station_id,
      dest_station = excluded.dest_station, dest_station_id = excluded.dest_station_id,
      departure_at = excluded.departure_at, arrival_at = excluded.arrival_at,
      service_class = excluded.service_class, price = excluded.price,
      original_price = excluded.original_price, service_fee = excluded.service_fee,
      seats_available = excluded.seats_available,
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
                              trips_found, error, detail, started_at, finished_at, round_id)
  values (p_source, v_origin, v_dest, p_date, p_status,
          case when p_status in ('ok', 'empty') then v_found end, p_error, p_detail, p_started_at, p_finished_at,
          p_round_id)
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

drop view if exists trips_best;
-- security_invoker: quem consulta a view passa pelo RLS de trips (autenticados leem).
create view trips_best with (security_invoker = true) as
select b.*, o.sources, o.offers
from (
  select distinct on (t.origin_city_id, t.dest_city_id, t.travel_date, k.company_key, t.departure_at, t.arrival_at)
         t.*, k.company_key
  from trips t
  cross join lateral (select normalize_company(coalesce(nullif(t.company_slug, ''), t.company)) as company_key) k
  where t.parts_count = 1
  order by t.origin_city_id, t.dest_city_id, t.travel_date, k.company_key, t.departure_at, t.arrival_at,
           t.price asc nulls last, t.fetched_at desc, t.id
) b
cross join lateral (
  select array_agg(distinct d.source order by d.source) as sources,
         jsonb_agg(jsonb_build_object(
           'source', d.source, 'trip_id', d.id, 'price', d.price, 'service_fee', d.service_fee,
           'seats_available', d.seats_available, 'service_class', d.service_class,
           'buy_url', d.buy_url, 'fetched_at', d.fetched_at)
           order by d.price asc nulls last, d.fetched_at desc) as offers
  from trips d
  where d.parts_count = 1
    and d.origin_city_id = b.origin_city_id and d.dest_city_id = b.dest_city_id
    and d.travel_date = b.travel_date
    and d.departure_at = b.departure_at and d.arrival_at = b.arrival_at
    and normalize_company(coalesce(nullif(d.company_slug, ''), d.company)) is not distinct from b.company_key
) o;

drop function if exists find_connections(int, int, date, interval, interval, text, boolean, boolean);
create function find_connections(
  p_origin int,
  p_dest int,
  p_date date,
  p_min_layover interval default '60 min',
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

drop function if exists find_second_legs(bigint, int, interval, interval);
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

-- Quarentena: mesma regra do coletor (collector/src/quarantine.ts, 24 h), agora por fonte.
-- Ativa se o último bloqueio DA FONTE foi há menos de 24 h e nenhuma coleta dela deu certo depois.
create or replace function collector_status() returns jsonb
language sql stable set search_path = public as $$
  with srcs as (
    select source from city_source_ids union select source from collector_runs
  ),
  per_source as (
    select s.source,
      (select jsonb_build_object(
                'until', b.finished_at + interval '24 hours', 'since', b.finished_at, 'reason', b.error,
                'from_city', co.name, 'to_city', cd.name, 'travel_date', b.travel_date)
       from (select * from collector_runs r where r.source = s.source and r.status = 'blocked'
             order by r.finished_at desc nulls last, r.id desc limit 1) b
       left join cities co on co.id = b.origin_city_id
       left join cities cd on cd.id = b.dest_city_id
       where b.finished_at + interval '24 hours' > now()
         and not exists (select 1 from collector_runs r2
                         where r2.source = s.source and r2.status in ('ok', 'empty')
                           and r2.finished_at > b.finished_at)) as quarantine,
      (select case when count(*) = 0 then null else jsonb_build_object(
                'started_at', min(r.started_at), 'finished_at', max(r.finished_at),
                'ok', count(*) filter (where r.status = 'ok'),
                'empty', count(*) filter (where r.status = 'empty'),
                'error', count(*) filter (where r.status = 'error'),
                'blocked', count(*) filter (where r.status = 'blocked')) end
       from collector_runs r
       where r.source = s.source
         and coalesce(r.round_id::text, 'run-' || r.id) = (
           select coalesce(x.round_id::text, 'run-' || x.id) from collector_runs x
           where x.source = s.source order by x.finished_at desc nulls last, x.id desc limit 1)) as last_round
    from srcs s
  ),
  -- Rodada geral = round_id mais recente (compatível com a versão anterior).
  last_key as (
    select coalesce(round_id::text, 'run-' || id) as k
    from collector_runs order by finished_at desc nulls last, id desc limit 1
  ),
  last_round as (
    select min(started_at) as started_at, max(finished_at) as finished_at,
           count(*) filter (where status = 'ok') as ok,
           count(*) filter (where status = 'empty') as empty,
           count(*) filter (where status = 'error') as error,
           count(*) filter (where status = 'blocked') as blocked
    from collector_runs
    where coalesce(round_id::text, 'run-' || id) = (select k from last_key)
  )
  select jsonb_build_object(
    'last_round', (select case when started_at is null and finished_at is null then null
                               else to_jsonb(lr) end from last_round lr),
    -- 'quarantine' (compatível): a quarentena ativa que termina por último, com a fonte.
    'quarantine', (select ps.quarantine || jsonb_build_object('source', ps.source)
                   from per_source ps where ps.quarantine is not null
                   order by ps.quarantine->>'until' desc limit 1),
    'sources', coalesce((select jsonb_agg(jsonb_build_object(
                           'source', ps.source, 'quarantine', ps.quarantine, 'last_round', ps.last_round)
                           order by ps.source) from per_source ps), '[]'::jsonb),
    'open_requests', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', r.id, 'status', r.status, 'travel_date', r.travel_date, 'created_at', r.created_at,
               'from_city', co.name, 'to_city', cd.name) order by r.created_at)
      from collect_requests r
      join cities co on co.id = r.origin_city_id
      join cities cd on cd.id = r.dest_city_id
      where r.status in ('pending', 'running')), '[]'::jsonb),
    'collected_dates', coalesce((
      select jsonb_agg(d order by d)
      from (select distinct travel_date as d from collector_runs
            where status in ('ok', 'empty')
              and travel_date >= (now() at time zone 'America/Bahia')::date) x), '[]'::jsonb)
  )
$$;

revoke all on trips_best from anon;
grant select on trips_best to authenticated, service_role;
revoke execute on function record_leg_result(text, text, text, date, text, jsonb, text, text, timestamptz, timestamptz, uuid) from public, anon, authenticated;
grant  execute on function record_leg_result(text, text, text, date, text, jsonb, text, text, timestamptz, timestamptz, uuid) to service_role;
revoke execute on function find_connections(int, int, date, interval, interval, text, boolean, boolean) from public, anon;
grant  execute on function find_connections(int, int, date, interval, interval, text, boolean, boolean) to authenticated, service_role;
revoke execute on function find_second_legs(bigint, int, interval, interval) from public, anon;
grant  execute on function find_second_legs(bigint, int, interval, interval) to authenticated, service_role;
revoke execute on function collector_status() from public, anon;
grant  execute on function collector_status() to authenticated, service_role;
