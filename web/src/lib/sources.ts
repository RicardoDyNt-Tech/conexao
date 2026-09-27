import type { CollectorStatus, Offer, SourceStatus } from './types';

const LABELS: Record<string, string> = { clickbus: 'ClickBus', queropassagem: 'Quero Passagem' };
export const sourceLabel = (s: string | null | undefined): string => (s ? LABELS[s] ?? s : '');

/** Ofertas de um trecho; sem a lista (dados antigos), monta uma a partir do próprio trecho. */
export function offersOf(offers: Offer[] | null | undefined, fallback: Omit<Offer, 'trip_id' | 'fetched_at'>): Offer[] {
  if (offers?.length) return offers;
  return [{ ...fallback, trip_id: 0, fetched_at: '' }];
}

/** Status por fonte; se o banco ainda não tiver o campo sources, cai no formato antigo. */
export function sourceStatuses(s: CollectorStatus | null): SourceStatus[] {
  if (!s) return [];
  if (s.sources?.length) return s.sources;
  return s.quarantine ? [{ source: s.quarantine.source ?? 'clickbus', quarantine: s.quarantine, last_round: s.last_round }] : [];
}
