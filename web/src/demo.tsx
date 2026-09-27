import { createRoot } from 'react-dom/client';
import { ApiContext, type Api } from './lib/api';
import { App } from './App';
import './styles.css';
import type { Session } from '@supabase/supabase-js';

const F = { id: 1, name: 'Feira de Santana' }, C = { id: 2, name: 'Catu' }, A = { id: 3, name: 'Alagoinhas' }, S = { id: 4, name: 'Salvador' };
const b = (d: string, t: string) => new Date(Date.parse(`${d}T${t}:00Z`) + 3 * 3600_000).toISOString();
const D = new URLSearchParams(location.hash.split('?')[1] ?? '').get('date') ?? '2026-09-29';
const mk = (dep: string, a1: string, d2: string | null, arr: string, via: string | null, price: number, same = true, arrD = D) => ({
  kind: d2 ? 'connection' : 'direct', via_city_id: 1, via_city: via, leg1_trip_id: Math.random(), leg1_company: 'Rota Transportes',
  leg1_service_class: 'Executivo', leg1_origin_station: 'Rodoviária de Feira de Santana', leg1_dest_station: `Rodoviária de ${via}`,
  leg1_departure_at: b(D, dep), leg1_arrival_at: b(D, a1), leg1_price: 40, leg1_seats: 22, leg1_buy_url: 'https://www.clickbus.com.br/',
  leg2_trip_id: 9, leg2_company: 'Cidade Sol', leg2_service_class: 'Convencional', leg2_origin_station: same ? `Rodoviária de ${via}` : 'Terminal Norte',
  leg2_dest_station: 'Catu, BA', leg2_departure_at: d2 ? b(D, d2) : null, leg2_arrival_at: b(arrD, arr), leg2_price: price - 40, leg2_seats: 8,
  leg2_buy_url: 'https://www.clickbus.com.br/', departure_at: b(D, dep), arrival_at: b(arrD, arr), total_price: price, same_station: same,
  data_as_of: D === '2026-09-29' ? b('2026-09-28', '07:12') : new Date().toISOString(),
});
const next = (d: string) => new Date(Date.parse(d) + 86400000).toISOString().slice(0, 10);
const api: Api = {
  getSession: async () => (location.search.includes('login') ? null : ({ user: { email: 'ricardo@example.com' } } as unknown as Session)),
  onAuthChange: () => () => {}, sendMagicLink: async () => {}, signOut: async () => {},
  listRoutes: async () => [{ origin: F, dest: C, hubs: [A, S] }, { origin: C, dest: F, hubs: [A, S] }],
  findConnections: async ({ date }) => (date === '2026-09-29' ? [
    mk('06:00', '07:40', '08:30', '10:10', 'Salvador', 71.28),
    mk('09:00', '10:40', '11:00', '12:25', 'Salvador', 66.28, false),
    mk('14:30', '15:50', '17:05', '18:10', 'Alagoinhas', 57.43),
    mk('20:00', '21:40', '23:00', '00:20', 'Salvador', 83.09, true, next(D)),
  ] : []) as never,
  dateCoverage: async ({ date }) => (date === '2026-10-10' ? [] : [
    { hub_city: 'Alagoinhas', from_city: 'Feira de Santana', to_city: 'Alagoinhas', status: 'empty', trips_found: 0 },
    { hub_city: 'Alagoinhas', from_city: 'Alagoinhas', to_city: 'Catu', status: 'ok', trips_found: 12 },
    { hub_city: 'Salvador', from_city: 'Feira de Santana', to_city: 'Salvador', status: 'ok', trips_found: 40 },
    { hub_city: 'Salvador', from_city: 'Salvador', to_city: 'Catu', status: 'ok', trips_found: 3 },
  ]) as never,
  firstLegs: async () => [
    { id: 1, company: 'Rota Transportes', service_class: 'Executivo', origin_station: 'Feira', dest_station: 'Salvador', dest_city_id: 4, departure_at: b(D, '06:00'), arrival_at: b(D, '07:40'), price: 40.5, seats_available: 20, buy_url: 'x', fetched_at: '' },
    { id: 2, company: 'Rota Transportes', service_class: 'Convencional', origin_station: 'Feira', dest_station: 'Alagoinhas', dest_city_id: 3, departure_at: b(D, '14:30'), arrival_at: b(D, '15:50'), price: 40, seats_available: 20, buy_url: 'x', fetched_at: '' },
  ],
  secondLegs: async () => [
    { trip_id: 11, company: 'Cidade Sol', service_class: 'Convencional', origin_station: 'Salvador', dest_station: 'Catu', departure_at: b(D, '07:00'), arrival_at: b(D, '08:20'), price: 28.99, seats_available: 30, buy_url: 'x', fetched_at: '', total_price: 69.49, same_station: true, compatible: false, reason: 'sai antes de você chegar' },
    { trip_id: 12, company: 'Cidade Sol', service_class: 'Convencional', origin_station: 'Salvador', dest_station: 'Catu', departure_at: b(D, '09:00'), arrival_at: b(D, '10:20'), price: 28.99, seats_available: 30, buy_url: 'x', fetched_at: '', total_price: 69.49, same_station: true, compatible: true, reason: null },
    { trip_id: 13, company: 'Rota', service_class: 'Executivo', origin_station: 'Salvador', dest_station: 'Catu', departure_at: b(D, '13:00'), arrival_at: b(D, '14:00'), price: 37.99, seats_available: 30, buy_url: 'x', fetched_at: '', total_price: 78.49, same_station: true, compatible: false, reason: 'espera acima do limite' },
  ],
  collectorStatus: async () => ({
    last_round: { started_at: b('2026-09-28', '07:02'), finished_at: b('2026-09-28', '07:26'), ok: 36, empty: 4, error: 0, blocked: 0 },
    quarantine: location.hash.includes('q=1') ? { until: b(next(D), '19:00'), since: '', reason: 'HTTP 403', from_city: 'Salvador', to_city: 'Catu', travel_date: D } : null,
    open_requests: [{ id: 1, status: 'pending', travel_date: '2026-10-10', created_at: b('2026-09-28', '09:15'), from_city: 'Feira de Santana', to_city: 'Catu' }],
    collected_dates: ['2026-09-29', '2026-09-30', '2026-10-01'],
  }) as never,
  openRequest: async ({ date }) => (date === '2026-10-10' ? { id: 1, origin_city_id: 1, dest_city_id: 2, travel_date: date, status: 'pending', created_at: b('2026-09-28', '09:15'), done_at: null, error: null } : null),
  requestCollect: async () => { throw new Error('demo'); }, getRequest: async () => null, watchRequest: () => () => {},
};
createRoot(document.getElementById('root')!).render(<ApiContext.Provider value={api}><App /></ApiContext.Provider>);
