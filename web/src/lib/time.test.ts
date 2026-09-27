import { addDays, fmtDate, fmtDuration, fmtMoney, fmtStamp, fmtTime, localDate, nextWeekday, today } from './time';

describe('horários em America/Bahia (UTC-3), independentemente do fuso do aparelho', () => {
  it('formata a hora local', () => {
    expect(fmtTime('2026-10-10T17:30:00Z')).toBe('14:30');
    expect(fmtTime('2026-10-10T03:05:00+00:00')).toBe('00:05');
  });
  it('data local vira na meia-noite da Bahia, não de UTC', () => {
    expect(localDate('2026-10-11T02:59:00Z')).toBe('2026-10-10'); // 23:59 do dia 10
    expect(localDate('2026-10-11T03:00:00Z')).toBe('2026-10-11'); // 00:00 do dia 11
    expect(today(new Date('2026-10-11T01:00:00Z'))).toBe('2026-10-10');
  });
  it('fmtStamp mostra só a hora quando é hoje', () => {
    const now = new Date('2026-10-10T15:00:00Z');
    expect(fmtStamp('2026-10-10T10:12:00Z', now)).toBe('07:12');
    expect(fmtStamp('2026-10-09T10:12:00Z', now)).toBe('09/10 07:12');
  });
  it('durações e dinheiro', () => {
    expect(fmtDuration(55)).toBe('55 min');
    expect(fmtDuration(60)).toBe('1h');
    expect(fmtDuration(220)).toBe('3h40');
    expect(fmtMoney(57.43)).toBe('R$ 57,43');
    expect(fmtMoney('100.5')).toBe('R$ 100,50');
    expect(fmtMoney(null)).toBe('—');
  });
  it('atalhos de data', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(nextWeekday('2026-10-07', 5)).toBe('2026-10-09'); // quarta → sexta
    expect(nextWeekday('2026-10-09', 5)).toBe('2026-10-09'); // sexta → hoje
    expect(nextWeekday('2026-10-09', 0)).toBe('2026-10-11'); // sexta → domingo
    expect(fmtDate('2026-10-10')).toBe('sáb, 10/10');
  });
});
