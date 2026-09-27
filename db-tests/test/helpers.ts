import type { PGlite } from '@electric-sql/pglite';
import { zonedToUtcIso } from '../../collector/src/time.js';
import { asRole } from './db.js';

export const FEIRA = 2910800, ALAGOINHAS = 2900702, SALVADOR = 2927408, CATU = 2907509;

let seq = 0;
/** Viagem no formato NormalizedTrip, com horários locais (America/Bahia). */
export function trip(o: {
  dep: string; arr: string;            // 'AAAA-MM-DD HH:MM'
  price?: number; seats?: number; id?: string;
  from_station?: number; to_station?: number; company?: string; company_slug?: string;
  fee?: number; parts?: number; url?: string;
}) {
  const [dd, dt] = o.dep.split(' ') as [string, string];
  const [ad, at] = o.arr.split(' ') as [string, string];
  return {
    source_trip_id: o.id ?? `t${++seq}`,
    travel_date: dd,
    company: o.company ?? 'Viação Teste', company_slug: o.company_slug ?? 'viacao-teste',
    origin_station: `rod ${o.from_station ?? 0}`, origin_station_id: o.from_station ?? null,
    dest_station: `rod ${o.to_station ?? 0}`, dest_station_id: o.to_station ?? null,
    departure_at: zonedToUtcIso(dd, dt), arrival_at: zonedToUtcIso(ad, at),
    service_class: 'Convencional', price: o.price ?? 30, original_price: null,
    seats_available: o.seats ?? 40, seats_total: 46, is_low_fare: false, parts_count: o.parts ?? 1,
    service_fee: o.fee ?? null,
    buy_url: o.url ?? 'https://example.invalid',
  };
}

export async function record(db: PGlite, from: string, to: string, date: string,
  status: string, trips: unknown[] = [], error: string | null = null, source = 'clickbus') {
  return asRole(db, 'service_role', () => db.query(
    `select record_leg_result($7, $1, $2, $3::date, $4, $5::jsonb, $6) as id`,
    [from, to, date, status, JSON.stringify(trips), error, source]));
}

/** Slugs do Quero Passagem no seed (Catu e Alagoinhas sem "-ba"). */
export const QP = { feira: 'feira-de-santana-ba', alagoinhas: 'alagoinhas', salvador: 'salvador-ba', catu: 'catu' };
export const recordQp = (db: PGlite, from: string, to: string, date: string, status: string, trips: unknown[] = []) =>
  record(db, from, to, date, status, trips, null, 'queropassagem');

/** Converte timestamptz → 'AAAA-MM-DD HH:MM' em America/Bahia (UTC-3), para asserts legíveis. */
export function local(d: Date | null): string | null {
  if (!d) return null;
  return new Date(d.getTime() - 3 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');
}

/** Intervalo do Postgres (PGlite devolve string) → minutos. */
export function minutes(iv: unknown): number {
  const s = String(iv);
  const neg = s.startsWith('-');
  const m = /(?:(\d+) days? ?)?(-?\d+):(\d+):(\d+)/.exec(s.replace(/^-/, ''));
  if (!m) throw new Error(`intervalo inesperado: ${s}`);
  const total = Number(m[1] ?? 0) * 1440 + Number(m[2]) * 60 + Number(m[3]);
  return neg ? -total : total;
}
