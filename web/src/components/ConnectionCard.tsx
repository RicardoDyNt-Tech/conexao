import { useState } from 'react';
import type { Connection } from '../lib/types';
import { arrivalDayOffset, durationMinutes, isTight, layoverMinutes } from '../lib/connections';
import { fmtDuration, fmtMoney, fmtTime } from '../lib/time';

interface LegProps {
  n: 1 | 2;
  dep: string; arr: string;
  from: string | null; to: string | null;
  company: string | null; serviceClass: string | null;
  seats: number | null; price: number | null; buyUrl: string | null;
}

export function LegDetail(p: LegProps) {
  return (
    <div className="leg">
      <div className="leg-head">
        <strong>{p.n}º ônibus · {fmtTime(p.dep)} → {fmtTime(p.arr)}</strong>
        <span className="price">{fmtMoney(p.price)}</span>
      </div>
      <div className="muted">{p.from ?? '?'} → {p.to ?? '?'}</div>
      <div className="muted">
        {[p.company, p.serviceClass, p.seats !== null ? `${p.seats} lugares` : null].filter(Boolean).join(' · ')}
      </div>
      {p.buyUrl && (
        <a className="button small" href={p.buyUrl} target="_blank" rel="noopener noreferrer">
          Comprar {p.n}º trecho
        </a>
      )}
    </div>
  );
}

export function ConnectionCard({ c, date }: { c: Connection; date: string }) {
  const [open, setOpen] = useState(false);
  const layover = layoverMinutes(c);
  const plusDays = arrivalDayOffset(c, date);
  const stationChange = c.kind === 'connection' && c.same_station === false;

  return (
    <article className={`card${open ? ' open' : ''}`}>
      <button className="card-summary" aria-expanded={open} onClick={() => setOpen(!open)}>
        <div className="row">
          <span className="times">
            {fmtTime(c.departure_at)} → {fmtTime(c.arrival_at)}
            {plusDays > 0 && <sup title="chega no dia seguinte"> +{plusDays}</sup>}
          </span>
          <span className="price total">{fmtMoney(c.total_price)}</span>
        </div>
        <div className="muted">
          {fmtDuration(durationMinutes(c))}
          {' · '}
          {c.kind === 'direct' ? 'direto' : `via ${c.via_city}`}
          {layover !== null && ` · espera ${fmtDuration(layover)}`}
        </div>
        {(isTight(c) || stationChange) && (
          <div className="badges">
            {isTight(c) && <span className="badge warn">Conexão apertada</span>}
            {stationChange && <span className="badge info">Troca de rodoviária</span>}
          </div>
        )}
      </button>

      {open && (
        <div className="card-body">
          <LegDetail n={1} dep={c.leg1_departure_at} arr={c.leg1_arrival_at}
            from={c.leg1_origin_station} to={c.leg1_dest_station}
            company={c.leg1_company} serviceClass={c.leg1_service_class}
            seats={c.leg1_seats} price={c.leg1_price} buyUrl={c.leg1_buy_url} />
          {c.kind === 'connection' && c.leg2_departure_at && c.leg2_arrival_at && (
            <>
              <p className={`layover${isTight(c) ? ' warn-text' : ''}`}>
                Espera em {c.via_city}: {fmtDuration(layover ?? 0)}
                {stationChange && ` — atenção: chega em ${c.leg1_dest_station} e sai de ${c.leg2_origin_station}.`}
              </p>
              <LegDetail n={2} dep={c.leg2_departure_at} arr={c.leg2_arrival_at}
                from={c.leg2_origin_station} to={c.leg2_dest_station}
                company={c.leg2_company} serviceClass={c.leg2_service_class}
                seats={c.leg2_seats} price={c.leg2_price} buyUrl={c.leg2_buy_url} />
            </>
          )}
        </div>
      )}
    </article>
  );
}
