import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseClickbusTrips, type CbTripsResponse } from '../src/sources/clickbus.js';

const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  '../../test/fixtures/trips-salvador-ba_catu-ba_2026-10-04.json');
const json = JSON.parse(fs.readFileSync(fixture, 'utf8')) as CbTripsResponse;
const query = { from: 'salvador-ba', to: 'catu-ba', date: '2026-10-04' };

describe('parseClickbusTrips (fixture Salvador → Catu, 04/10/2026)', () => {
  const { trips, warnings, redirected } = parseClickbusTrips(json, query);

  it('devolve as 18 viagens sem avisos', () => {
    expect(trips).toHaveLength(18);
    expect(warnings).toEqual([]);
    expect(redirected).toBe(false);
  });

  it('usa parts[0].tripId como chave e ids únicos', () => {
    expect(trips[0]!.source_trip_id).toBe('50114996-6fe0-3cc6-b536-35b0d735c85d');
    expect(new Set(trips.map((t) => t.source_trip_id)).size).toBe(18);
  });

  it('converte horários de America/Bahia (UTC-3) para UTC', () => {
    const t = trips[0]!;
    expect(t.departure_at).toBe('2026-10-04T09:00:00.000Z'); // 06:00 local
    expect(t.arrival_at).toBe('2026-10-04T11:00:00.000Z'); // 08:00 local
    expect(t.travel_date).toBe('2026-10-04');
  });

  it('a das 23:00 chega em 2026-10-05 00:20 (dia seguinte)', () => {
    const late = trips.find((t) => t.source_trip_id === 'cfb4e768-d3a6-3745-b3d9-6e1b2ed3f1ed')!;
    expect(late.departure_at).toBe('2026-10-05T02:00:00.000Z'); // 04/10 23:00 local
    expect(late.arrival_at).toBe('2026-10-05T03:20:00.000Z'); // 05/10 00:20 local
    expect(late.travel_date).toBe('2026-10-04');
    expect(Date.parse(late.arrival_at) - Date.parse(late.departure_at)).toBe(80 * 60_000);
  });

  it('chegada sempre depois da saída', () => {
    for (const t of trips) expect(Date.parse(t.arrival_at)).toBeGreaterThan(Date.parse(t.departure_at));
  });

  it('preços, assentos, viação, classe e rodoviárias corretos', () => {
    expect(trips[0]).toMatchObject({
      source: 'clickbus', price: 33.99, original_price: 37.9,
      seats_available: 38, seats_total: 42, is_low_fare: true,
      company: 'Cidade Sol', company_slug: 'cidade-sol', service_class: 'Convencional',
      origin_station: 'Novo Terminal Rodoviário de Salvador', origin_station_id: 3874,
      dest_station: 'Catu, BA', dest_station_id: 4680, parts_count: 1,
      buy_url: 'https://www.clickbus.com.br/onibus/salvador-ba/catu-ba?departureDate=2026-10-04',
    });
    expect(trips[2]).toMatchObject({
      price: 45.8, seats_available: 41, seats_total: 42, is_low_fare: false,
      company_slug: 'rota-transportes', service_class: 'Executivo',
    });
    expect(Math.min(...trips.map((t) => t.price))).toBe(26.99);
    expect(Math.max(...trips.map((t) => t.price))).toBe(45.8);
    expect(trips.filter((t) => t.company_slug === 'cidade-sol')).toHaveLength(16);
    expect(trips.filter((t) => t.company_slug === 'rota-transportes')).toHaveLength(2);
  });
});

describe('parseClickbusTrips (casos de borda)', () => {
  it('conexão vendida pronta: saída do 1º trecho, chegada do último, menor nº de assentos', () => {
    const [a, b] = json.trips!.slice(0, 2).map((t) => t.parts[0]!);
    const multi: CbTripsResponse = {
      trips: [{ type: 'connection', price: 70, parts: [
        { ...a!, availableSeats: 10 },
        { ...b!, departure: { ...b!.departure, date: '2026-10-04', time: '22:00:00' },
          arrival: { ...b!.arrival, date: '2026-10-05', time: '01:10:00' }, availableSeats: 3 },
      ] }],
    };
    const [t] = parseClickbusTrips(multi, query).trips;
    expect(t).toMatchObject({ parts_count: 2, seats_available: 3, departure_at: '2026-10-04T09:00:00.000Z',
      arrival_at: '2026-10-05T04:10:00.000Z', source_trip_id: a!.tripId });
  });

  it('resultado redirecionado (isRedirectResult) vira vazio', () => {
    const r = parseClickbusTrips({ ...json, isRedirectResult: true }, query);
    expect(r).toMatchObject({ trips: [], redirected: true });
  });

  it('lista vazia → nenhuma viagem', () => {
    expect(parseClickbusTrips({ trips: [] }, query).trips).toEqual([]);
  });

  it('viagem malformada é ignorada com aviso, sem derrubar as outras', () => {
    const r = parseClickbusTrips({ trips: [{ price: 10, parts: [] }, json.trips![0]!] }, query);
    expect(r.trips).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/trips\[0\]/);
  });

  it('formato inesperado lança erro', () => {
    expect(() => parseClickbusTrips({} as CbTripsResponse, query)).toThrow(/trips/);
  });
});

describe('parseClickbusTrips (sem viagens na data: ClickBus devolve a próxima data)', () => {
  // Pedido 27/09; a resposta traz a viagem de 29/09 (alternativeDate).
  const alt = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fixture),
    'trips-feira-de-santana-todos_alagoinhas-ba_2026-09-27.json'), 'utf8')) as CbTripsResponse;
  const q = { from: 'feira-de-santana-todos', to: 'alagoinhas-ba', date: '2026-09-27' };
  const r = parseClickbusTrips(alt, q);

  it('mantém as viagens (válidas para a data delas), mas nenhuma conta para a data pedida', () => {
    expect(r.trips.length).toBeGreaterThan(0);
    expect(r.trips.every((t) => t.travel_date !== q.date)).toBe(true);
    expect(r.onDate).toBe(0);
    expect(r.nextDate).toBe('2026-09-29');
  });

  it('mistura de datas: conta só as da data pedida', () => {
    const mixed = { trips: [...json.trips!.slice(0, 2), ...alt.trips!] };
    const m = parseClickbusTrips(mixed, query);
    expect(m).toMatchObject({ onDate: 2, nextDate: null });
    expect(m.trips).toHaveLength(3);
  });

  it('usa alternativeDate quando não vem viagem nenhuma', () => {
    expect(parseClickbusTrips({ trips: [], alternativeDate: '2026-09-29T00:00:00' }, q).nextDate).toBe('2026-09-29');
    expect(parseClickbusTrips({ trips: [], alternativeDate: null }, q).nextDate).toBeNull();
  });
});
