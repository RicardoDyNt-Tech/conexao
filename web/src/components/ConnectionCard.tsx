import { useState } from 'react';
import type { Connection, Offer } from '../lib/types';
import { offersOf, sourceLabel } from '../lib/sources';
import { arrivalDayOffset, durationMinutes, isTight, layoverMinutes } from '../lib/connections';
import { fmtDuration, fmtMoney, fmtTime } from '../lib/time';

interface LegProps {
  n: 1 | 2;
  dep: string; arr: string;
  from: string | null; to: string | null;
  company: string | null; serviceClass: string | null;
  seats: number | null; price: number | null; buyUrl: string | null;
  source?: string | null;
  serviceFee?: number | null;
  offers?: Offer[] | null;
}

function FeeNote({ fee }: { fee: number | null | undefined }) {
  return fee ? <span className="muted"> + {fmtMoney(fee)} de taxa</span> : null;
}

export function LegDetail(p: LegProps) {
  const offers = offersOf(p.offers, {
    source: p.source ?? '', price: p.price, service_fee: p.serviceFee ?? null,
    seats_available: p.seats, service_class: p.serviceClass, buy_url: p.buyUrl,
  });
  const several = offers.length > 1;
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
      {several ? (
        // Mesmo ônibus nas duas fontes: os dois preços, cada um com o seu "Comprar".
        <ul className="offers">
          {offers.map((o) => (
            <li key={`${o.source}-${o.trip_id}`}>
              <span className="badge source">{sourceLabel(o.source)}</span>
              <span className="price">{fmtMoney(o.price)}</span>
              <FeeNote fee={o.service_fee} />
              {o.buy_url && (
                <a className="button small" href={o.buy_url} target="_blank" rel="noopener noreferrer"
                  aria-label={`Comprar ${p.n}º trecho no ${sourceLabel(o.source)}`}>
                  Comprar
                </a>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <>
          <div>
            {offers[0]!.source && <span className="badge source">{sourceLabel(offers[0]!.source)}</span>}
            <FeeNote fee={offers[0]!.service_fee} />
          </div>
          {offers[0]!.buy_url && (
            <a className="button small" href={offers[0]!.buy_url} target="_blank" rel="noopener noreferrer">
              Comprar {p.n}º trecho
            </a>
          )}
        </>
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
            seats={c.leg1_seats} price={c.leg1_price} buyUrl={c.leg1_buy_url}
            source={c.leg1_source} serviceFee={c.leg1_service_fee} offers={c.leg1_offers} />
          {c.kind === 'connection' && c.leg2_departure_at && c.leg2_arrival_at && (
            <>
              <p className={`layover${isTight(c) ? ' warn-text' : ''}`}>
                Espera em {c.via_city}: {fmtDuration(layover ?? 0)}
                {stationChange && ` — atenção: chega em ${c.leg1_dest_station} e sai de ${c.leg2_origin_station}.`}
              </p>
              <LegDetail n={2} dep={c.leg2_departure_at} arr={c.leg2_arrival_at}
                from={c.leg2_origin_station} to={c.leg2_dest_station}
                company={c.leg2_company} serviceClass={c.leg2_service_class}
                seats={c.leg2_seats} price={c.leg2_price} buyUrl={c.leg2_buy_url}
                source={c.leg2_source} serviceFee={c.leg2_service_fee} offers={c.leg2_offers} />
            </>
          )}
        </div>
      )}
    </article>
  );
}
