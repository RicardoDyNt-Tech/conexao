import { useCallback, useEffect, useState } from 'react';
import { useApi } from '../lib/api';
import type { CollectorStatus, Route, SecondLeg, Trip } from '../lib/types';
import { fmtDuration, fmtMoney, fmtTime, localDate, minutesBetween } from '../lib/time';
import { LegDetail } from '../components/ConnectionCard';
import { sourceLabel } from '../lib/sources';
import { QuarantineBanner } from '../components/QuarantineBanner';
import { RefreshPanel } from '../components/RefreshPanel';
import { SearchHeader } from './SearchHeader';

/** Modo "monte você mesmo": escolhe o 1º ônibus e vê os 2º compatíveis (find_second_legs). */
export function BuildYourOwn({ route, params }: { route: Route; params: URLSearchParams }) {
  const api = useApi();
  const date = params.get('date')!;
  const origin = route.origin.id, dest = route.dest.id;
  const hubName = new Map(route.hubs.map((h) => [h.id, h.name]));

  const [firsts, setFirsts] = useState<Trip[] | null>(null);
  const [status, setStatus] = useState<CollectorStatus | null>(null);
  const [first, setFirst] = useState<Trip | null>(null);
  const [seconds, setSeconds] = useState<SecondLeg[] | null>(null);
  const [second, setSecond] = useState<SecondLeg | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    setFirst(null); setSecond(null); setSeconds(null);
    Promise.all([
      api.firstLegs({ origin, hubIds: route.hubs.map((h) => h.id), date }),
      api.collectorStatus().catch(() => null),
    ]).then(([f, s]) => { if (alive) { setFirsts(f); setStatus(s); } })
      .catch((e) => alive && setErr((e as Error).message));
    return () => { alive = false; };
  }, [api, origin, date, route, reload]);

  useEffect(() => {
    if (!first) return;
    let alive = true;
    setSeconds(null); setSecond(null);
    api.secondLegs({ firstTripId: first.id, dest }).then((s) => alive && setSeconds(s))
      .catch((e) => alive && setErr((e as Error).message));
    return () => { alive = false; };
  }, [api, first, dest]);

  const onFinished = useCallback(() => setReload((n) => n + 1), []);
  const plus = (iso: string) => (localDate(iso) > date ? ` (+${Math.round((Date.parse(localDate(iso)) - Date.parse(date)) / 86_400_000)})` : '');

  return (
    <main className="screen">
      <SearchHeader route={route} params={params} tab="m" />
      <QuarantineBanner status={status} />
      {err && <p className="error">{err}</p>}

      <h2>1. Escolha o 1º ônibus</h2>
      {!firsts && !err && <p className="muted">Carregando…</p>}
      {firsts?.length === 0 && (
        <>
          <p className="muted">Nenhum 1º ônibus coletado para esse dia.</p>
          <RefreshPanel origin={origin} dest={dest} date={date} onFinished={onFinished} label="Buscar essa data" />
        </>
      )}
      <ul className="pick-list">
        {firsts?.map((t) => (
          <li key={t.id}>
            <button aria-pressed={first?.id === t.id} onClick={() => setFirst(first?.id === t.id ? null : t)}>
              <span className="times">{fmtTime(t.departure_at)} → {fmtTime(t.arrival_at)}</span>
              <span>{route.origin.name} → {hubName.get(t.dest_city_id)}</span>
              <span className="muted">{t.company} · {(t.offers?.length ? t.offers : [{ source: t.source }]).map((o) => sourceLabel(o.source)).join(' + ')}</span>
              <span className="price">{fmtMoney(t.price)}</span>
            </button>
          </li>
        ))}
      </ul>

      {first && (
        <>
          <h2>2. Escolha o 2º ônibus ({hubName.get(first.dest_city_id)} → {route.dest.name})</h2>
          {!seconds && <p className="muted">Carregando…</p>}
          {seconds?.length === 0 && <p className="muted">Nenhum ônibus coletado de {hubName.get(first.dest_city_id)} para {route.dest.name} nesse dia ou no seguinte.</p>}
          <ul className="pick-list">
            {seconds?.map((s) => (
              <li key={s.trip_id} className={s.compatible ? '' : 'faded'}>
                <button disabled={!s.compatible} aria-pressed={second?.trip_id === s.trip_id}
                  onClick={() => setSecond(second?.trip_id === s.trip_id ? null : s)}>
                  <span className="times">{fmtTime(s.departure_at)}{localDate(s.departure_at) > date ? ' (dia seguinte)' : ''}</span>
                  {s.compatible ? (
                    <span>chega em {route.dest.name} às {fmtTime(s.arrival_at)}{plus(s.arrival_at)} · espera {fmtDuration(minutesBetween(first.arrival_at, s.departure_at))}</span>
                  ) : (
                    <span className="reason">{s.reason}</span>
                  )}
                  <span className="muted">{s.company} · {(s.offers?.length ? s.offers : [{ source: s.source }]).map((o) => sourceLabel(o.source)).join(' + ')}{s.same_station === false ? ' · outra rodoviária' : ''}</span>
                  <span className="price">{fmtMoney(s.price)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {first && second && (
        <section className="summary">
          <h2>Sua combinação: {fmtMoney(Number(first.price ?? 0) + Number(second.price ?? 0))}</h2>
          <p className="muted">
            Sai {fmtTime(first.departure_at)}, chega {fmtTime(second.arrival_at)}{plus(second.arrival_at)} ·
            {' '}{fmtDuration(minutesBetween(first.departure_at, second.arrival_at))}
          </p>
          <LegDetail n={1} dep={first.departure_at} arr={first.arrival_at} from={first.origin_station} to={first.dest_station}
            company={first.company} serviceClass={first.service_class} seats={first.seats_available}
            price={first.price} buyUrl={first.buy_url} source={first.source} serviceFee={first.service_fee} offers={first.offers} />
          <LegDetail n={2} dep={second.departure_at} arr={second.arrival_at} from={second.origin_station} to={second.dest_station}
            company={second.company} serviceClass={second.service_class} seats={second.seats_available}
            price={second.price} buyUrl={second.buy_url} source={second.source} serviceFee={second.service_fee} offers={second.offers} />
        </section>
      )}
      {firsts && firsts.length > 0 && !first && (
        <p className="hint">Toque num ônibus para ver os 2º ônibus que dá para pegar.</p>
      )}
    </main>
  );
}
