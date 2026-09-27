import { describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { asRole, freshDb } from './db.js';
import { CATU, FEIRA, trip } from './helpers.js';

const USER = '11111111-1111-1111-1111-111111111111';
const D = '2099-01-05';
const R1 = 'aaaaaaaa-0000-4000-8000-000000000001', R2 = 'aaaaaaaa-0000-4000-8000-000000000002';

async function run(db: PGlite, from: string, to: string, status: string, finished: string,
  round: string | null = null, trips: unknown[] = [], date = D) {
  await asRole(db, 'service_role', () => db.query(
    `select record_leg_result('clickbus', $1, $2, $3::date, $4, $5::jsonb, null, null,
       $6::timestamptz - interval '1 min', $6::timestamptz, $7::uuid)`,
    [from, to, date, status, JSON.stringify(trips), finished, round]));
}
const status = async (db: PGlite) => asRole(db, 'authenticated',
  async () => (await db.query<{ s: any }>('select collector_status() as s')).rows[0]!.s, USER);

describe('collector_status', () => {
  it('banco vazio', async () => {
    const db = await freshDb();
    expect(await status(db)).toEqual({
      last_round: null, quarantine: null, open_requests: [], collected_dates: [],
      sources: [
        { source: 'clickbus', quarantine: null, last_round: null },
        { source: 'queropassagem', quarantine: null, last_round: null },
      ],
    });
  });

  it('última rodada agrupa pelo round_id e conta os status', async () => {
    const db = await freshDb();
    await run(db, 'salvador-ba', 'catu-ba', 'ok', '2099-01-01T10:00:00Z', R1,
      [trip({ dep: `${D} 08:00`, arr: `${D} 09:30` })]);
    await run(db, 'catu-ba', 'salvador-ba', 'ok', '2099-01-02T10:00:00Z', R2,
      [trip({ dep: `${D} 08:00`, arr: `${D} 09:30` })]);
    await run(db, 'feira-de-santana-todos', 'alagoinhas-ba', 'empty', '2099-01-02T10:01:00Z', R2);
    await run(db, 'alagoinhas-ba', 'catu-ba', 'error', '2099-01-02T10:02:00Z', R2);
    const s = await status(db);
    expect(s.last_round).toMatchObject({ ok: 1, empty: 1, error: 1, blocked: 0 });
    expect(s.collected_dates).toEqual([D]);
    expect(s.quarantine).toBeNull();
  });

  it('quarentena: bloqueio há menos de 24 h e nada deu certo depois', async () => {
    const db = await freshDb();
    const recent = new Date(Date.now() - 2 * 3600_000).toISOString();
    await run(db, 'salvador-ba', 'catu-ba', 'blocked', recent, R1);
    const s = await status(db);
    expect(s.quarantine).toMatchObject({ from_city: 'Salvador', to_city: 'Catu' });
    expect(Date.parse(s.quarantine.until) - Date.parse(recent)).toBe(24 * 3600_000);
    expect(s.last_round).toMatchObject({ blocked: 1 });
  });

  it('quarentena acaba depois de 24 h ou de uma coleta ok posterior', async () => {
    const db = await freshDb();
    await run(db, 'salvador-ba', 'catu-ba', 'blocked', new Date(Date.now() - 25 * 3600_000).toISOString(), R1);
    expect((await status(db)).quarantine).toBeNull();

    const db2 = await freshDb();
    await run(db2, 'salvador-ba', 'catu-ba', 'blocked', new Date(Date.now() - 3 * 3600_000).toISOString(), R1);
    await run(db2, 'salvador-ba', 'catu-ba', 'ok', new Date(Date.now() - 3600_000).toISOString(), R2,
      [trip({ dep: `${D} 08:00`, arr: `${D} 09:30` })]);
    expect((await status(db2)).quarantine).toBeNull();
  });

  it('pedidos em aberto com nomes das cidades', async () => {
    const db = await freshDb();
    await db.query('insert into auth.users (id) values ($1)', [USER]);
    await asRole(db, 'authenticated', () => db.query('select request_collect($1, $2, $3::date)', [FEIRA, CATU, D]), USER);
    const s = await status(db);
    expect(s.open_requests).toHaveLength(1);
    expect(s.open_requests[0]).toMatchObject({ status: 'pending', travel_date: D, from_city: 'Feira de Santana', to_city: 'Catu' });
  });

  it('anon não pode chamar', async () => {
    const db = await freshDb();
    await expect(asRole(db, 'anon', () => db.query('select collector_status()'))).rejects.toThrow(/permission denied/);
  });
});

describe('date_coverage', () => {
  const cov = async (db: PGlite) => asRole(db, 'authenticated', async () => (await db.query<{
    from_city: string; to_city: string; hub_city: string | null; status: string | null; trips_found: number | null;
  }>('select from_city, to_city, hub_city, status, trips_found from date_coverage($1, $2, $3::date)',
    [FEIRA, CATU, D])).rows, USER);

  it('lista direta + trechos de cada hub; nada coletado → status null', async () => {
    const db = await freshDb();
    const rows = await cov(db);
    expect(rows.map((r) => `${r.hub_city ?? '-'}:${r.from_city}>${r.to_city}:${r.status}`)).toEqual([
      '-:Feira de Santana>Catu:null',
      'Alagoinhas:Feira de Santana>Alagoinhas:null',
      'Alagoinhas:Alagoinhas>Catu:null',
      'Salvador:Feira de Santana>Salvador:null',
      'Salvador:Salvador>Catu:null',
    ]);
  });

  it('usa a última coleta ok/empty de cada trecho na data (ignora blocked/error)', async () => {
    const db = await freshDb();
    await run(db, 'feira-de-santana-todos', 'alagoinhas-ba', 'empty', '2099-01-01T10:00:00Z', R1);
    await run(db, 'salvador-ba', 'catu-ba', 'ok', '2099-01-01T10:00:00Z', R1,
      [trip({ dep: `${D} 08:00`, arr: `${D} 09:30` })]);
    await run(db, 'salvador-ba', 'catu-ba', 'blocked', '2099-01-01T11:00:00Z', R2);
    await run(db, 'alagoinhas-ba', 'catu-ba', 'error', '2099-01-01T11:00:00Z', R2);
    const rows = await cov(db);
    const by = (f: string, t: string) => rows.find((r) => r.from_city === f && r.to_city === t)!;
    expect(by('Feira de Santana', 'Alagoinhas')).toMatchObject({ status: 'empty', trips_found: 0 });
    expect(by('Salvador', 'Catu')).toMatchObject({ status: 'ok', trips_found: 1 });
    expect(by('Alagoinhas', 'Catu').status).toBeNull();
    // outra data não conta
    await run(db, 'feira-de-santana-todos', 'salvador-ba', 'ok', '2099-01-01T10:00:00Z', R1,
      [trip({ dep: '2099-01-06 08:00', arr: '2099-01-06 09:30' })], '2099-01-06');
    expect((await cov(db)).find((r) => r.from_city === 'Feira de Santana' && r.to_city === 'Salvador')!.status).toBeNull();
  });
});
