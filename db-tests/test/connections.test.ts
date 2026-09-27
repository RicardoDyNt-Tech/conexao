import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { freshDb } from './db.js';
import { CATU, FEIRA, local, minutes, record, trip } from './helpers.js';

const D = '2026-10-05', D1 = '2026-10-06';
const SSA_ROD = 3874; // rodoviária de Salvador

interface Row {
  kind: string; via_city: string | null;
  leg1_trip_id: number; leg2_trip_id: number | null;
  departure_at: Date; arrival_at: Date; layover: unknown; total_duration: unknown;
  total_price: string; same_station: boolean | null;
}
async function connections(db: PGlite, date = D, min = '60 min', max = '4 h') {
  const r = await db.query<Row>('select * from find_connections($1, $2, $3::date, $4::interval, $5::interval)',
    [FEIRA, CATU, date, min, max]);
  return r.rows;
}
async function tripId(db: PGlite, sid: string): Promise<number> {
  return (await db.query<{ id: number }>('select id from trips where source_trip_id = $1', [sid])).rows[0]!.id;
}
/** Pares (1º, 2º) de source_trip_id nas conexões encontradas. */
async function pairs(db: PGlite, rows: Row[]) {
  const ids = new Map((await db.query<{ id: number; source_trip_id: string }>('select id, source_trip_id from trips'))
    .rows.map((r) => [r.id, r.source_trip_id]));
  return rows.filter((r) => r.kind === 'connection')
    .map((r) => `${ids.get(r.leg1_trip_id)}>${ids.get(r.leg2_trip_id!)}`).sort();
}

describe('find_connections', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    await record(db, 'feira-de-santana-todos', 'salvador-ba', D, 'ok', [
      trip({ id: 'F0600', dep: `${D} 06:00`, arr: `${D} 07:30`, price: 40, to_station: SSA_ROD }),
      trip({ id: 'F2000', dep: `${D} 20:00`, arr: `${D} 21:30`, price: 40, to_station: SSA_ROD }),
      trip({ id: 'F2130', dep: `${D} 21:30`, arr: `${D} 23:00`, price: 40, to_station: SSA_ROD }),
    ]);
    await record(db, 'salvador-ba', 'catu-ba', D, 'ok', [
      trip({ id: 'S0829', dep: `${D} 08:29`, arr: `${D} 09:49`, price: 30, from_station: SSA_ROD }), // 59 min após F0600
      trip({ id: 'S0830', dep: `${D} 08:30`, arr: `${D} 09:50`, price: 30, from_station: SSA_ROD }), // 60 min
      trip({ id: 'S1130', dep: `${D} 11:30`, arr: `${D} 12:50`, price: 30, from_station: SSA_ROD }), // 4 h
      trip({ id: 'S1131', dep: `${D} 11:31`, arr: `${D} 12:51`, price: 30, from_station: SSA_ROD }), // 4 h 01
      // Chega no dia seguinte (caso real da fixture).
      trip({ id: 'S2300', dep: `${D} 23:00`, arr: `${D1} 00:20`, price: 45.8, from_station: SSA_ROD }),
    ]);
    // 2º trecho que sai depois da meia-noite: coletado na data seguinte.
    await record(db, 'salvador-ba', 'catu-ba', D1, 'ok', [
      trip({ id: 'S0030', dep: `${D1} 00:30`, arr: `${D1} 01:50`, price: 30, from_station: SSA_ROD }),
    ]);
    // Trecho sem viagens no dia.
    await record(db, 'feira-de-santana-todos', 'alagoinhas-ba', D, 'empty', []);
    await record(db, 'alagoinhas-ba', 'catu-ba', D, 'ok', [
      trip({ id: 'A1000', dep: `${D} 10:00`, arr: `${D} 10:40`, price: 15 }),
    ]);
  });

  it('respeita folga mínima e máxima (limites inclusivos)', async () => {
    const p = await pairs(db, await connections(db));
    expect(p).toContain('F0600>S0830');
    expect(p).toContain('F0600>S1130');
    expect(p).not.toContain('F0600>S0829');
    expect(p).not.toContain('F0600>S1131');
  });

  it('chegada no dia seguinte: Salvador 23:00 → Catu 00:20', async () => {
    const rows = await connections(db);
    const ids = await pairs(db, rows);
    expect(ids).toContain('F2000>S2300');
    const s2300 = await tripId(db, 'S2300'), f2000 = await tripId(db, 'F2000');
    const r = rows.find((x) => x.leg1_trip_id === f2000 && x.leg2_trip_id === s2300)!;
    expect(r.total_price).toBe('85.80');
    expect(local(r.departure_at)).toBe(`${D} 20:00`);
    expect(local(r.arrival_at)).toBe(`${D1} 00:20`);
    expect(minutes(r.layover)).toBe(90);
    expect(minutes(r.total_duration)).toBe(4 * 60 + 20);
  });

  it('conexão atravessando a meia-noite (2º trecho em p_date + 1)', async () => {
    const rows = await connections(db);
    expect(await pairs(db, rows)).toContain('F2130>S0030');
    // S2300 sai no mesmo minuto em que F2130 chega: espera 0 → fora.
    expect(await pairs(db, rows)).not.toContain('F2130>S2300');
  });

  it('trecho sem viagens (Feira → Alagoinhas) não quebra: só sai via Salvador', async () => {
    const rows = await connections(db);
    expect(rows.every((r) => r.via_city === 'Salvador')).toBe(true);
    expect(await pairs(db, rows)).toEqual(['F0600>S0830', 'F0600>S1130', 'F2000>S0030', 'F2000>S2300', 'F2130>S0030']);
  });

  it('parâmetros de folga alteram o resultado', async () => {
    const p = await pairs(db, await connections(db, D, '30 min', '1 h'));
    expect(p).toEqual(['F0600>S0829', 'F0600>S0830']);
  });

  it('ordena por preço total e devolve data_as_of', async () => {
    const r = await db.query<{ total_price: string; data_as_of: Date | null }>(
      'select total_price, data_as_of from find_connections($1, $2, $3)', [FEIRA, CATU, D]);
    const prices = r.rows.map((x) => Number(x.total_price));
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    expect(r.rows.every((x) => x.data_as_of instanceof Date)).toBe(true);
  });
});

