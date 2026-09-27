import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { activeCooldown, formatLocal, startCooldown } from '../src/cooldown.js';
import { shuffle } from '../src/runner.js';

const tmpFile = async () => path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'cd-')), '.cooldown.json');

describe('pausa de 6 h após bloqueio', () => {
  const t0 = new Date('2026-10-02T22:00:00Z'); // 19:00 na Bahia

  it('sem arquivo → sem pausa', async () => {
    expect(await activeCooldown(t0, await tmpFile())).toBeNull();
  });

  it('vale por 6 h e depois expira', async () => {
    const file = await tmpFile();
    const c = await startCooldown('salvador-ba → catu-ba: HTTP 403', t0, file);
    expect(c.until).toBe('2026-10-03T04:00:00.000Z');
    expect(formatLocal(c.until)).toBe('03/10 01:00');
    expect(await activeCooldown(new Date('2026-10-03T03:59:00Z'), file)).toMatchObject({ reason: c.reason });
    expect(await activeCooldown(new Date('2026-10-03T04:00:00Z'), file)).toBeNull();
  });

  it('novo bloqueio renova a pausa', async () => {
    const file = await tmpFile();
    await startCooldown('1º', t0, file);
    const later = new Date(t0.getTime() + 7 * 3600_000);
    await startCooldown('2º', later, file);
    expect(await activeCooldown(new Date(later.getTime() + 5 * 3600_000), file)).toMatchObject({ reason: '2º' });
  });

  it('arquivo ilegível é ignorado', async () => {
    const file = await tmpFile();
    await fs.writeFile(file, 'lixo');
    expect(await activeCooldown(t0, file)).toBeNull();
  });
});

describe('shuffle', () => {
  it('mantém os mesmos itens e não altera a lista original', () => {
    const legs = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const out = shuffle(legs);
    expect([...out].sort()).toEqual(legs);
    expect(legs).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  });

  it('a ordem depende do sorteio', () => {
    const seq = (vals: number[]) => { let i = 0; return () => vals[i++ % vals.length]!; };
    expect(shuffle([1, 2, 3], seq([0, 0]))).toEqual([2, 3, 1]);
    expect(shuffle([1, 2, 3], seq([0.99, 0.99]))).toEqual([1, 2, 3]);
  });
});
