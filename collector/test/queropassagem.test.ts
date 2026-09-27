import { describe, expect, it } from 'vitest';
import { isSearchUrl, qpSearchUrl, redactTokens, redactUrl, summarizeSearchBody } from '../src/sources/queropassagem.js';

describe('Quero Passagem: utilitários do spike', () => {
  it('monta a URL pública com a data em DD-MM-AAAA', () => {
    expect(qpSearchUrl('salvador-ba', 'catu', '2026-10-10'))
      .toBe('https://www.queropassagem.com.br/onibus/salvador-ba-para-catu?ida=10-10-2026');
  });

  it('reconhece as respostas de busca', () => {
    expect(isSearchUrl('https://www.queropassagem.com.br/search/aaa.bbb.ccc')).toBe(true);
    expect(isSearchUrl('https://www.queropassagem.com.br/search-connections/tok/18')).toBe(true);
    expect(isSearchUrl('https://www.queropassagem.com.br/onibus/a-para-b?ida=10-10-2026')).toBe(false);
    expect(isSearchUrl('lixo')).toBe(false);
  });

  it('oculta o JWT e guarda só as claims do payload', () => {
    const payload = Buffer.from(JSON.stringify({ gds: 7, from: 73, to: 1705, date: '2026-10-10' })).toString('base64url');
    const jwt = `eyJhbGciOiJIUzI1NiJ9.${payload}.c2lnbmF0dXJlLWZha2UtMTIz`;
    const r = redactUrl(`https://www.queropassagem.com.br/search/${jwt}`);
    expect(r.url).toBe('https://www.queropassagem.com.br/search/<jwt>');
    expect(r.url).not.toContain('signature');
    expect(r.claims).toEqual([{ gds: 7, from: 73, to: 1705, date: '2026-10-10' }]);
  });

  it('oculta JWT embrulhado em base64 (URL de /search-connections/ e campo "tag")', () => {
    const payload = Buffer.from(JSON.stringify({ from: '73', to: '1720', gds: 1 })).toString('base64url');
    const wrapped = Buffer.from(`eyJhbGciOiJIUzI1NiJ9.${payload}.QXNtV29kbzM4Z3ZsdS1uM21vblFM`).toString('base64');
    const r = redactUrl(`https://queropassagem.com.br/search-connections/${wrapped}/18`);
    expect(r.url).toBe('https://queropassagem.com.br/search-connections/<jwt>/18');
    expect(r.claims).toEqual([{ from: '73', to: '1720', gds: 1 }]);

    const item = { id: '1721e81f9d2e61313d1895b430e8cce7', tag: wrapped, company: { name: 'Cidade Sol' } };
    expect(redactTokens(item)).toEqual({ id: '1721e81f9d2e61313d1895b430e8cce7', tag: '<jwt>', company: { name: 'Cidade Sol' } });
  });

  it('não mexe em base64 que não é token (ex.: ids em hex, textos)', () => {
    expect(redactUrl('https://assets.queropassagem.com.br/public/Upload/autoviacao/viacao-cidade-sol.svg').url)
      .toBe('https://assets.queropassagem.com.br/public/Upload/autoviacao/viacao-cidade-sol.svg');
    expect(redactTokens({ id: '77a600ed33033f35807ac1b33c74bded77a600ed' })).toEqual({ id: '77a600ed33033f35807ac1b33c74bded77a600ed' });
  });

  it('resume respostas de busca', () => {
    expect(summarizeSearchBody({ source: 'x', itens: [{}, {}] })).toEqual({ items: 2, source: 'x' });
    expect(summarizeSearchBody([{}, {}, {}])).toEqual({ items: 3, source: null });
    expect(summarizeSearchBody('texto')).toEqual({ items: null, source: null });
  });
});

// ---------------------------------------------------------------------------
// Parser, com as respostas reais do spike (10/10/2026), sem tokens.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeClass, parseQpSearch, slugify } from '../src/sources/queropassagem.js';

const FX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../test/fixtures/qp');
const load = (leg: string) => JSON.parse(fs.readFileSync(path.join(FX, `search-${leg}_2026-10-10.json`), 'utf8')) as unknown[];
const D = '2026-10-10';

