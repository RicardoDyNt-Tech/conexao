import type { WatchAlert } from '../store.js';

const TZ = 'America/Bahia';
const brl = (v: number | string | null | undefined) =>
  v === null || v === undefined ? '—' : `R$ ${Number(v).toFixed(2).replace('.', ',')}`;
const hhmm = (iso: string) => new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  .format(new Date(iso));
const localDate = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso));
const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
/** "sáb, 10/10" */
export const fmtDay = (date: string) =>
  `${WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()]}, ${date.slice(8, 10)}/${date.slice(5, 7)}`;
/** "10/10 07:12" */
const stamp = (iso: string) => `${localDate(iso).slice(8, 10)}/${localDate(iso).slice(5, 7)} ${hhmm(iso)}`;

/** Link para a busca no app (APP_URL do .env, opcional). */
export function appLink(a: Pick<WatchAlert, 'origin_city_id' | 'dest_city_id' | 'travel_date'>, appUrl?: string): string | null {
  if (!appUrl) return null;
  return `${appUrl.replace(/\/+$/, '')}/#/r?o=${a.origin_city_id}&d=${a.dest_city_id}&date=${a.travel_date}&sort=price`;
}

/** Texto do aviso no Telegram (texto simples). */
export function watchAlertMessage(a: WatchAlert, appUrl?: string): string {
  const plus = localDate(a.arrival_at) > a.travel_date ? ' (+1)' : '';
  const route = `${hhmm(a.departure_at)} → ${hhmm(a.arrival_at)}${plus} ${a.via_city ? `via ${a.via_city}` : 'direto'}`;
  const fee = Number(a.service_fee ?? 0);
  const lines = a.kind === 'price'
    ? [
        '🔔 Conexão: preço-alvo atingido',
        `${a.origin_city} → ${a.dest_city} · ${fmtDay(a.travel_date)}`,
        `${brl(a.total_price)} (seu alvo: ${brl(a.max_price)})`,
        route,
      ]
    : [
        '⚠️ Conexão: poucos lugares',
        `${a.origin_city} → ${a.dest_city} · ${fmtDay(a.travel_date)}`,
        `${route}, ${brl(a.total_price)}`,
        `Só ${a.min_seats} ${a.min_seats === 1 ? 'lugar' : 'lugares'}${a.via_city ? ` no ${a.seats_leg ?? 1}º trecho` : ''}.`,
      ];
  if (fee > 0) lines.push(`+ ${brl(fee)} de taxa no pagamento (Quero Passagem)`);
  if (a.data_as_of) lines.push(`Dados de ${stamp(a.data_as_of)}`);
  const link = appLink(a, appUrl);
  if (link) lines.push(link);
  return lines.join('\n');
}
