import { applyTimeFilters, emptyKind, isStale, isTight, noCombinationReasons } from './connections';
import { conn, coverage } from '../test/fakeApi';

const D = '2026-10-10';

describe('regras das combinações', () => {
  it('conexão apertada: menos de 90 min de espera', () => {
    expect(isTight(conn({ date: D, dep: '06:00', arr1: '07:30', dep2: '08:59', arr: '10:00' }))).toBe(true);  // 89 min
    expect(isTight(conn({ date: D, dep: '06:00', arr1: '07:30', dep2: '09:00', arr: '10:00' }))).toBe(false); // 90 min
    expect(isTight(conn({ date: D, dep: '06:00', arr1: '09:00', arr: '09:00' }))).toBe(false);                // direta
  });

  it('filtros de horário no dia da busca; chegada no dia seguinte não passa em "chegar até"', () => {
    const a = conn({ date: D, dep: '06:00', arr1: '07:30', dep2: '09:00', arr: '10:00' });
    const b = conn({ date: D, dep: '20:00', arr1: '21:30', dep2: '23:00', arr: '00:20', arrDate: '2026-10-11' });
    expect(applyTimeFilters([a, b], D, '07:00')).toEqual([b]);
    expect(applyTimeFilters([a, b], D, undefined, '23:59')).toEqual([a]);
    expect(applyTimeFilters([a, b], D)).toEqual([a, b]);
  });

  it('dados velhos: mais de 12 h', () => {
    const now = new Date('2026-10-10T20:00:00Z');
    expect(isStale('2026-10-10T07:59:00Z', now)).toBe(true);
    expect(isStale('2026-10-10T08:01:00Z', now)).toBe(false);
  });

  it('estados vazios: nada coletado × coletado sem combinação × filtrado', () => {
    const none = coverage(D, [[null, 'Feira de Santana', 'Catu', null], ['Salvador', 'Feira de Santana', 'Salvador', null]]);
    const some = coverage(D, [['Alagoinhas', 'Feira de Santana', 'Alagoinhas', 'empty', 0], ['Alagoinhas', 'Alagoinhas', 'Catu', 'ok', 10]]);
    expect(emptyKind(none, 0)).toBe('not_collected');
    expect(emptyKind(some, 0)).toBe('no_combinations');
    expect(emptyKind(some, 3)).toBe('filtered');
  });

  it('explica por qual hub faltou ônibus, a partir dos dados', () => {
    const cov = coverage(D, [
      [null, 'Feira de Santana', 'Catu', null],
      ['Alagoinhas', 'Feira de Santana', 'Alagoinhas', 'empty', 0],
      ['Alagoinhas', 'Alagoinhas', 'Catu', 'ok', 12],
      ['Salvador', 'Feira de Santana', 'Salvador', 'ok', 40],
      ['Salvador', 'Salvador', 'Catu', 'ok', 18],
    ]);
    expect(noCombinationReasons(cov)).toEqual([
      'Via Alagoinhas: sem ônibus Feira de Santana → Alagoinhas nesse dia.',
      'Via Salvador: há ônibus nos dois trechos, mas os horários não se encaixam (espera de 20 min a 4 h).',
    ]);
  });
});
