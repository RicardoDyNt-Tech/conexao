import fs from 'node:fs/promises';
import path from 'node:path';
import { COLLECTOR_DIR, openBrowser } from './browser.js';
import type { LegQuery, LegResult, Source } from './types.js';

export interface Leg { from: string; to: string }
export type RoundEntry = Omit<LegResult, 'raw'> | (LegQuery & { source: string; status: 'skipped' });

export interface RoundOptions {
  headless: boolean;
  saveRaw: boolean;
  minPauseMs?: number;
  maxPauseMs?: number;
  log?: (msg: string) => void;
  /** Chamado após cada trecho (ex.: gravar no Supabase). Erro aqui não para a rodada. */
  onResult?: (r: LegResult) => Promise<void>;
}

const OUTPUT_DIR = path.join(COLLECTOR_DIR, 'output');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function loadLegs(list: 'legs' | 'spike' = 'legs'): Promise<Leg[]> {
  const cfg = JSON.parse(await fs.readFile(path.join(COLLECTOR_DIR, 'config', 'legs.json'), 'utf8'));
  return cfg[list] as Leg[];
}

/**
 * Uma página por vez, pausa aleatória entre páginas.
 * Falha de um trecho não para a rodada; bloqueio (captcha/403) para tudo.
 */
export async function runRound(source: Source, queries: LegQuery[], opts: RoundOptions): Promise<RoundEntry[]> {
  const { minPauseMs = 8_000, maxPauseMs = 15_000, log = console.log } = opts;
  const results: RoundEntry[] = [];
  if (opts.saveRaw) await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const context = await openBrowser({ headless: opts.headless });
  try {
    for (let i = 0; i < queries.length; i++) {
      const q = queries[i]!;
      if (i > 0) {
        const pause = minPauseMs + Math.random() * (maxPauseMs - minPauseMs);
        log(`  … pausa de ${(pause / 1000).toFixed(1)} s`);
        await sleep(pause);
      }
      log(`→ ${q.from} → ${q.to} (${q.date})`);
      const { raw, ...res } = await source.collect(context, q);
      results.push(res);
      log(`  ${res.status}${res.trips.length ? `: ${res.trips.length} viagens` : ''}${res.error ? ` — ${res.error}` : ''}`);
      if (opts.onResult) {
        await opts.onResult(res).catch((e) => log(`  ⚠ falha ao gravar no banco: ${(e as Error).message}`));
      }

      if (opts.saveRaw && raw !== undefined) {
        const base = path.join(OUTPUT_DIR, `${source.name}_${q.from}_${q.to}_${q.date}`);
        await fs.writeFile(`${base}.json`, JSON.stringify(raw, null, 2));
        await fs.writeFile(`${base}.normalized.json`, JSON.stringify(res.trips, null, 2));
      }
      if (res.status === 'blocked') {
        log('  ⛔ bloqueio detectado: rodada interrompida (não insistir).');
        for (const rest of queries.slice(i + 1)) results.push({ source: source.name, ...rest, status: 'skipped' });
        break;
      }
    }
  } finally {
    await context.close();
  }
  return results;
}

export function formatSummary(entries: RoundEntry[]): string {
  const rows = entries.map((e) => {
    const n = 'trips' in e ? String(e.trips.length) : '-';
    const err = 'error' in e && e.error ? e.error : '';
    return [`${e.from} → ${e.to}`, e.date, e.status, n, err];
  });
  const header = ['trecho', 'data', 'status', 'viagens', 'detalhe'];
  const widths = header.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c]!.length)));
  const fmt = (r: string[]) => r.map((v, c) => v.padEnd(widths[c]!)).join('  ').trimEnd();
  return [fmt(header), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(fmt)].join('\n');
}
