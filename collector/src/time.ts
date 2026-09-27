export const SOURCE_TZ = 'America/Bahia';

/** Diferença (ms) entre o horário de parede em `tz` e UTC num dado instante. */
function tzOffsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - utcMs;
}

/**
 * Converte data + hora "de parede" num fuso para ISO UTC.
 * Usa Intl em vez de offset fixo (-03:00) para não quebrar em fusos com horário de verão (Etapa 2).
 */
export function zonedToUtcIso(date: string, time: string, tz: string = SOURCE_TZ): string {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!d || !t) throw new Error(`data/hora inválida: "${date}" "${time}"`);
  const naive = Date.UTC(+d[1]!, +d[2]! - 1, +d[3]!, +t[1]!, +t[2]!, +(t[3] ?? 0));
  // Duas passadas resolvem o caso em que o offset muda entre o palpite e o resultado.
  let utc = naive - tzOffsetMs(naive, tz);
  utc = naive - tzOffsetMs(utc, tz);
  return new Date(utc).toISOString();
}

/** Data de hoje (AAAA-MM-DD) no fuso informado. */
export function todayIn(tz: string = SOURCE_TZ, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Próxima segunda-feira estritamente depois de `date`. */
export function nextMonday(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = domingo
  return addDays(date, ((8 - dow) % 7) || 7);
}

/** Hora local (0–23) no fuso informado. */
export function hourIn(tz: string = SOURCE_TZ, now: Date = new Date()): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(now));
}

/** Primeira data da coleta: hoje, ou amanhã se já passou das `cutoffHour` (quase não há mais ônibus hoje). */
export function defaultStartDate(now: Date = new Date(), tz: string = SOURCE_TZ, cutoffHour = 20): string {
  const today = todayIn(tz, now);
  return hourIn(tz, now) >= cutoffHour ? addDays(today, 1) : today;
}
