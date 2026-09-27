import { isStale } from '../lib/connections';
import { fmtStamp } from '../lib/time';

export function DataAge({ asOf }: { asOf: string | null }) {
  if (!asOf) return null;
  const stale = isStale(asOf);
  return (
    <footer className={`data-age${stale ? ' banner warn' : ''}`}>
      Dados de {fmtStamp(asOf)}
      {stale && ' — mais de 12 h atrás; horários e preços podem ter mudado.'}
    </footer>
  );
}
