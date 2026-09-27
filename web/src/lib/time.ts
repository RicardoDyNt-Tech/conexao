// Toda hora exibida no app é em America/Bahia, qualquer que seja o fuso do celular.
export const TZ = 'America/Bahia';

function parts(iso: string | Date, opts: Intl.DateTimeFormatOptions) {
  const ps = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hourCycle: 'h23', ...opts })
    .formatToParts(typeof iso === 'string' ? new Date(iso) : iso);
  return (t: Intl.DateTimeFormatPartTypes) => ps.find((p) => p.type === t)?.value ?? '';
}

/** "14:30" */
export function fmtTime(iso: string | Date): string {
  const p = parts(iso, { hour: '2-digit', minute: '2-digit' });
  return `${p('hour')}:${p('minute')}`;
}

/** "AAAA-MM-DD" da data local (Bahia) de um instante. */
export function localDate(iso: string | Date): string {
  const p = parts(iso, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return `${p('year')}-${p('month')}-${p('day')}`;
}

/** "AAAA-MM-DD HH:MM" local, para comparar com filtros de horário. */
export function localDateTime(iso: string | Date): string {
  return `${localDate(iso)} ${fmtTime(iso)}`;
}

/** Hoje (AAAA-MM-DD) na Bahia. */
export function today(now: Date = new Date()): string {
  return localDate(now);
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Diferença em dias entre duas datas AAAA-MM-DD. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** 0 = domingo … 6 = sábado, de uma data AAAA-MM-DD. */
export function weekday(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

/** Próxima data (a partir de hoje, inclusive) com esse dia da semana. */
export function nextWeekday(from: string, dow: number): string {
  return addDays(from, (dow - weekday(from) + 7) % 7);
}

const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

/** "sex, 10/10" */
export function fmtDate(date: string): string {
  return `${WEEKDAYS[weekday(date)]}, ${date.slice(8, 10)}/${date.slice(5, 7)}`;
}

/** "HH:MM" se for hoje (Bahia); senão "DD/MM HH:MM". */
export function fmtStamp(iso: string, now: Date = new Date()): string {
  const d = localDate(iso);
  return d === today(now) ? fmtTime(iso) : `${d.slice(8, 10)}/${d.slice(5, 7)} ${fmtTime(iso)}`;
}

/** Minutos entre dois instantes. */
export function minutesBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60_000);
}

/** "3h40", "1h", "55 min" */
export function fmtDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
}

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
/** "R$ 57,43" (espaço normal, não o especial do Intl, para testes e leitura). */
export function fmtMoney(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  return brl.format(Number(v)).replace(/ /g, ' ');
}
