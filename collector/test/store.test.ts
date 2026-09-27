import { describe, expect, it } from 'vitest';
import { deriveLegs } from '../src/store.js';

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
