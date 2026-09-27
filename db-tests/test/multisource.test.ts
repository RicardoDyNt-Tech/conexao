import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { asRole, freshDb, migrationFiles, migrationSql, shimDb } from './db.js';
import { CATU, FEIRA, QP, SALVADOR, record, recordQp, trip } from './helpers.js';

const D = '2099-01-05';
const USER = '11111111-1111-1111-1111-111111111111';

// Mesmo ônibus (Cidade Sol 08:00 → 09:30) nas duas fontes; o QP escreve a viação por extenso.
const cb = (o: Record<string, unknown> = {}) => trip({ id: 'CB1', dep: `${D} 08:00`, arr: `${D} 09:30`, price: 28.99,
  company: 'Cidade Sol', company_slug: 'cidade-sol', url: 'https://clickbus/x', ...o } as never);
const qp = (o: Record<string, unknown> = {}) => trip({ id: 'QP1', dep: `${D} 08:00`, arr: `${D} 09:30`, price: 32.29,
  company: 'Viação Cidade Sol', company_slug: 'viacao-cidade-sol', fee: 9.68, url: 'https://qp/x', ...o } as never);

const best = async (db: PGlite, origin = SALVADOR, dest = CATU) => (await db.query<{
  source: string; source_trip_id: string; price: string; sources: string[]; offers: Array<Record<string, unknown>>; company_key: string;
}>(`select source, source_trip_id, price, sources, offers, company_key from trips_best
    where origin_city_id = $1 and dest_city_id = $2 order by departure_at, price`, [origin, dest])).rows;

describe('normalize_company', () => {
  it('mesma viação escrita de jeitos diferentes → mesma chave', async () => {
    const db = await freshDb();
    const r = await db.query<{ k: string }>(`select normalize_company(x) as k from unnest(array[
      'rota-transportes', 'Rota Transportes', 'ROTA', 'cidade-sol', 'Viação Cidade Sol', 'Auto Viação Cidade Sol Ltda',
      'Águia Branca', '', null]) as x`);
    expect(r.rows.map((x) => x.k)).toEqual(['rota', 'rota', 'rota', 'cidade-sol', 'cidade-sol', 'cidade-sol', 'aguia-branca', null, null]);
  });
});

describe('trips_best: mesmo ônibus nas duas fontes', () => {
  it('vira 1 linha com o menor preço, a lista de fontes e as 2 ofertas', async () => {
    const db = await freshDb();
    await record(db, 'salvador-ba', 'catu-ba', D, 'ok', [cb()]);
    await recordQp(db, QP.salvador, QP.catu, D, 'ok', [qp()]);
    const rows = await best(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'clickbus', source_trip_id: 'CB1', price: '28.99',
      sources: ['clickbus', 'queropassagem'], company_key: 'cidade-sol' });
    expect(rows[0]!.offers.map((o) => [o.source, o.price, o.service_fee, o.buy_url])).toEqual([
      ['clickbus', 28.99, null, 'https://clickbus/x'],
      ['queropassagem', 32.29, 9.68, 'https://qp/x'],
    ]);
  });

  it('QP mais barato: a linha é a do QP (taxa fica à parte, fora da comparação)', async () => {
    const db = await freshDb();
    await record(db, 'salvador-ba', 'catu-ba', D, 'ok', [cb({ price: 35 })]);
    await recordQp(db, QP.salvador, QP.catu, D, 'ok', [qp({ price: 30, fee: 9 })]);
    expect((await best(db))[0]).toMatchObject({ source: 'queropassagem', price: '30.00' });
  });

  it('empate no preço: fica a coleta mais recente', async () => {
    const db = await freshDb();
    await recordQp(db, QP.salvador, QP.catu, D, 'ok', [qp({ price: 30 })]);
    await record(db, 'salvador-ba', 'catu-ba', D, 'ok', [cb({ price: 30 })]); // gravada depois
    expect((await best(db))[0]!.source).toBe('clickbus');
  });

  it('viação, saída ou chegada diferentes continuam separadas', async () => {
    const db = await freshDb();
    await record(db, 'salvador-ba', 'catu-ba', D, 'ok', [cb()]);
    await recordQp(db, QP.salvador, QP.catu, D, 'ok', [
      qp({ id: 'QP2', company: 'Rota Transportes', company_slug: 'rota-transportes' }),
      qp({ id: 'QP3', dep: `${D} 08:05` }),
      qp({ id: 'QP4', arr: `${D} 09:40` }),
    ]);
    expect(await best(db)).toHaveLength(4);
  });

  it('conexão vendida pronta (parts_count > 1) fica fora', async () => {
    const db = await freshDb();
    await recordQp(db, QP.salvador, QP.catu, D, 'ok', [qp({ parts: 2 })]);
    expect(await best(db)).toEqual([]);
    const n = await db.query<{ n: number }>('select count(*)::int n from trips');
    expect(n.rows[0]!.n).toBe(1); // gravada, só não entra no cruzamento
  });

  it('anon não lê a view; autenticado lê', async () => {
    const db = await freshDb();
    await db.query('insert into auth.users (id) values ($1)', [USER]);
    await record(db, 'salvador-ba', 'catu-ba', D, 'ok', [cb()]);
    await expect(asRole(db, 'anon', () => db.query('select * from trips_best'))).rejects.toThrow(/permission denied/);
    const r = await asRole(db, 'authenticated', () => db.query('select count(*)::int n from trips_best'), USER);
    expect(r.rows[0]).toEqual({ n: 1 });
  });
});