describe('parseQpSearch (fixtures reais)', () => {
  it('Salvador → Catu: 24 viagens, horários da Bahia em UTC, preço de vitrine e taxa à parte', () => {
    const r = parseQpSearch(load('salvador-ba_catu'), { from: 'salvador-ba', to: 'catu', date: D });
    expect(r.trips).toHaveLength(24);
    expect(r).toMatchObject({ onDate: 24, nextDate: null, responses: 8, duplicates: 0, warnings: [] });
    expect(r.trips[0]).toMatchObject({
      source: 'queropassagem', source_trip_id: '1721e81f9d2e61313d1895b430e8cce7',
      company: 'Cidade Sol', company_slug: 'cidade-sol', service_class: 'Convencional',
      origin_station: 'Salvador, BA - Rodoviária', dest_station: 'Catu, BA',
      origin_station_id: null, dest_station_id: null,
      departure_at: '2026-10-10T08:00:00.000Z', arrival_at: '2026-10-10T10:00:00.000Z', // 05:00 → 07:00
      travel_date: D, price: 37.9, service_fee: 11.37, seats_available: 36, parts_count: 1,
      buy_url: 'https://www.queropassagem.com.br/onibus/salvador-ba-para-catu?ida=10-10-2026',
    });
    expect(r.trips.filter((t) => t.company_slug === 'rota-transportes')).toHaveLength(2);
    expect(new Set(r.trips.map((t) => t.service_class))).toEqual(new Set(['Convencional', 'Executivo']));
  });

  it('Feira → Salvador: o mesmo ônibus vindo de 2 GDS (e repetido) vira 1 viagem', () => {
    const r = parseQpSearch(load('feira-de-santana-ba_salvador-ba'), { from: 'feira-de-santana-ba', to: 'salvador-ba', date: D });
    expect(r.trips).toHaveLength(23);
    expect(r.duplicates).toBe(4);
    const rota1920 = r.trips.filter((t) => t.company_slug === 'rota-transportes' && t.departure_at === '2026-10-10T22:20:00.000Z');
    expect(rota1920).toHaveLength(1);
    expect(rota1920[0]).toMatchObject({ service_class: 'Semileito', price: 54.7, seats_available: 1 });
    // maxPrice maior que o preço vira original_price
    expect(r.trips.find((t) => t.original_price !== null)).toMatchObject({ price: 37.29, original_price: 52.6 });
  });

  it('Alagoinhas → Catu: 16 viagens, taxa mínima de R$ 5', () => {
    const r = parseQpSearch(load('alagoinhas_catu'), { from: 'alagoinhas', to: 'catu', date: D });
    expect(r.trips).toHaveLength(16);
    expect(r.trips[0]).toMatchObject({ price: 13.05, service_fee: 5, origin_station: 'Alagoinhas, BA' });
  });

  it('nenhum token passa para as viagens', () => {
    const all = ['salvador-ba_catu', 'feira-de-santana-ba_salvador-ba', 'alagoinhas_catu']
      .flatMap((l) => parseQpSearch(load(l), { from: 'x', to: 'y', date: D }).trips);
    expect(JSON.stringify(all)).not.toMatch(/eyJ|ZXlK|jwt/);
  });
});

describe('parseQpSearch (casos de borda)', () => {
  const item = (o: Record<string, unknown> = {}) => ({
    id: 'abc', company: { name: 'Cidade Sol' }, from: 'Salvador, BA - Rodoviária', to: 'Catu, BA',
    departure: `${D} 23:00:00`, arrival: '2026-10-11 00:20:00', seatClass: 'EXECUTIVO ', price: 45.8,
    maxPrice: null, tax: 13.74, availableSeats: 40, connectionTag: false, ...o,
  });
  const q = { from: 'salvador-ba', to: 'catu', date: D };

  it('chega no dia seguinte: cada ponta com a própria data', () => {
    const [t] = parseQpSearch([{ source: 1, itens: [item()] }], q).trips;
    expect(t).toMatchObject({ travel_date: D, departure_at: '2026-10-11T02:00:00.000Z', arrival_at: '2026-10-11T03:20:00.000Z' });
  });

  it('conexão vendida pelo QP: parts_count 2 (fora do cruzamento)', () => {
    const [t] = parseQpSearch([[item({ connectionTag: true })]], q).trips;
    expect(t!.parts_count).toBe(2);
  });

  it('sem id: hash estável de viação + saída + chegada + origem + destino', () => {
    const a = parseQpSearch([{ itens: [item({ id: undefined })] }], q).trips[0]!;
    const b = parseQpSearch([{ itens: [item({ id: undefined, price: 99 })] }], q).trips[0]!;
    const c = parseQpSearch([{ itens: [item({ id: undefined, departure: `${D} 22:00:00` })] }], q).trips[0]!;
    expect(a.source_trip_id).toMatch(/^h-[0-9a-f]{32}$/);
    expect(b.source_trip_id).toBe(a.source_trip_id);   // preço não entra no hash
    expect(c.source_trip_id).not.toBe(a.source_trip_id);
  });

  it('duplicado com preços diferentes: fica o menor', () => {
    const r = parseQpSearch([{ itens: [item({ price: 50 })] }, { itens: [item({ price: 45 })] }], q);
    expect(r.trips).toHaveLength(1);
    expect(r.trips[0]!.price).toBe(45);
  });

  it('só viagens de outra data: nenhuma conta, próxima data informada', () => {
    const r = parseQpSearch([{ itens: [item({ departure: '2026-10-12 06:00:00', arrival: '2026-10-12 07:30:00' })] }], q);
    expect(r).toMatchObject({ onDate: 0, nextDate: '2026-10-12' });
  });

  it('respostas vazias e itens malformados', () => {
    const r = parseQpSearch([{ source: 9, itens: [] }, [], 'lixo', { itens: [item({ price: undefined })] }], q);
    expect(r.trips).toEqual([]);
    expect(r.warnings).toEqual(['resposta 3 item 0 ignorado: sem price']);
  });

  it('normalizações', () => {
    expect(slugify('Viação Águia Branca')).toBe('viacao-aguia-branca');
    expect(normalizeClass('LEITO CAMA ')).toBe('Leito Cama');
  });
});
