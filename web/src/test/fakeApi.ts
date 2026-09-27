import { vi } from 'vitest';
import type { Session } from '@supabase/supabase-js';
import type { Api } from '../lib/api';
import type { CollectorStatus, Connection, CoverageLeg, Offer, Route } from '../lib/types';

export const FEIRA = { id: 2910800, name: 'Feira de Santana' };
export const CATU = { id: 2907509, name: 'Catu' };
export const ALAGOINHAS = { id: 2900702, name: 'Alagoinhas' };
export const SALVADOR = { id: 2927408, name: 'Salvador' };

export const ROUTES: Route[] = [
  { origin: FEIRA, dest: CATU, hubs: [ALAGOINHAS, SALVADOR] },
  { origin: CATU, dest: FEIRA, hubs: [ALAGOINHAS, SALVADOR] },
];

export const SESSION = { user: { email: 'ricardo@example.com' } } as unknown as Session;

/** Horário local da Bahia (UTC-3) → ISO UTC. */
export const bahia = (date: string, time: string) =>
  new Date(Date.parse(`${date}T${time}:00Z`) + 3 * 3600_000).toISOString();

let seq = 1;
export function conn(o: {
  date: string; dep: string; arr1: string; dep2?: string; arr: string; arrDate?: string; dep2Date?: string;
  via?: string; price?: number; same_station?: boolean | null; asOf?: string;
  leg1Offers?: Offer[]; leg2Offers?: Offer[]; leg1Source?: string; leg2Source?: string;
}): Connection {
  const direct = !o.dep2;
  const id = seq++;
  return {
    kind: direct ? 'direct' : 'connection',
    via_city_id: direct ? null : 1, via_city: direct ? null : (o.via ?? 'Salvador'),
    leg1_trip_id: id, leg1_company: 'Rota', leg1_service_class: 'Executivo',
    leg1_origin_station: 'Rodoviária de Feira', leg1_dest_station: direct ? 'Catu, BA' : 'Rodoviária do hub',
    leg1_departure_at: bahia(o.date, o.dep), leg1_arrival_at: bahia(o.date, o.arr1),
    leg1_price: 40, leg1_seats: 30, leg1_buy_url: `https://www.clickbus.com.br/leg1/${id}`,
    leg1_source: o.leg1Source ?? 'clickbus', leg1_service_fee: null, leg1_offers: o.leg1Offers ?? null,
    leg2_trip_id: direct ? null : id + 1000, leg2_company: direct ? null : 'Cidade Sol',
    leg2_service_class: direct ? null : 'Convencional',
    leg2_origin_station: direct ? null : 'Outra rodoviária', leg2_dest_station: direct ? null : 'Catu, BA',
    leg2_departure_at: direct ? null : bahia(o.dep2Date ?? o.date, o.dep2!),
    leg2_arrival_at: direct ? null : bahia(o.arrDate ?? o.date, o.arr),
    leg2_price: direct ? null : 17.43, leg2_seats: direct ? null : 12,
    leg2_buy_url: direct ? null : `https://www.clickbus.com.br/leg2/${id}`,
    leg2_source: direct ? null : (o.leg2Source ?? 'clickbus'), leg2_service_fee: null, leg2_offers: o.leg2Offers ?? null,
    departure_at: bahia(o.date, o.dep), arrival_at: bahia(o.arrDate ?? o.date, o.arr),
    total_price: o.price ?? 57.43, same_station: direct ? null : (o.same_station ?? true),
    data_as_of: o.asOf ?? new Date().toISOString(),
  };
}

export function coverage(date: string, legs: Array<[hub: string | null, from: string, to: string, status: 'ok' | 'empty' | null, trips?: number]>): CoverageLeg[] {
  return legs.map(([hub, from, to, status, trips]) => ({
    from_city_id: 0, from_city: from, to_city_id: 0, to_city: to, hub_city_id: hub ? 1 : null, hub_city: hub,
    status, trips_found: status ? (trips ?? 0) : null, finished_at: status ? bahia(date, '07:10') : null, detail: null,
  }));
}

export const EMPTY_STATUS: CollectorStatus = { last_round: null, quarantine: null, open_requests: [], collected_dates: [] };

export function fakeApi(overrides: Partial<Api> = {}): Api {
  return {
    getSession: vi.fn(async () => SESSION),
    onAuthChange: vi.fn(() => () => {}),
    sendMagicLink: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
    listRoutes: vi.fn(async () => ROUTES),
    findConnections: vi.fn(async () => []),
    dateCoverage: vi.fn(async () => []),
    firstLegs: vi.fn(async () => []),
    secondLegs: vi.fn(async () => []),
    collectorStatus: vi.fn(async () => EMPTY_STATUS),
    openRequest: vi.fn(async () => null),
    requestCollect: vi.fn(async (p) => ({
      id: 7, origin_city_id: p.origin, dest_city_id: p.dest, travel_date: p.date, status: 'pending' as const,
      created_at: new Date().toISOString(), done_at: null, error: null,
    })),
    getRequest: vi.fn(async () => null),
    watchRequest: vi.fn(() => () => {}),
    watchStatus: vi.fn(async () => []),
    addWatch: vi.fn(async () => {}),
    removeWatch: vi.fn(async () => {}),
    ...overrides,
  };
}

export const offer = (source: string, price: number, fee: number | null = null): Offer => ({
  source, trip_id: price * 100, price, service_fee: fee, seats_available: 20, service_class: 'Convencional',
  buy_url: `https://${source}.example/comprar/${price}`, fetched_at: new Date().toISOString(),
});
