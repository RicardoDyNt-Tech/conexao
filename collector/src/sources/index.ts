import type { Source } from '../types.js';
import { clickbus } from './clickbus.js';
import { queropassagem } from './queropassagem.js';

/** Fontes disponíveis, na ordem em que a rodada roda (uma de cada vez). */
export const SOURCES: Source[] = [clickbus, queropassagem];

const LABELS: Record<string, string> = { clickbus: 'ClickBus', queropassagem: 'Quero Passagem' };
export const sourceLabel = (name: string): string => LABELS[name] ?? name;

/** `--source clickbus|queropassagem|all` (padrão all). */
export function parseSources(arg: string = 'all'): Source[] {
  if (arg === 'all') return SOURCES;
  const s = SOURCES.find((x) => x.name === arg);
  if (!s) throw new Error(`--source deve ser ${SOURCES.map((x) => x.name).join(', ')} ou all`);
  return [s];
}
