import { describe, expect, it } from 'vitest';
import { addDays, defaultStartDate, nextMonday, todayIn, zonedToUtcIso } from '../src/time.js';

describe('time', () => {
  it('zonedToUtcIso em America/Bahia (sem horário de verão)', () => {
    expect(zonedToUtcIso('2026-01-15', '12:00:00')).toBe('2026-01-15T15:00:00.000Z');
    expect(zonedToUtcIso('2026-12-31', '23:30')).toBe('2027-01-01T02:30:00.000Z');
  });
  it('respeita horário de verão em outro fuso', () => {
    expect(zonedToUtcIso('2026-07-01', '12:00:00', 'America/New_York')).toBe('2026-07-01T16:00:00.000Z');
    expect(zonedToUtcIso('2026-01-01', '12:00:00', 'America/New_York')).toBe('2026-01-01T17:00:00.000Z');
  });
  it('rejeita formato inválido', () => {
    expect(() => zonedToUtcIso('04/10/2026', '06:00')).toThrow();
  });
  it('datas auxiliares', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(nextMonday('2026-09-27')).toBe('2026-09-28'); // domingo → segunda
    expect(nextMonday('2026-09-28')).toBe('2026-10-05'); // segunda → próxima segunda
    expect(todayIn('America/Bahia', new Date('2026-09-28T02:00:00Z'))).toBe('2026-09-27');
  });
});

describe('defaultStartDate', () => {
  it('antes das 20:00 (Bahia) começa hoje; a partir das 20:00, amanhã', () => {
    expect(defaultStartDate(new Date('2026-09-27T22:59:00Z'))).toBe('2026-09-27'); // 19:59 local
    expect(defaultStartDate(new Date('2026-09-27T23:00:00Z'))).toBe('2026-09-28'); // 20:00 local
    expect(defaultStartDate(new Date('2026-09-28T02:30:00Z'))).toBe('2026-09-28'); // 23:30 do dia 27 local
    expect(defaultStartDate(new Date('2026-09-28T03:00:00Z'))).toBe('2026-09-28'); // 00:00 do dia 28
  });
});
