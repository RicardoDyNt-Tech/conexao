import fs from 'node:fs/promises';
import path from 'node:path';
import { COLLECTOR_DIR, openBrowser } from './browser.js';
import { withCollectorLock } from './lock.js';
import { activeCooldown, COOLDOWN_HOURS, formatLocal, startCooldown, type Cooldown } from './cooldown.js';
import { claimBudgetNotice, dailyPageLimit, pagesLeft, takePage } from './budget.js';
import type { BrowserContext } from 'playwright';
import type { LegQuery, LegResult, Source } from './types.js';

export interface Leg { from: string; to: string }
export type RoundEntry = Omit<LegResult, 'raw'> | (LegQuery & { source: string; status: 'skipped'; reason?: string });

export interface BudgetExhausted { limit: number; used: number; skipped: number }

export interface RoundOptions {
  headless: boolean;
  saveRaw: boolean;
  minPauseMs?: number;
  maxPauseMs?: number;
  log?: (msg: string) => void;
  /** Chamado após cada trecho (ex.: gravar no Supabase). Erro aqui não para a rodada. */
  onResult?: (r: LegResult) => Promise<void>;
  /** Chamado assim que um trecho vem "blocked" (já com a pausa de 6 h gravada), antes de a rodada parar. */
  onBlocked?: (r: LegResult, cooldown: Cooldown) => Promise<void>;
  /** Pausa também antes da 1ª página (quando outra coleta acabou de rodar). */
  pauseFirst?: boolean;
  /** Limite diário de páginas atingido (chamado no máximo 1× por dia, para o aviso). */
  onBudgetExhausted?: (info: BudgetExhausted) => Promise<void>;
  /** Padrão: DAILY_PAGE_LIMIT do .env ou 120. */
  pageLimit?: number;
  /** Só para testes: substitui a abertura do Chrome. */
  openContext?: () => Promise<BrowserContext>;
}

/** Saldo mínimo para começar uma rodada: a home + pelo menos 1 busca. */
const MIN_PAGES_TO_START = 2;

const OUTPUT_DIR = path.join(COLLECTOR_DIR, 'output');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function loadLegs(list: 'legs' | 'spike' = 'legs'): Promise<Leg[]> {
  const cfg = JSON.parse(await fs.readFile(path.join(COLLECTOR_DIR, 'config', 'legs.json'), 'utf8'));
  return cfg[list] as Leg[];
}

/** Pausa aleatória entre páginas (ajustada depois de um 403 com 8–15 s). */
export const PAUSE_MS = { min: 15_000, max: 30_000 };

/** Fisher–Yates; `rng` injetável para teste. */
export function shuffle<T>(items: readonly T[], rng: () => number = Math.random): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

const skippedAll = (source: Source, qs: LegQuery[], reason?: string): RoundEntry[] =>
  qs.map((q) => ({ source: source.name, ...q, status: 'skipped' as const, ...(reason ? { reason } : {}) }));
const BUDGET_REASON = 'limite diário de páginas';

/**
 * Uma página por vez, pausa aleatória entre páginas.
 * Falha de um trecho não para a rodada; bloqueio (captcha/403) para tudo e grava
 * uma pausa de 6 h: até lá, nenhuma rodada nem pedido abre páginas (tudo vira "skipped").
 */
export async function runRound(source: Source, queries: LegQuery[], opts: RoundOptions): Promise<RoundEntry[]> {
  return withCollectorLock(() => runRoundLocked(source, queries, opts), { log: opts.log });
}

