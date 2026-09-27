import fs from 'node:fs/promises';
import { stateFile } from './browser.js';

/** Depois de um bloqueio, nenhuma página é aberta por este tempo (rodadas e worker). */
export const COOLDOWN_HOURS = 6;

export interface Cooldown {
  until: string;      // ISO
  since: string;      // ISO
  reason: string;     // trecho + motivo do bloqueio
}

/**
 * Arquivo local (e não o banco): funciona mesmo com o Supabase fora do ar e é
 * checado antes de abrir o navegador. O bloqueio em si também fica em collector_runs.
 */
export async function activeCooldown(now = new Date(), file = stateFile('.cooldown.json')): Promise<Cooldown | null> {
  let c: Cooldown;
  try {
    c = JSON.parse(await fs.readFile(file, 'utf8')) as Cooldown;
  } catch {
    return null; // sem arquivo (ou ilegível): sem pausa
  }
  return Date.parse(c.until) > now.getTime() ? c : null;
}

export async function startCooldown(reason: string, now = new Date(), file = stateFile('.cooldown.json'),
  hours = COOLDOWN_HOURS): Promise<Cooldown> {
  const c: Cooldown = { since: now.toISOString(), until: new Date(now.getTime() + hours * 3600_000).toISOString(), reason };
  await fs.writeFile(file, JSON.stringify(c, null, 2));
  return c;
}

/** "03/10 01:15" em America/Bahia, para logs e Telegram. */
export function formatLocal(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', {
    timeZone: 'America/Bahia', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  }).replace(',', '');
}
