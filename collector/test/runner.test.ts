import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext } from 'playwright';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { activeCooldown } from '../src/cooldown.js';
import { pagesLeft } from '../src/budget.js';
import { runRound, type RoundOptions } from '../src/runner.js';
import type { LegQuery, LegResult, Source } from '../src/types.js';

// Estado (trava, pausa, contador) numa pasta temporária por teste; Chrome substituído por um falso.
beforeEach(async () => {
  process.env.COLLECTOR_STATE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-'));
});

const fakeContext = { close: async () => {} } as unknown as BrowserContext;
const q = (n: number): LegQuery[] => Array.from({ length: n }, (_, i) => ({ from: `o${i}`, to: `d${i}`, date: '2026-10-05' }));

function fakeSource(statusOf: (q: LegQuery) => LegResult['status'] = () => 'ok') {
  const opened: string[] = [];
  const source: Source = {
    name: 'fake',
    prepare: vi.fn(async () => { opened.push('home'); return { status: 'ok' as const }; }),
    collect: vi.fn(async (_c, query) => {
      opened.push(`${query.from}>${query.to}`);
      const now = new Date().toISOString();
      return { source: 'fake', ...query, status: statusOf(query), trips: [], found: 1, warnings: [],
        started_at: now, finished_at: now };
    }),
  };
  return { source, opened };
}
const opts = (extra: Partial<RoundOptions> = {}): RoundOptions =>
  ({ headless: true, saveRaw: false, minPauseMs: 0, maxPauseMs: 0, log: () => {}, openContext: async () => fakeContext, ...extra });

describe('runRound', () => {
  it('abre a home e depois cada trecho, contando páginas', async () => {
    const { source, opened } = fakeSource();
    const r = await runRound(source, q(3), opts({ pageLimit: 10 }));
    expect(opened).toEqual(['home', 'o0>d0', 'o1>d1', 'o2>d2']);
    expect(r.map((e) => e.status)).toEqual(['ok', 'ok', 'ok']);
    expect(await pagesLeft(10)).toEqual({ used: 4, left: 6 });
  });

  it('limite diário corta a rodada e avisa uma vez por dia', async () => {
    const { source, opened } = fakeSource();
    const onBudgetExhausted = vi.fn(async () => {});
    const r = await runRound(source, q(5), opts({ pageLimit: 3, onBudgetExhausted }));
    expect(opened).toEqual(['home', 'o0>d0', 'o1>d1']);
    expect(r.map((e) => e.status)).toEqual(['ok', 'ok', 'skipped', 'skipped', 'skipped']);
    expect(r[2]).toMatchObject({ reason: 'limite diário de páginas' });
    expect(onBudgetExhausted).toHaveBeenCalledWith({ limit: 3, used: 3, skipped: 3 });

    // Rodada seguinte no mesmo dia: nem abre o navegador, e não avisa de novo.
    const open = vi.fn(async () => fakeContext);
    const r2 = await runRound(source, q(2), opts({ pageLimit: 3, onBudgetExhausted, openContext: open }));
    expect(r2.every((e) => e.status === 'skipped')).toBe(true);
    expect(open).not.toHaveBeenCalled();
    expect(onBudgetExhausted).toHaveBeenCalledTimes(1);
  });

  it('com saldo de 1 página não começa (não gasta a última só com a home)', async () => {
    const { source, opened } = fakeSource();
    await runRound(source, q(1), opts({ pageLimit: 3 }));   // home + 1 = 2 usadas
    await runRound(source, q(1), opts({ pageLimit: 3 }));   // sobra 1: não começa
    expect(opened).toEqual(['home', 'o0>d0']);
  });

  it('bloqueio para a rodada, grava a pausa de 6 h e a próxima rodada não abre nada', async () => {
    const { source, opened } = fakeSource((x) => (x.from === 'o1' ? 'blocked' : 'ok'));
    const onBlocked = vi.fn(async () => {});
    const r = await runRound(source, q(4), opts({ pageLimit: 100, onBlocked }));
    expect(r.map((e) => e.status)).toEqual(['ok', 'blocked', 'skipped', 'skipped']);
    expect(onBlocked).toHaveBeenCalledTimes(1);
    expect(await activeCooldown()).not.toBeNull();

    const open = vi.fn(async () => fakeContext);
    const r2 = await runRound(source, q(2), opts({ pageLimit: 100, openContext: open, onBlocked }));
    expect(r2.every((e) => e.status === 'skipped')).toBe(true);
    expect(open).not.toHaveBeenCalled();
    expect(onBlocked).toHaveBeenCalledTimes(1); // aviso único
    expect(opened).toEqual(['home', 'o0>d0', 'o1>d1']);
  });

  it('home bloqueada conta como bloqueio (nenhuma busca)', async () => {
    const { source, opened } = fakeSource();
    source.prepare = vi.fn(async () => ({ status: 'blocked' as const, error: 'HTTP 403' }));
    const onResult = vi.fn(async () => {});
    const r = await runRound(source, q(3), opts({ pageLimit: 100, onResult }));
    expect(r.map((e) => e.status)).toEqual(['blocked', 'skipped', 'skipped']);
    expect(r[0]).toMatchObject({ error: 'página inicial: HTTP 403' });
    expect(onResult).toHaveBeenCalledTimes(1); // o bloqueio vai para collector_runs
    expect(opened).toEqual([]);
    expect(await activeCooldown()).not.toBeNull();
  });
});