describe('find_connections — troca de rodoviária e diretas', () => {
  it('same_station indica troca de rodoviária no hub', async () => {
    const db = await freshDb();
    await record(db, 'feira-de-santana-todos', 'alagoinhas-ba', D, 'ok', [
      trip({ id: 'FA', dep: `${D} 07:00`, arr: `${D} 08:00`, price: 20, to_station: 20 }),
    ]);
    await record(db, 'alagoinhas-ba', 'catu-ba', D, 'ok', [
      trip({ id: 'AC_mesma', dep: `${D} 09:30`, arr: `${D} 10:10`, price: 15, from_station: 20 }),
      trip({ id: 'AC_outra', dep: `${D} 10:00`, arr: `${D} 10:40`, price: 15, from_station: 21 }),
      trip({ id: 'AC_semid', dep: `${D} 10:30`, arr: `${D} 11:10`, price: 15 }),
    ]);
    const rows = await connections(db);
    const byLeg2 = new Map<number, boolean | null>(rows.map((r) => [r.leg2_trip_id!, r.same_station]));
    expect(byLeg2.get(await tripId(db, 'AC_mesma'))).toBe(true);
    expect(byLeg2.get(await tripId(db, 'AC_outra'))).toBe(false);
    expect(byLeg2.get(await tripId(db, 'AC_semid'))).toBeNull();
    expect(rows.every((r) => r.via_city === 'Alagoinhas')).toBe(true);
  });

  it('inclui viagens diretas quando existem', async () => {
    const db = await freshDb();
    await db.query(`insert into city_source_ids values (2910800, 'teste', 'feira'), (2907509, 'teste', 'catu')`);
    await db.query(`select record_leg_result('teste', 'feira', 'catu', $1::date, 'ok', $2::jsonb)`,
      [D, JSON.stringify([trip({ id: 'DIR', dep: `${D} 05:00`, arr: `${D} 08:00`, price: 90 })])]);
    const rows = await connections(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'direct', via_city: null, leg2_trip_id: null, total_price: '90.00' });
    expect(minutes(rows[0]!.total_duration)).toBe(180);
  });

  it('nenhuma viagem no dia → lista vazia', async () => {
    const db = await freshDb();
    expect(await connections(db)).toEqual([]);
  });
});

