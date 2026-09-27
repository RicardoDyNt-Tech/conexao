import fs from 'node:fs/promises';
import { stateFile } from './browser.js';
import { SOURCE_TZ, todayIn } from './time.js';

/**
 * Teto diário de páginas abertas (rodadas + pedidos + spike, home incluída).
 * Motivo: um 403 depois de ~100 páginas numa noite de testes. Zera à meia-noite (America/Bahia).
 */
export const DEFAULT_DAILY_PAGE_LIMIT = 120;

export function dailyPageLimit(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.DAILY_PAGE_LIMIT);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_DAILY_PAGE_LIMIT;
}

interface BudgetState { date: string; pages: number; notified: boolean }

async function read(file: string, today: string): Promise<BudgetState> {
  try {
    const s = JSON.parse(await fs.readFile(file, 'utf8')) as BudgetState;
    if (s.date === today && Number.isInteger(s.pages)) return s;
  } catch { /* sem arquivo ou ilegível: dia novo */ }
  return { date: today, pages: 0, notified: false };
}

export async function pagesLeft(limit: number, now = new Date(), file = stateFile('.page-budget.json')):
  Promise<{ used: number; left: number }> {
  const s = await read(file, todayIn(SOURCE_TZ, now));
  return { used: s.pages, left: Math.max(0, limit - s.pages) };
}

/** Conta uma página se ainda houver saldo. false = limite do dia atingido (não abrir). */
export async function takePage(limit: number, now = new Date(), file = stateFile('.page-budget.json')): Promise<boolean> {
  const s = await read(file, todayIn(SOURCE_TZ, now));
  if (s.pages >= limit) return false;
  s.pages++;
  await fs.writeFile(file, JSON.stringify(s));
  return true;
}

/** true só na 1ª chamada do dia: o aviso do limite sai uma vez por dia. */
export async function claimBudgetNotice(now = new Date(), file = stateFile('.page-budget.json')): Promise<boolean> {
  const s = await read(file, todayIn(SOURCE_TZ, now));
  if (s.notified) return false;
  s.notified = true;
  await fs.writeFile(file, JSON.stringify(s));
  return true;
}