describe('find_connections / find_second_legs com duas fontes', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    // 1º trecho nas duas fontes; 2º trecho só no QP.
    await record(db, 'feira-de-santana-todos', 'salvador-ba', D, 'ok', [
      trip({ id: 'CB-F', dep: `${D} 06:00`, arr: `${D} 07:30`, price: 40, company: 'Rota', company_slug: 'rota-transportes', url: 'https://cb/f' } as never)]);
    await recordQp(db, QP.feira, QP.salvador, D, 'ok', [
      trip({ id: 'QP-F', dep: `${D} 06:00`, arr: `${D} 07:30`, price: 41.2, company: 'Rota Transportes', company_slug: 'rota-transportes', fee: 12.36, url: 'https://qp/f' } as never)]);
    await recordQp(db, QP.salvador, QP.catu, D, 'ok', [qp({ dep: `${D} 09:00`, arr: `${D} 10:30` })]);
  });

  it('a combinação aparece uma vez só, com as ofertas de cada trecho', async () => {
    const r = await db.query<Record<string, any>>('select * from find_connections($1, $2, $3::date)', [FEIRA, CATU, D]);
    expect(r.rows).toHaveLength(1);
    const c = r.rows[0]!;
    expect(c).toMatchObject({ leg1_source: 'clickbus', leg2_source: 'queropassagem', leg2_service_fee: '9.68',
      total_price: '72.29' }); // 40 (ClickBus) + 32,29 (QP)
    expect(c.leg1_offers.map((o: any) => [o.source, o.price, o.buy_url])).toEqual([
      ['clickbus', 40, 'https://cb/f'], ['queropassagem', 41.2, 'https://qp/f']]);
    expect(c.leg2_offers).toHaveLength(1);
    expect(c.same_station).toBeNull(); // o QP não informa id de rodoviária
  });

  it('find_second_legs sem duplicatas, com fonte e ofertas', async () => {
    const first = (await db.query<{ id: number }>(`select id from trips_best where origin_city_id = $1`, [FEIRA])).rows[0]!.id;
    const r = await db.query<Record<string, any>>('select * from find_second_legs($1, $2)', [first, CATU]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ source: 'queropassagem', service_fee: '9.68', compatible: true });
  });
});

describe('record_leg_result grava a taxa do QP', () => {
  it('service_fee vai para trips', async () => {
    const db = await freshDb();
    await recordQp(db, QP.salvador, QP.catu, D, 'ok', [qp()]);
    const r = await db.query('select source, price::float, service_fee::float from trips');
    expect(r.rows).toEqual([{ source: 'queropassagem', price: 32.29, service_fee: 9.68 }]);
  });
});

describe('collector_status por fonte', () => {
  it('QP bloqueado não põe a ClickBus em quarentena', async () => {
    const db = await freshDb();
    const now = Date.now();
    await asRole(db, 'service_role', () => db.query(
      `select record_leg_result('clickbus', 'salvador-ba', 'catu-ba', $1::date, 'ok', $2::jsonb, null, null,
         $3::timestamptz, $3::timestamptz, 'aaaaaaaa-0000-4000-8000-000000000001')`,
      [D, JSON.stringify([cb()]), new Date(now - 3600_000).toISOString()]));
    await asRole(db, 'service_role', () => db.query(
      `select record_leg_result('queropassagem', 'salvador-ba', 'catu', $1::date, 'blocked', '[]', 'HTTP 403', null,
         $2::timestamptz, $2::timestamptz, 'aaaaaaaa-0000-4000-8000-000000000002')`,
      [D, new Date(now - 1800_000).toISOString()]));
    const s = (await db.query<{ s: any }>('select collector_status() as s')).rows[0]!.s;
    const by = Object.fromEntries(s.sources.map((x: any) => [x.source, x]));
    expect(by.clickbus.quarantine).toBeNull();
    expect(by.clickbus.last_round).toMatchObject({ ok: 1, blocked: 0 });
    expect(by.queropassagem.quarantine).toMatchObject({ reason: 'HTTP 403', from_city: 'Salvador', to_city: 'Catu' });
    expect(by.queropassagem.last_round).toMatchObject({ blocked: 1 });
    expect(s.quarantine).toMatchObject({ source: 'queropassagem' }); // campo antigo: a quarentena ativa
  });
});

describe('20261002000100_multi_source.sql é idempotente', () => {
  it('aplica duas vezes sem erro', async () => {
    const db = await shimDb();
    for (const f of migrationFiles()) await db.exec(migrationSql(f));
    await db.exec(migrationSql('20261002000100_multi_source.sql'));
    const r = await db.query<{ n: number }>(`select count(*)::int n from pg_views where viewname = 'trips_best'`);
    expect(r.rows[0]!.n).toBe(1);
  });
});
