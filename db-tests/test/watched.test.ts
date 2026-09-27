import { describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { asRole, freshDb, migrationFiles, migrationSql, shimDb } from './db.js';
import { CATU, FEIRA, record, trip } from './helpers.js';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

/** Hoje (Bahia) + n dias. As policies usam a data real, então os testes também. */
function day(n: number): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bahia' }).format(new Date());
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const D = day(3);

async function setup() {
  const db = await freshDb();
  await db.query('insert into auth.users (id) values ($1), ($2)', [A, B]);
  return db;
}
const as = <T>(db: PGlite, user: string, sql: string, params: unknown[] = []) =>
  asRole(db, 'authenticated', () => db.query<T>(sql, params), user);
const watch = (db: PGlite, user: string, date = D, maxPrice: number | null = 80, seats = 5) =>
  as<{ id: number }>(db, user, `insert into watched_dates (origin_city_id, dest_city_id, travel_date, max_price, min_seats_alert)
    values ($1, $2, $3, $4, $5) returning id`, [FEIRA, CATU, date, maxPrice, seats]).then((r) => r.rows[0]!.id);
const evaluate = (db: PGlite) => asRole(db, 'service_role', async () => (await db.query<{
  watch_id: number; kind: string; total_price: string; min_seats: number; seats_leg: number; option_key: string;
  origin_city: string; dest_city: string; via_city: string; service_fee: string;
}>('select * from evaluate_watch_alerts()')).rows);
const mark = (db: PGlite, id: number, kind: string, price: string | number, key: string) =>
  asRole(db, 'service_role', () => db.query('select mark_watch_alert($1, $2, $3, $4)', [id, kind, price, key]));

/** Feira → Salvador 06:00–07:30 + Salvador → Catu 09:00–10:30 = total escolhido. */
async function seedTrips(db: PGlite, o: { p1?: number; p2?: number; s1?: number; s2?: number; id2?: string } = {}) {
  await record(db, 'feira-de-santana-todos', 'salvador-ba', D, 'ok',
    [trip({ id: 'F1', dep: `${D} 06:00`, arr: `${D} 07:30`, price: o.p1 ?? 40, seats: o.s1 ?? 30 })]);
  await record(db, 'salvador-ba', 'catu-ba', D, 'ok',
    [trip({ id: o.id2 ?? 'S1', dep: `${D} 09:00`, arr: `${D} 10:30`, price: o.p2 ?? 30, seats: o.s2 ?? 30, fee: 9 } as never)]);
}

describe('watched_dates: permissões', () => {
  it('cada um cria, vê e apaga só os próprios alertas', async () => {
    const db = await setup();
    const id = await watch(db, A);
    const mine = await as<{ user_id: string }>(db, A, 'select user_id from watched_dates');
    expect(mine.rows).toEqual([{ user_id: A }]); // user_id = auth.uid() por padrão
    expect((await as(db, B, 'select * from watched_dates')).rows).toEqual([]);
    expect((await as(db, B, 'delete from watched_dates where id = $1 returning id', [id])).rows).toEqual([]);
    await as(db, A, 'update watched_dates set max_price = 70 where id = $1', [id]);
    expect((await as(db, A, 'delete from watched_dates where id = $1 returning id', [id])).rows).toEqual([{ id }]);
  });

  it('datas só de hoje até +30 dias; um alerta ativo por sentido e data', async () => {
    const db = await setup();
    await expect(watch(db, A, day(-1))).rejects.toThrow(/row-level security/);
    await expect(watch(db, A, day(31))).rejects.toThrow(/row-level security/);
    await watch(db, A, day(30));
    await expect(watch(db, A, day(30))).rejects.toThrow(/duplicate key|unique/);
    await watch(db, B, day(30)); // outra pessoa pode
  });

  it('o app não mexe no estado dos avisos nem cria em nome de outro', async () => {
    const db = await setup();
    const id = await watch(db, A);
    await expect(as(db, A, 'update watched_dates set price_alerted = 1 where id = $1', [id])).rejects.toThrow(/permission denied/);
    await expect(as(db, A, `insert into watched_dates (origin_city_id, dest_city_id, travel_date, user_id) values ($1, $2, $3, $4)`,
      [FEIRA, CATU, D, B])).rejects.toThrow(/permission denied/);
    await expect(as(db, A, 'select * from evaluate_watch_alerts()')).rejects.toThrow(/permission denied/);
    await expect(asRole(db, 'anon', () => db.query('select * from watched_dates'))).rejects.toThrow(/permission denied/);
  });

  it('valida alvo, limite de lugares e chat do Telegram', async () => {
    const db = await setup();
    await expect(watch(db, A, D, 0)).rejects.toThrow(/max_price_chk/);
    await expect(watch(db, A, D, 50, 0)).rejects.toThrow(/min_seats_chk/);
    await expect(as(db, A, `insert into watched_dates (origin_city_id, dest_city_id, travel_date, telegram_chat_id)
      values ($1, $2, $3, 'abc')`, [FEIRA, CATU, D])).rejects.toThrow(/chat_chk/);
  });
});

describe('alerta de preço-alvo', () => {
  it('avisa quando o mais barato fica <= alvo; depois só se ficar ainda mais barato', async () => {
    const db = await setup();
    const id = await watch(db, A, D, 80, 1);
    await seedTrips(db, { p1: 50, p2: 40 }); // 90 > 80
    expect(await evaluate(db)).toEqual([]);

    await seedTrips(db, { p1: 40, p2: 30 }); // 70 <= 80
    const [a] = await evaluate(db);
    expect(a).toMatchObject({ watch_id: id, kind: 'price', total_price: '70.00', via_city: 'Salvador',
      origin_city: 'Feira de Santana', dest_city: 'Catu', service_fee: '9.00' });
    await mark(db, id, 'price', a!.total_price, a!.option_key);
    expect(await evaluate(db)).toEqual([]);           // mesmo preço: não repete

    await seedTrips(db, { p1: 40, p2: 25 });          // 65: mais barato
    expect((await evaluate(db)).map((x) => [x.kind, x.total_price])).toEqual([['price', '65.00']]);
  });

  it('mudar o alvo recomeça a contagem', async () => {
    const db = await setup();
    const id = await watch(db, A, D, 80, 1);
    await seedTrips(db);                               // 70
    const [a] = await evaluate(db);
    await mark(db, id, 'price', a!.total_price, a!.option_key);
    await as(db, A, 'update watched_dates set max_price = 75 where id = $1', [id]);
    expect((await evaluate(db)).map((x) => x.kind)).toEqual(['price']);
  });

  it('sem alvo: nunca avisa preço', async () => {
    const db = await setup();
    await watch(db, A, D, null, 1);
    await seedTrips(db);
    expect(await evaluate(db)).toEqual([]);
  });
});

describe('alerta de assentos acabando', () => {
  it('avisa uma vez por combinação quando algum trecho tem <= N lugares', async () => {
    const db = await setup();
    const id = await watch(db, A, D, null, 5);
    await seedTrips(db, { s2: 6 });
    expect(await evaluate(db)).toEqual([]);

    await seedTrips(db, { s2: 3 });
    const [a] = await evaluate(db);
    expect(a).toMatchObject({ kind: 'seats', min_seats: 3, seats_leg: 2 });
    await mark(db, id, 'seats', a!.total_price, a!.option_key);
    await seedTrips(db, { s2: 2 });                    // mesma combinação: não repete
    expect(await evaluate(db)).toEqual([]);

    // Outra combinação vira a mais barata, também com poucos lugares: avisa de novo.
    await record(db, 'salvador-ba', 'catu-ba', D, 'ok', [
      trip({ id: 'S1', dep: `${D} 09:00`, arr: `${D} 10:30`, price: 30, seats: 2 }),
      trip({ id: 'S2', dep: `${D} 09:30`, arr: `${D} 10:30`, price: 20, seats: 4 }),
    ]);
    const again = await evaluate(db);
    expect(again.map((x) => [x.kind, x.min_seats])).toEqual([['seats', 4]]);
    expect(again[0]!.option_key).not.toBe(a!.option_key);
  });

  it('preço e assentos juntos: dois avisos', async () => {
    const db = await setup();
    await watch(db, A, D, 80, 5);
    await seedTrips(db, { s1: 2 });
    expect((await evaluate(db)).map((x) => x.kind).sort()).toEqual(['price', 'seats']);
  });

  it('alerta desativado ou data passada não avisa', async () => {
    const db = await setup();
    const id = await watch(db, A, D, 80, 5);
    await seedTrips(db, { s1: 2 });
    await as(db, A, 'update watched_dates set active = false where id = $1', [id]);
    expect(await evaluate(db)).toEqual([]);
    await db.query(`update watched_dates set active = true, travel_date = $1 where id = $2`, [day(-1), id]);
    expect(await evaluate(db)).toEqual([]);
  });
});

describe('watch_status (tela do app)', () => {
  it('lista os meus alertas com a melhor opção de agora', async () => {
    const db = await setup();
    await watch(db, A, D, 80, 5);
    await watch(db, B, D, 60, 5);
    await seedTrips(db);
    const r = await as<Record<string, unknown>>(db, A, 'select * from watch_status()');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ origin_city: 'Feira de Santana', dest_city: 'Catu', max_price: '80.00',
      best_price: '70.00', best_via: 'Salvador', best_min_seats: 30, best_service_fee: '9.00' });
  });

  it('data sem dados: aparece com melhor preço vazio', async () => {
    const db = await setup();
    await watch(db, A, day(10), 80, 5);
    const r = await as<Record<string, unknown>>(db, A, 'select travel_date, best_price from watch_status()');
    expect(r.rows).toEqual([{ travel_date: expect.any(Date), best_price: null }]);
  });
});

