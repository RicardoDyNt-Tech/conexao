-- Fase 3: "atualizar agora" (collect_requests).

alter table collect_requests
  add column started_at timestamptz,
  add column error text;

-- No máximo 1 pedido em aberto (pending/running) por origem × destino × data.
create unique index collect_requests_one_open_idx
  on collect_requests (origin_city_id, dest_city_id, travel_date)
  where status in ('pending', 'running');

-- O app chama esta função em vez de inserir direto: se já houver pedido em aberto
-- para o mesmo par e data, devolve o id dele em vez de criar outro.
create function request_collect(p_origin int, p_dest int, p_date date) returns bigint
language plpgsql set search_path = public as $$
declare
  v_id bigint;
begin
  if p_date < (now() at time zone 'America/Bahia')::date then
    raise exception 'data no passado: %', p_date;
  end if;

  insert into collect_requests (origin_city_id, dest_city_id, travel_date)
  values (p_origin, p_dest, p_date)
  on conflict (origin_city_id, dest_city_id, travel_date) where status in ('pending', 'running')
  do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from collect_requests
    where origin_city_id = p_origin and dest_city_id = p_dest and travel_date = p_date
      and status in ('pending', 'running');
  end if;
  return v_id;
end $$;

-- O coletor pega o próximo pedido e marca como running, numa operação só.
-- Pedido "running" há mais de 30 min (PC desligou no meio) volta para a fila.
create function claim_collect_request() returns setof collect_requests
language sql set search_path = public as $$
  update collect_requests
  set status = 'running', started_at = now(), error = null
  where id = (
    select id from collect_requests
    where status = 'pending'
       or (status = 'running' and started_at < now() - interval '30 min')
    order by created_at, id
    limit 1
    for update skip locked)
  returning *;
$$;

revoke execute on function request_collect(int, int, date) from public, anon;
grant  execute on function request_collect(int, int, date) to authenticated, service_role;
revoke execute on function claim_collect_request() from public, anon, authenticated;
grant  execute on function claim_collect_request() to service_role;

-- Realtime: o worker escuta inserts nesta tabela (se não der, faz polling).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table collect_requests;
  end if;
end $$;
