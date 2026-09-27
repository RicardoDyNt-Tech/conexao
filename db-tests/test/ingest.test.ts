import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseClickbusTrips } from '../../collector/src/sources/clickbus.js';
import { FIXTURE, asRole, freshDb } from './db.js';
import { CATU, SALVADOR, record, trip } from './helpers.js';

describe('record_leg_result', () => {
  it('grava a fixture real (18 viagens), collector_runs e leg_stats', async () => {
    const db = await freshDb();
    const q = { from: 'salvador-ba', to: 'catu-ba', date: '2026-10-04' };
    const { trips } = parseClickbusTrips(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')), q);
    await record(db, q.from, q.to, q.date, 'ok', trips);

    const n = await db.query<{ n: number }>(
      'select count(*)::int n from trips where origin_city_id = $1 and dest_city_id = $2', [SALVADOR, CATU]);
    expect(n.rows[0]!.n).toBe(18);
    const late = await db.query<{ travel_date: Date; arr: string }>(
      `select travel_date, to_char(arrival_at at time zone 'America/Bahia', 'YYYY-MM-DD HH24:MI') arr
       from trips where source_trip_id = 'cfb4e768-d3a6-3745-b3d9-6e1b2ed3f1ed'`);
    expect(late.rows[0]!.arr).toBe('2026-10-05 00:20');

    const run = await db.query('select status, trips_found from collector_runs');
    expect(run.rows).toEqual([{ status: 'ok', trips_found: 18 }]);
    const stats = await db.query('select has_service, avg_daily_trips::float avg from leg_stats');
    expect(stats.rows).toEqual([{ has_service: true, avg: 18 }]);
    const hist = await db.query<{ n: number }>('select count(*)::int n from price_history');
    expect(hist.rows[0]!.n).toBe(18); // 1ª observação de cada viagem
  });

  it('price_history só registra mudança de preço ou assentos', async () => {
    const db = await freshDb();
    const d = '2026-10-05';
    const a = trip({ id: 'A', dep: `${d} 08:00`, arr: `${d} 09:30`, price: 30, seats: 40 });
    await record(db, 'salvador-ba', 'catu-ba', d, 'ok', [a]);
    await record(db, 'salvador-ba', 'catu-ba', d, 'ok', [a]);                 // igual
    await record(db, 'salvador-ba', 'catu-ba', d, 'ok', [{ ...a, price: 35 }]); // preço
    await record(db, 'salvador-ba', 'catu-ba', d, 'ok', [{ ...a, price: 35, seats_available: 12 }]); // assentos
    const h = await db.query('select price::float, seats_available from price_history order by id');
    expect(h.rows).toEqual([
      { price: 30, seats_available: 40 },
      { price: 35, seats_available: 40 },
      { price: 35, seats_available: 12 },
    ]);
    const t = await db.query('select count(*)::int n, max(price)::float p from trips');
    expect(t.rows).toEqual([{ n: 1, p: 35 }]);
  });

  it('viagem que some sai em ok/empty, mas fica em blocked/error', async () => {
    const db = await freshDb();
    const d = '2026-10-05';
    const a = trip({ id: 'A', dep: `${d} 08:00`, arr: `${d} 09:30` });
    const b = trip({ id: 'B', dep: `${d} 10:00`, arr: `${d} 11:30` });
    const ids = async () => (await db.query<{ source_trip_id: string }>(
      'select source_trip_id from trips order by 1')).rows.map((r) => r.source_trip_id);

    await record(db, 'salvador-ba', 'catu-ba', d, 'ok', [a, b]);
    await record(db, 'salvador-ba', 'catu-ba', d, 'blocked', [], 'HTTP 403');
    expect(await ids()).toEqual(['A', 'B']);
    await record(db, 'salvador-ba', 'catu-ba', d, 'ok', [a]);
    expect(await ids()).toEqual(['A']);
    await record(db, 'salvador-ba', 'catu-ba', d, 'empty', []);
    expect(await ids()).toEqual([]);

    const runs = await db.query('select status, trips_found, error from collector_runs order by id');
    expect(runs.rows).toEqual([
      { status: 'ok', trips_found: 2, error: null },
      { status: 'blocked', trips_found: null, error: 'HTTP 403' },
      { status: 'ok', trips_found: 1, error: null },
      { status: 'empty', trips_found: 0, error: null },
    ]);
    // Média usa só a última coleta de cada data → 0 viagens.
    const s = await db.query('select has_service, avg_daily_trips::float avg from leg_stats');
    expect(s.rows).toEqual([{ has_service: false, avg: 0 }]);
  });

  it('leg_stats faz média entre datas', async () => {
    const db = await freshDb();
    await record(db, 'salvador-ba', 'catu-ba', '2026-10-05', 'ok',
      [trip({ dep: '2026-10-05 08:00', arr: '2026-10-05 09:30' }), trip({ dep: '2026-10-05 10:00', arr: '2026-10-05 11:30' })]);
    await record(db, 'salvador-ba', 'catu-ba', '2026-10-06', 'empty', []);
    const s = await db.query('select has_service, avg_daily_trips::float avg from leg_stats');
    expect(s.rows).toEqual([{ has_service: true, avg: 1 }]);
  });

  it('slug desconhecido é rejeitado', async () => {
    const db = await freshDb();
    await expect(record(db, 'nao-existe', 'catu-ba', '2026-10-05', 'ok', [])).rejects.toThrow(/slug desconhecido/);
  });
});

describe('RLS e permissões', () => {
  const USER = '11111111-1111-1111-1111-111111111111';

  it('anon não lê nada; autenticado lê; ninguém além do service_role grava', async () => {
    const db = await freshDb();
    await db.query('insert into auth.users (id) values ($1)', [USER]);
    await record(db, 'salvador-ba', 'catu-ba', '2026-10-05', 'ok', [trip({ dep: '2026-10-05 08:00', arr: '2026-10-05 09:30' })]);

    await expect(asRole(db, 'anon', () => db.query('select count(*)::int n from trips')))
      .rejects.toThrow(/permission denied/);
    await expect(asRole(db, 'anon', () => db.query(`select * from find_connections(${2910800}, ${2907509}, '2026-10-05')`)))
      .rejects.toThrow(/permission denied/);

    const auth = await asRole(db, 'authenticated', () => db.query('select count(*)::int n from trips'), USER);
    expect(auth.rows[0]).toEqual({ n: 1 });
    await expect(asRole(db, 'authenticated', () => db.query('delete from trips'), USER))
      .rejects.toThrow(/permission denied/);
    await expect(asRole(db, 'authenticated',
      () => db.query(`insert into cities values (1, 'X', 'BA', null, null)`), USER)).rejects.toThrow(/permission denied/);
    await expect(asRole(db, 'authenticated',
      () => db.query(`select record_leg_result('clickbus','salvador-ba','catu-ba','2026-10-05','empty')`), USER))
      .rejects.toThrow(/permission denied/);
  });

  it('collect_requests: autenticado cria pedido pendente próprio e lê', async () => {
    const db = await freshDb();
    await db.query('insert into auth.users (id) values ($1)', [USER]);
    const ins = await asRole(db, 'authenticated', () => db.query(
      `insert into collect_requests (origin_city_id, dest_city_id, travel_date)
       values (2910800, 2907509, '2026-10-05') returning requested_by, status`), USER);
    expect(ins.rows).toEqual([{ requested_by: USER, status: 'pending' }]);
    await expect(asRole(db, 'authenticated', () => db.query(
      `insert into collect_requests (origin_city_id, dest_city_id, travel_date, status)
       values (2910800, 2907509, '2026-10-05', 'done')`), USER)).rejects.toThrow(/row-level security/);
    const read = await asRole(db, 'authenticated', () => db.query('select count(*)::int n from collect_requests'), USER);
    expect(read.rows[0]).toEqual({ n: 1 });
    await expect(asRole(db, 'authenticated',
      () => db.query(`update collect_requests set status = 'done'`), USER)).rejects.toThrow(/permission denied/);
  });
});