for (const file of ['20261003000100_watched_dates.sql', '20261005000100_watch_time_window.sql']) {
  describe(`${file} é idempotente`, () => {
    it('aplica duas vezes seguidas sem erro', async () => {
      const db = await shimDb();
      for (const f of migrationFiles().filter((x) => x <= file)) await db.exec(migrationSql(f));
      await db.exec(migrationSql(file));
    });
  });
}

describe('janela de horário do alerta', () => {
  // Três combinações: 06:00→10:30 (R$ 70), 12:00→16:30 (R$ 60), 17:00→21:30 (R$ 50).
  async function seedDay(db: PGlite) {
    await record(db, 'feira-de-santana-todos', 'salvador-ba', D, 'ok', [
      trip({ id: 'F06', dep: `${D} 06:00`, arr: `${D} 07:30`, price: 40 }),
      trip({ id: 'F12', dep: `${D} 12:00`, arr: `${D} 13:30`, price: 30 }),
      trip({ id: 'F17', dep: `${D} 17:00`, arr: `${D} 18:30`, price: 20, seats: 2 }),
    ]);
    await record(db, 'salvador-ba', 'catu-ba', D, 'ok', [
      trip({ id: 'S09', dep: `${D} 09:00`, arr: `${D} 10:30`, price: 30 }),
      trip({ id: 'S15', dep: `${D} 15:00`, arr: `${D} 16:30`, price: 30 }),
      trip({ id: 'S20', dep: `${D} 20:00`, arr: `${D} 21:30`, price: 30 }),
    ]);
  }
  const addWindow = (db: PGlite, after: string | null, by: string | null, maxPrice = 65, seats = 1) =>
    as<{ id: number }>(db, A, `insert into watched_dates (origin_city_id, dest_city_id, travel_date, max_price, min_seats_alert,
      depart_after, arrive_by) values ($1, $2, $3, $4, $5, $6, $7) returning id`, [FEIRA, CATU, D, maxPrice, seats, after, by])
      .then((r) => r.rows[0]!.id);

  it('sem janela: a mais barata do dia (17:00, R$ 50)', async () => {
    const db = await setup();
    await seedDay(db);
    await addWindow(db, null, null);
    expect((await evaluate(db)).map((x) => x.total_price)).toEqual(['50.00']);
  });

  it('"chegar até 20:00": a de 17:00 fica de fora; vale a de 12:00 (R$ 60)', async () => {
    const db = await setup();
    await seedDay(db);
    await addWindow(db, null, '20:00');
    const r = await as<Record<string, unknown>>(db, A, 'select best_price, depart_after, arrive_by from watch_status()');
    expect(r.rows[0]).toMatchObject({ best_price: '60.00', depart_after: null, arrive_by: '20:00:00' });
    expect((await evaluate(db)).map((x) => [x.kind, x.total_price])).toEqual([['price', '60.00']]);
  });

  it('"sair depois de 07:00" e "chegar até 12:00": nada na janela → sem aviso', async () => {
    const db = await setup();
    await seedDay(db);
    await addWindow(db, '07:00', '12:00');
    expect(await evaluate(db)).toEqual([]);
    const r = await as<Record<string, unknown>>(db, A, 'select best_price from watch_status()');
    expect(r.rows[0]).toEqual({ best_price: null });
  });

  it('lugares também olham só a janela', async () => {
    const db = await setup();
    await seedDay(db);
    await addWindow(db, null, '20:00', 10, 5);   // 17:00 (2 lugares) fora da janela
    expect(await evaluate(db)).toEqual([]);
    const db2 = await setup();
    await seedDay(db2);
    await as(db2, A, `insert into watched_dates (origin_city_id, dest_city_id, travel_date, min_seats_alert, depart_after)
      values ($1, $2, $3, 5, '16:00')`, [FEIRA, CATU, D]);
    expect((await evaluate(db2)).map((x) => [x.kind, x.min_seats])).toEqual([['seats', 2]]);
  });

  it('mudar a janela recomeça os avisos; janela invertida é recusada', async () => {
    const db = await setup();
    await seedDay(db);
    const id = await addWindow(db, null, null);
    const [a] = await evaluate(db);
    await mark(db, id, 'price', a!.total_price, a!.option_key);
    expect(await evaluate(db)).toEqual([]);
    await as(db, A, `update watched_dates set arrive_by = '20:00' where id = $1`, [id]);
    expect((await evaluate(db)).map((x) => x.total_price)).toEqual(['60.00']);
    await expect(as(db, A, `update watched_dates set depart_after = '21:00' where id = $1`, [id])).rejects.toThrow(/window_chk/);
  });

  it('alerta devolve a janela para a mensagem', async () => {
    const db = await setup();
    await seedDay(db);
    await addWindow(db, '10:00', '20:00');
    expect((await evaluate(db))[0]).toMatchObject({ depart_after: '10:00:00', arrive_by: '20:00:00' });
  });
});
