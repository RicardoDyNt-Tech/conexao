import { describe, expect, it } from 'vitest';
import { migrationFiles, migrationSql, shimDb } from './db.js';

const APP_STATUS = '20261001000100_app_status.sql';

describe(`${APP_STATUS} é idempotente`, () => {
  it('aplica com collector_runs.round_id já existente (situação do remoto) e aplica de novo sem erro', async () => {
    const db = await shimDb();
    const before = migrationFiles().filter((f) => f < APP_STATUS);
    for (const f of before) await db.exec(migrationSql(f));

    // Como no remoto: a coluna (e um índice) já existiam antes do push.
    await db.exec(`alter table collector_runs add column round_id uuid;
                   create index collector_runs_round_idx on collector_runs (round_id);`);

    await db.exec(migrationSql(APP_STATUS));
    await db.exec(migrationSql(APP_STATUS)); // 2ª vez: nada quebra

    const fns = await db.query<{ proname: string; args: string }>(`
      select proname, pg_get_function_identity_arguments(oid) as args from pg_proc
      where proname in ('record_leg_result', 'collector_status', 'date_coverage') order by proname`);
    expect(fns.rows.map((r) => r.proname)).toEqual(['collector_status', 'date_coverage', 'record_leg_result']);
    expect(fns.rows.find((r) => r.proname === 'record_leg_result')!.args).toMatch(/p_round_id uuid$/);

    const idx = await db.query<{ n: number }>(
      `select count(*)::int n from pg_indexes where tablename = 'collector_runs' and indexname = 'collector_runs_round_idx'`);
    expect(idx.rows[0]!.n).toBe(1);
  });

  it('migrations seguintes continuam aplicando depois dela', async () => {
    const db = await shimDb();
    for (const f of migrationFiles()) await db.exec(migrationSql(f));
    await db.exec(migrationSql(APP_STATUS));
    const r = await db.query<{ s: unknown }>('select collector_status() as s');
    expect(r.rows[0]!.s).toMatchObject({ last_round: null, quarantine: null });
  });
});