describe('find_second_legs', () => {
  it('devolve todos os 2º trechos com compatible e reason', async () => {
    const db = await freshDb();
    await record(db, 'feira-de-santana-todos', 'salvador-ba', D, 'ok', [
      trip({ id: 'F2000', dep: `${D} 20:00`, arr: `${D} 21:30`, price: 40, to_station: SSA_ROD }),
    ]);
    await record(db, 'salvador-ba', 'catu-ba', D, 'ok', [
      trip({ id: 'S1500', dep: `${D} 15:00`, arr: `${D} 16:20`, from_station: SSA_ROD }), // antes de chegar
      trip({ id: 'S2200', dep: `${D} 22:00`, arr: `${D} 23:20`, from_station: SSA_ROD }), // 30 min
      trip({ id: 'S2300', dep: `${D} 23:00`, arr: `${D1} 00:20`, price: 45.8, from_station: SSA_ROD }),
    ]);
    await record(db, 'salvador-ba', 'catu-ba', D1, 'ok', [
      trip({ id: 'S0100', dep: `${D1} 01:00`, arr: `${D1} 02:20`, from_station: SSA_ROD }), // 3h30
      trip({ id: 'S0600', dep: `${D1} 06:00`, arr: `${D1} 07:20`, from_station: 999 }),     // 8h30
    ]);
    // Dia +2 não entra.
    await record(db, 'salvador-ba', 'catu-ba', '2026-10-07', 'ok', [
      trip({ id: 'S_D2', dep: '2026-10-07 06:00', arr: '2026-10-07 07:20' }),
    ]);

    const first = await tripId(db, 'F2000');
    const r = await db.query<{ trip_id: number; compatible: boolean; reason: string | null; layover: unknown;
      arrival_at: Date; total_price: string; same_station: boolean }>(
      'select * from find_second_legs($1, $2)', [first, CATU]);
    const sid = new Map((await db.query<{ id: number; source_trip_id: string }>('select id, source_trip_id from trips'))
      .rows.map((x) => [x.id, x.source_trip_id]));
    const got = r.rows.map((x) => [sid.get(x.trip_id), x.compatible, x.reason, minutes(x.layover)]);
    expect(got).toEqual([
      ['S1500', false, 'sai antes de você chegar', -390],
      ['S2200', false, 'espera abaixo do mínimo', 30],
      ['S2300', true, null, 90],
      ['S0100', true, null, 210],
      ['S0600', false, 'espera acima do limite', 510],
    ]);
    const s2300 = r.rows[2]!;
    expect(local(s2300.arrival_at)).toBe(`${D1} 00:20`);
    expect(s2300.total_price).toBe('85.80');
    expect(r.rows[4]!.same_station).toBe(false);
  });

  it('respeita folgas passadas por parâmetro', async () => {
    const db = await freshDb();
    await record(db, 'feira-de-santana-todos', 'salvador-ba', D, 'ok', [
      trip({ id: 'F', dep: `${D} 06:00`, arr: `${D} 07:30` }),
    ]);
    await record(db, 'salvador-ba', 'catu-ba', D, 'ok', [trip({ id: 'S', dep: `${D} 08:00`, arr: `${D} 09:20` })]);
    const r = await db.query<{ compatible: boolean }>(
      `select compatible from find_second_legs($1, $2, '20 min', '40 min')`, [await tripId(db, 'F'), CATU]);
    expect(r.rows).toEqual([{ compatible: true }]);
  });
});
