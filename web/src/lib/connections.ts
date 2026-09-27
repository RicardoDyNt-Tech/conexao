import type { Connection, CoverageLeg } from './types';
import { localDate, localDateTime, minutesBetween } from './time';

/** Conexão apertada: menos de 90 min entre a chegada do 1º e a saída do 2º. */
export const TIGHT_LAYOVER_MIN = 90;
/** Folga padrão de find_connections (p_min_layover / p_max_layover), só para os textos. */
export const MIN_LAYOVER_MIN = 20;
export const MAX_LAYOVER_H = 4;
/** Dados mais velhos que isso ganham aviso amarelo. */
export const STALE_HOURS = 12;

export function layoverMinutes(c: Connection): number | null {
  return c.leg2_departure_at ? minutesBetween(c.leg1_arrival_at, c.leg2_departure_at) : null;
}
export function isTight(c: Connection): boolean {
  const l = layoverMinutes(c);
  return l !== null && l < TIGHT_LAYOVER_MIN;
}
export function durationMinutes(c: Connection): number {
  return minutesBetween(c.departure_at, c.arrival_at);
}
/** Quantos dias depois da data da busca chega (0 = mesmo dia). */
export function arrivalDayOffset(c: Connection, searchDate: string): number {
  const a = localDate(c.arrival_at);
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${searchDate}T00:00:00Z`)) / 86_400_000);
}

/**
 * Filtros "sair depois de" / "chegar até" (HH:MM, horário da Bahia, no dia da busca).
 * Seguro aplicar depois do SQL: uma opção que o SQL descartou por ser dominada é pior
 * que outra que continua na lista e passa nos mesmos filtros.
 */
export function applyTimeFilters(list: Connection[], date: string, after?: string, until?: string): Connection[] {
  return list.filter((c) =>
    (!after || localDateTime(c.departure_at) >= `${date} ${after}`) &&
    (!until || localDateTime(c.arrival_at) <= `${date} ${until}`));
}

/** Instante mais antigo dos dados exibidos (cada combinação usa o menor fetched_at dos 2 trechos). */
export function oldestDataAsOf(list: Connection[]): string | null {
  const ts = list.map((c) => c.data_as_of).filter((x): x is string => !!x).sort();
  return ts[0] ?? null;
}
export function isStale(iso: string, now: Date = new Date()): boolean {
  return now.getTime() - Date.parse(iso) > STALE_HOURS * 3600_000;
}

export type EmptyKind = 'not_collected' | 'no_combinations' | 'filtered';

/** Qual estado vazio mostrar: nenhum trecho coletado nessa data × coletado mas sem combinação. */
export function emptyKind(coverage: CoverageLeg[], total: number): EmptyKind {
  if (!coverage.some((l) => l.status === 'ok' || l.status === 'empty')) return 'not_collected';
  return total > 0 ? 'filtered' : 'no_combinations';
}

/** Explicação a partir dos dados: por qual hub faltou ônibus nessa data. */
export function noCombinationReasons(coverage: CoverageLeg[]): string[] {
  const hubs = [...new Set(coverage.filter((l) => l.hub_city).map((l) => l.hub_city!))];
  const out: string[] = [];
  for (const hub of hubs) {
    const legs = coverage.filter((l) => l.hub_city === hub);
    const none = legs.filter((l) => l.status && (l.trips_found ?? 0) === 0);
    const missing = legs.filter((l) => !l.status);
    if (none.length) out.push(`Via ${hub}: sem ônibus ${none.map((l) => `${l.from_city} → ${l.to_city}`).join(' e ')} nesse dia.`);
    else if (missing.length) out.push(`Via ${hub}: trecho ${missing.map((l) => `${l.from_city} → ${l.to_city}`).join(' e ')} ainda não coletado.`);
    else out.push(`Via ${hub}: há ônibus nos dois trechos, mas os horários não se encaixam (espera de ${MIN_LAYOVER_MIN} min a ${MAX_LAYOVER_H} h).`);
  }
  return out;
}
