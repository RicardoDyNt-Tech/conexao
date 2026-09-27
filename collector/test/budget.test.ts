import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claimBudgetNotice, dailyPageLimit, pagesLeft, takePage } from '../src/budget.js';

const tmpFile = async () => path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'bg-')), '.page-budget.json');
const day1 = new Date('2026-10-02T15:00:00Z');          // 12:00 de 02/10 na Bahia
const day1Late = new Date('2026-10-03T02:59:00Z');      // 23:59 de 02/10 na Bahia
const day2 = new Date('2026-10-03T03:00:00Z');          // 00:00 de 03/10 na Bahia

describe('limite diário de páginas', () => {
  it('conta até o limite e depois recusa', async () => {
    const f = await tmpFile();
    for (let i = 0; i < 3; i++) expect(await takePage(3, day1, f)).toBe(true);
    expect(await takePage(3, day1, f)).toBe(false);
    expect(await pagesLeft(3, day1, f)).toEqual({ used: 3, left: 0 });
  });

  it('zera à meia-noite de America/Bahia (não de UTC)', async () => {
    const f = await tmpFile();
    await takePage(2, day1, f); await takePage(2, day1, f);
    expect(await takePage(2, day1Late, f)).toBe(false);
    expect(await pagesLeft(2, day2, f)).toEqual({ used: 0, left: 2 });
    expect(await takePage(2, day2, f)).toBe(true);
  });

  it('aviso só uma vez por dia', async () => {
    const f = await tmpFile();
    expect(await claimBudgetNotice(day1, f)).toBe(true);
    expect(await claimBudgetNotice(day1Late, f)).toBe(false);
    expect(await claimBudgetNotice(day2, f)).toBe(true);
  });

  it('DAILY_PAGE_LIMIT do .env, com padrão 120', () => {
    expect(dailyPageLimit({})).toBe(120);
    expect(dailyPageLimit({ DAILY_PAGE_LIMIT: '80' })).toBe(80);
    expect(dailyPageLimit({ DAILY_PAGE_LIMIT: 'abc' })).toBe(120);
    expect(dailyPageLimit({ DAILY_PAGE_LIMIT: '0' })).toBe(120);
  });
});
