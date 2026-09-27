import { describe, expect, it } from 'vitest';
import { deriveLegs, legsForRequest } from '../src/store.js';

describe('deriveLegs', () => {
  // Mesmos dados do supabase/seed.sql (ids IBGE).
  const F = 2910800, A = 2900702, S = 2927408, C = 2907509;
  const slugs = new Map([[F, 'feira'], [A, 'alagoinhas'], [S, 'salvador'], [C, 'catu']]);
  const hubs = [
    { origin_city_id: F, dest_city_id: C, hub_city_id: A },
    { origin_city_id: F, dest_city_id: C, hub_city_id: S },
    { origin_city_id: C, dest_city_id: F, hub_city_id: A },
    { origin_city_id: C, dest_city_id: F, hub_city_id: S },
  ];

  it('gera os 8 trechos da Etapa 1', () => {
    const { legs, warnings } = deriveLegs(hubs, slugs, 'clickbus');
    expect(warnings).toEqual([]);
    expect(legs.map((l) => `${l.from}>${l.to}`)).toEqual([
      'feira>alagoinhas', 'alagoinhas>catu', 'feira>salvador', 'salvador>catu',
      'catu>alagoinhas', 'alagoinhas>feira', 'catu>salvador', 'salvador>feira',
    ]);
  });

  it('não repete trechos compartilhados e avisa slug ausente', () => {
    const { legs, warnings } = deriveLegs([hubs[0]!, hubs[0]!, { origin_city_id: F, dest_city_id: C, hub_city_id: 999 }],
      slugs, 'clickbus');
    expect(legs).toHaveLength(2);
    expect(warnings).toEqual(['sem slug clickbus para a cidade 999', 'sem slug clickbus para a cidade 999']);
  });
});

describe('legsForRequest (atualizar agora)', () => {
  const F = 2910800, A = 2900702, S = 2927408, C = 2907509;
  const slugs = new Map([[F, 'feira'], [A, 'alagoinhas'], [S, 'salvador'], [C, 'catu']]);
  const hubs = [
    { origin_city_id: F, dest_city_id: C, hub_city_id: A },
    { origin_city_id: F, dest_city_id: C, hub_city_id: S },
    { origin_city_id: C, dest_city_id: F, hub_city_id: A },
    { origin_city_id: C, dest_city_id: F, hub_city_id: S },
  ];
  const req = { id: 1, origin_city_id: F, dest_city_id: C, travel_date: '2026-10-05' };

  it('direta + os 2 trechos de cada hub do par, na data pedida', () => {
    const { legs, warnings } = legsForRequest(req, hubs, slugs, 'clickbus');
    expect(warnings).toEqual([]);
    expect(legs).toEqual([
      { from: 'feira', to: 'catu', date: '2026-10-05' },
      { from: 'feira', to: 'alagoinhas', date: '2026-10-05' },
      { from: 'alagoinhas', to: 'catu', date: '2026-10-05' },
      { from: 'feira', to: 'salvador', date: '2026-10-05' },
      { from: 'salvador', to: 'catu', date: '2026-10-05' },
    ]);
  });

  it('só os hubs do sentido pedido', () => {
    const { legs } = legsForRequest({ ...req, origin_city_id: C, dest_city_id: F }, hubs, slugs, 'clickbus');
    expect(legs.map((l) => `${l.from}>${l.to}`)).toEqual(
      ['catu>feira', 'catu>alagoinhas', 'alagoinhas>feira', 'catu>salvador', 'salvador>feira']);
  });

  it('par sem hubs cadastrados → só a direta', () => {
    const { legs } = legsForRequest({ ...req, origin_city_id: S, dest_city_id: C }, hubs, slugs, 'clickbus');
    expect(legs).toEqual([{ from: 'salvador', to: 'catu', date: '2026-10-05' }]);
  });

  it('cidade sem slug é pulada com aviso', () => {
    const partial = new Map([[F, 'feira'], [S, 'salvador'], [C, 'catu']]);
    const { legs, warnings } = legsForRequest(req, hubs, partial, 'clickbus');
    expect(legs.map((l) => `${l.from}>${l.to}`)).toEqual(['feira>catu', 'feira>salvador', 'salvador>catu']);
    expect(warnings).toEqual([`sem slug clickbus para a cidade ${A}`, `sem slug clickbus para a cidade ${A}`]);
  });
});
