import type { Quarantine } from '../lib/types';
import { fmtStamp } from '../lib/time';

export function QuarantineBanner({ q }: { q: Quarantine | null }) {
  if (!q) return null;
  return (
    <div className="banner warn" role="status">
      Coletor pausado até {fmtStamp(q.until)} (o site bloqueou temporariamente).
      {' '}O pedido fica na fila mesmo assim.
    </div>
  );
}