async function runRoundLocked(source: Source, queries: LegQuery[], opts: RoundOptions): Promise<RoundEntry[]> {
  const { minPauseMs = PAUSE_MS.min, maxPauseMs = PAUSE_MS.max, log = console.log } = opts;
  const results: RoundEntry[] = [];

  // Checado de novo dentro da trava: outra coleta pode ter sido bloqueada enquanto esperávamos.
  const paused = await activeCooldown();
  if (paused) {
    log(`⏸ Em pausa até ${formatLocal(paused.until)} por bloqueio (${paused.reason}). Nenhuma página aberta.`);
    return skippedAll(source, queries);
  }
  if (!queries.length) return results;

  const limit = opts.pageLimit ?? dailyPageLimit();
  const exhausted = async (rest: LegQuery[]) => {
    const { used } = await pagesLeft(limit);
    log(`  📉 limite diário de ${limit} páginas atingido (${used} usadas): ${rest.length} trecho(s) ficam para amanhã.`);
    results.push(...skippedAll(source, rest, BUDGET_REASON));
    if (opts.onBudgetExhausted && await claimBudgetNotice()) {
      await opts.onBudgetExhausted({ limit, used, skipped: rest.length })
        .catch((e) => log(`  ⚠ falha ao avisar limite: ${(e as Error).message}`));
    }
  };
  if ((await pagesLeft(limit)).left < MIN_PAGES_TO_START) {
    await exhausted(queries);
    return results;
  }
  if (opts.saveRaw) await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const block = async (res: LegResult, rest: LegQuery[]) => {
    const cooldown = await startCooldown(`${res.from} → ${res.to}: ${res.error ?? 'bloqueio'}`);
    log(`  ⛔ bloqueio detectado: rodada interrompida; pausa de ${COOLDOWN_HOURS} h (até ${formatLocal(cooldown.until)}).`);
    if (opts.onBlocked) await opts.onBlocked(res, cooldown).catch((e) => log(`  ⚠ falha ao avisar bloqueio: ${(e as Error).message}`));
    results.push(...skippedAll(source, rest));
  };

  const context = opts.openContext ? await opts.openContext() : await openBrowser({ headless: opts.headless });
  try {
    if (source.prepare) {
      log('→ página inicial');
      await takePage(limit); // saldo garantido pelo MIN_PAGES_TO_START
      const prep = await source.prepare(context);
      if (prep.status === 'blocked') {
        const q = queries[0]!;
        const now = new Date().toISOString();
        const res: LegResult = { source: source.name, ...q, status: 'blocked', trips: [], found: 0, warnings: [],
          error: `página inicial: ${prep.error ?? 'bloqueio'}`, started_at: now, finished_at: now };
        results.push(res);
        if (opts.onResult) await opts.onResult(res).catch((e) => log(`  ⚠ falha ao gravar no banco: ${(e as Error).message}`));
        await block(res, queries.slice(1));
        return results;
      }
      if (prep.status === 'error') log(`  ⚠ página inicial falhou (${prep.error}); seguindo com as buscas`);
    }

    for (let i = 0; i < queries.length; i++) {
      const q = queries[i]!;
      if (!(await takePage(limit))) {
        await exhausted(queries.slice(i));
        break;
      }
      if (i > 0 || opts.pauseFirst) {
        const pause = minPauseMs + Math.random() * (maxPauseMs - minPauseMs);
        log(`  … pausa de ${(pause / 1000).toFixed(1)} s`);
        await sleep(pause);
      }
      log(`→ ${q.from} → ${q.to} (${q.date})`);
      const { raw, ...res } = await source.collect(context, q);
      results.push(res);
      log(`  ${res.status}${res.found ? `: ${res.found} viagens` : ''}${res.error ? ` — ${res.error}` : ''}${res.detail ? ` (${res.detail})` : ''}`);
      if (opts.onResult) {
        await opts.onResult(res).catch((e) => log(`  ⚠ falha ao gravar no banco: ${(e as Error).message}`));
      }

      if (opts.saveRaw && raw !== undefined) {
        const base = path.join(OUTPUT_DIR, `${source.name}_${q.from}_${q.to}_${q.date}`);
        await fs.writeFile(`${base}.json`, JSON.stringify(raw, null, 2));
        await fs.writeFile(`${base}.normalized.json`, JSON.stringify(res.trips, null, 2));
      }
      if (res.status === 'blocked') {
        await block(res, queries.slice(i + 1));
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
    const n = 'found' in e ? String(e.found) : '-';
    const err = ('error' in e && e.error) || ('detail' in e && e.detail) || ('reason' in e && e.reason) || '';
    return [`${e.from} → ${e.to}`, e.date, e.status, n, err];
  });
  const header = ['trecho', 'data', 'status', 'viagens', 'detalhe'];
  const widths = header.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c]!.length)));
  const fmt = (r: string[]) => r.map((v, c) => v.padEnd(widths[c]!)).join('  ').trimEnd();
  return [fmt(header), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(fmt)].join('\n');
}
