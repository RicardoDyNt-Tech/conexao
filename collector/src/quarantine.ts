import fs from 'node:fs/promises';
import { stateFile } from './browser.js';

/**
 * Quarentena: depois de um bloqueio, nenhuma página é aberta por este tempo (rodadas
 * agendadas e worker). O app deduz a mesma quarentena de collector_runs (collector_status);
 * se mudar aqui, mude lá também.
 */
export const QUARANTINE_HOURS = 24;

export interface Quarantine {
  until: string;      // ISO
  since: string;      // ISO
  reason: string;     // trecho + motivo do bloqueio
}

/**
 * Arquivo local (e não só o banco): funciona mesmo com o Supabase fora do ar e é
 * checado antes de abrir o navegador. O bloqueio em si também fica em collector_runs.
 */
export async function activeQuarantine(now = new Date(), file = stateFile('.quarantine.json')): Promise<Quarantine | null> {
  let q: Quarantine;
  try {
    q = JSON.parse(await fs.readFile(file, 'utf8')) as Quarantine;
  } catch {
    return null; // sem arquivo (ou ilegível): sem quarentena
  }
  return Date.parse(q.until) > now.getTime() ? q : null;
}

export async function startQuarantine(reason: string, now = new Date(), file = stateFile('.quarantine.json'),
  hours = QUARANTINE_HOURS): Promise<Quarantine> {
  const q: Quarantine = { since: now.toISOString(), until: new Date(now.getTime() + hours * 3600_000).toISOString(), reason };
  await fs.writeFile(file, JSON.stringify(q, null, 2));
  return q;
}

/** Encerra a quarentena (só depois de uma rodada manual com --ignore-quarantine que deu certo). */
export async function clearQuarantine(file = stateFile('.quarantine.json')): Promise<void> {
  await fs.rm(file, { force: true });
}

/** "01:15 de 03/10" em America/Bahia, para logs e Telegram. */
export function formatUntil(iso: string): string {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Bahia', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? '';
  return `${p('hour')}:${p('minute')} de ${p('day')}/${p('month')}`;
}
