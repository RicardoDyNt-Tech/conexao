import type { CollectorStatus } from '../lib/types';
import { sourceLabel, sourceStatuses } from '../lib/sources';
import { fmtStamp } from '../lib/time';

/**
 * Aviso de coleta pausada, por fonte. Cada site tem a sua quarentena:
 * "ClickBus pausada até 19:00 (o site bloqueou temporariamente); Quero Passagem ok."
 */
export function QuarantineBanner({ status }: { status: CollectorStatus | null }) {
  const sources = sourceStatuses(status);
  if (!sources.some((s) => s.quarantine)) return null;
  const parts = sources.map((s) => (s.quarantine
    ? `${sourceLabel(s.source)} pausada até ${fmtStamp(s.quarantine.until)} (o site bloqueou temporariamente)`
    : `${sourceLabel(s.source)} ok`));
  const all = sources.every((s) => s.quarantine);
  return (
    <div className="banner warn" role="status">
      {parts.join('; ')}.
      {all ? ' O pedido fica na fila mesmo assim.' : ' Os pedidos são atendidos pelas outras fontes.'}
    </div>
  );
}
