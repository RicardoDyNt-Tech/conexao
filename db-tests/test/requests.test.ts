import { describe, expect, it } from 'vitest';
import { asRole, freshDb } from './db.js';
import { CATU, FEIRA, SALVADOR } from './helpers.js';

const USER = '11111111-1111-1111-1111-111111111111';
const DATE = '2099-01-05'; // sempre no futuro

async function setup() {
  const db = await freshDb();
  await db.query('insert into auth.users (id) values ($1)', [USER]);
  return db;
}
const request = (db: Awaited<ReturnType<typeof setup>>, origin = FEIRA, dest = CATU, date = DATE) =>
  asRole(db, 'authenticated', async () =>
    (await db.query<{ id: number }>('select request_collect($1, $2, $3::date) as id', [origin, dest, date])).rows[0]!.id,
  USER);
const claim = (db: Awaited<ReturnType<typeof setup>>) =>
  asRole(db, 'service_role', async () => (await db.query<{ id: number; status: string }>(
    'select id, status from claim_collect_request()')).rows[0] ?? null);

describe('collect_requests: deduplicação', () => {
  it('pedido repetido para o mesmo par e data devolve o mesmo id', async () => {
    const db = await setup();
    const a = await request(db);
    const b = await request(db);
    expect(b).toBe(a);
    const n = await db.query('select count(*)::int n, min(requested_by::text) u from collect_requests');
    expect(n.rows[0]).toEqual({ n: 1, u: USER });
  });

  it('par ou data diferentes criam pedidos separados', async () => {
    const db = await setup();
    const ids = new Set([await request(db), await request(db, CATU, FEIRA), await request(db, FEIRA, CATU, '2099-01-06')]);
    expect(ids.size).toBe(3);
  });

  it('também deduplica enquanto o pedido está running; depois de done, aceita novo', async () => {
    const db = await setup();
    const a = await request(db);
    expect(await claim(db)).toEqual({ id: a, status: 'running' });
    expect(await request(db)).toBe(a);
    await db.query(`update collect_requests set status = 'done', done_at = now() where id = $1`, [a]);
    const b = await request(db);
    expect(b).not.toBe(a);
  });

  it('insert direto duplicado é barrado pelo índice único', async () => {
    const db = await setup();
    await request(db);
    await expect(asRole(db, 'authenticated', () => db.query(
      'insert into collect_requests (origin_city_id, dest_city_id, travel_date) values ($1, $2, $3)',
      [FEIRA, CATU, DATE]), USER)).rejects.toThrow(/duplicate key|unique/);
  });

  it('data no passado é rejeitada; anon não pode pedir', async () => {
    const db = await setup();
    await expect(request(db, FEIRA, CATU, '2000-01-01')).rejects.toThrow(/data no passado/);
    await expect(asRole(db, 'anon', () => db.query('select request_collect($1, $2, $3::date)', [FEIRA, CATU, DATE])))
      .rejects.toThrow(/permission denied/);
  });
});

describe('claim_collect_request', () => {
  it('pega o mais antigo, um de cada vez; fila vazia → nada', async () => {
    const db = await setup();
    const a = await request(db);
    const b = await request(db, FEIRA, SALVADOR);
    expect((await claim(db))!.id).toBe(a);
    expect((await claim(db))!.id).toBe(b);
    expect(await claim(db)).toBeNull();
  });

  it('pedido running há mais de 30 min volta para a fila', async () => {
    const db = await setup();
    const a = await request(db);
    await claim(db);
    expect(await claim(db)).toBeNull();
    await db.query(`update collect_requests set started_at = now() - interval '31 min' where id = $1`, [a]);
    expect((await claim(db))!.id).toBe(a);
  });

  it('só o service_role pode pegar pedidos', async () => {
    const db = await setup();
    await expect(asRole(db, 'authenticated', () => db.query('select * from claim_collect_request()'), USER))
      .rejects.toThrow(/permission denied/);
  });
});
