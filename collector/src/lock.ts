import fs from 'node:fs/promises';
import { stateFile } from './browser.js';

const STALE_MS = 3 * 60 * 60_000; // trava mais velha que isso é resto de processo morto

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * Um navegador por vez: a rodada agendada e o worker nunca abrem páginas ao mesmo
 * tempo (regra "nunca paralelizar") nem disputam o mesmo perfil do Chrome.
 */
export async function withCollectorLock<T>(fn: () => Promise<T>,
  { waitMs = 45 * 60_000, pollMs = 5_000, log = console.log, file = stateFile('.collector.lock') } = {}): Promise<T> {
  const deadline = Date.now() + waitMs;
  let warned = false;
  for (;;) {
    try {
      await fs.writeFile(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const holder = await fs.readFile(file, 'utf8').then((s) => JSON.parse(s) as { pid: number; at: string }).catch(() => null);
      if (!holder || !alive(holder.pid) || Date.now() - Date.parse(holder.at) > STALE_MS) {
        await fs.rm(file, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`coletor ocupado (pid ${holder.pid}) há mais de ${waitMs / 60_000} min`);
      if (!warned) { log(`  … outra coleta em andamento (pid ${holder.pid}); aguardando`); warned = true; }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(file, { force: true });
  }
}
