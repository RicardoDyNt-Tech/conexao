import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { withCollectorLock } from '../src/lock.js';

const tmpLock = async () => path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'lock-')), '.lock');
const quiet = () => {};

describe('withCollectorLock', () => {
  it('serializa: a 2ª coleta espera a 1ª terminar', async () => {
    const file = await tmpLock();
    const order: string[] = [];
    const first = withCollectorLock(async () => {
      order.push('a:start'); await new Promise((r) => setTimeout(r, 150)); order.push('a:end');
    }, { file, pollMs: 20, log: quiet });
    await new Promise((r) => setTimeout(r, 20));
    const second = withCollectorLock(async () => { order.push('b'); }, { file, pollMs: 20, log: quiet });
    await Promise.all([first, second]);
    expect(order).toEqual(['a:start', 'a:end', 'b']);
    await expect(fs.access(file)).rejects.toThrow(); // trava removida no fim
  });

  it('trava de processo morto é ignorada', async () => {
    const file = await tmpLock();
    await fs.writeFile(file, JSON.stringify({ pid: 2 ** 22 + 12345, at: new Date().toISOString() }));
    await expect(withCollectorLock(async () => 'ok', { file, log: quiet })).resolves.toBe('ok');
  });

  it('desiste depois do tempo máximo de espera', async () => {
    const file = await tmpLock();
    await fs.writeFile(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    await expect(withCollectorLock(async () => 'x', { file, waitMs: 50, pollMs: 10, log: quiet }))
      .rejects.toThrow(/coletor ocupado/);
  });

  it('libera a trava mesmo se a coleta lançar erro', async () => {
    const file = await tmpLock();
    await expect(withCollectorLock(async () => { throw new Error('falhou'); }, { file, log: quiet })).rejects.toThrow('falhou');
    await expect(withCollectorLock(async () => 'ok', { file, log: quiet })).resolves.toBe('ok');
  });
});
