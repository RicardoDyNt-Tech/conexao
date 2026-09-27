-- Fase 4: o app (anon key + RLS) precisa saber o estado do coletor.
-- 1. collector_runs.round_id: agrupa os trechos de uma rodada ("última rodada" no app).
-- 2. collector_status(): última rodada, quarentena, pedidos na fila e datas já coletadas.
-- 3. date_coverage(): quais trechos de uma busca já foram coletados na data
--    (distingue "ainda não coletamos" de "sem combinações").
-- Tudo security invoker: vale o RLS de leitura para autenticados.
--
-- Idempotente: no remoto, collector_runs.round_id já existia antes do 1º push desta migration
-- (criado fora das migrations). Pode rodar de novo sem erro. Não cria policies.

alter table collector_runs add column if not exists round_id uuid;
create index if not exists collector_runs_round_idx on collector_runs (round_id);
create index if not exists collector_runs_finished_idx on collector_runs (finished_at desc);

-- Versão anterior (sem p_round_id): some se ainda existir.
drop function if exists record_leg_result(text, text, text, date, text, jsonb, text, text, timestamptz, timestamptz);

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

-- Quarentena: mesma regra do coletor (collector/src/quarantine.ts, 24 h). Ativa se o último
-- bloqueio foi há menos de 24 h e nenhuma coleta deu certo depois dele (--ignore-quarantine).
create or replace function collector_status() returns jsonb
language sql stable set search_path = public as $$
  with last_block as (
    select finished_at, error, origin_city_id, dest_city_id, travel_date
    from collector_runs where status = 'blocked'
    order by finished_at desc nulls last, id desc limit 1
  ),
  quarantine as (
    select b.*, b.finished_at + interval '24 hours' as until
    from last_block b
    where b.finished_at + interval '24 hours' > now()
      and not exists (select 1 from collector_runs r
                      where r.status in ('ok', 'empty') and r.finished_at > b.finished_at)
  ),
  -- Rodada = round_id; linhas antigas (sem round_id) contam como rodada de 1 trecho.
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
    'quarantine', (select jsonb_build_object(
                     'until', q.until, 'since', q.finished_at, 'reason', q.error,
                     'from_city', co.name, 'to_city', cd.name, 'travel_date', q.travel_date)
                   from quarantine q
                   left join cities co on co.id = q.origin_city_id
                   left join cities cd on cd.id = q.dest_city_id),
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

-- Trechos de uma busca (direta + origem→hub + hub→destino) e a última coleta ok/empty
-- de cada um na data. status null = trecho ainda não coletado nessa data.
create or replace function date_coverage(p_origin int, p_dest int, p_date date)
returns table (
  from_city_id int,
  from_city text,
  to_city_id int,
  to_city text,
  hub_city_id int,
  hub_city text,
  status text,
  trips_found int,
  finished_at timestamptz,
  detail text
)
language sql stable set search_path = public as $$
  with legs (a, b, hub, ord) as (
    select p_origin, p_dest, null::int, 0
    union all
    select h.origin_city_id, h.hub_city_id, h.hub_city_id, 1
    from route_hubs h where h.origin_city_id = p_origin and h.dest_city_id = p_dest
    union all
    select h.hub_city_id, h.dest_city_id, h.hub_city_id, 2
    from route_hubs h where h.origin_city_id = p_origin and h.dest_city_id = p_dest
  )
  select l.a, ca.name, l.b, cb.name, l.hub, ch.name,
         r.status, r.trips_found, r.finished_at, r.detail
  from legs l
  join cities ca on ca.id = l.a
  join cities cb on cb.id = l.b
  left join cities ch on ch.id = l.hub
  left join lateral (
    select cr.status, cr.trips_found, cr.finished_at, cr.detail
    from collector_runs cr
    where cr.origin_city_id = l.a and cr.dest_city_id = l.b and cr.travel_date = p_date
      and cr.status in ('ok', 'empty')
    order by cr.finished_at desc nulls last, cr.id desc
    limit 1
  ) r on true
  order by ch.name nulls first, l.ord
$$;

revoke execute on function record_leg_result(text, text, text, date, text, jsonb, text, text, timestamptz, timestamptz, uuid) from public, anon, authenticated;
grant  execute on function record_leg_result(text, text, text, date, text, jsonb, text, text, timestamptz, timestamptz, uuid) to service_role;
revoke execute on function collector_status() from public, anon;
grant  execute on function collector_status() to authenticated, service_role;
revoke execute on function date_coverage(int, int, date) from public, anon;
grant  execute on function date_coverage(int, int, date) to authenticated, service_role;
