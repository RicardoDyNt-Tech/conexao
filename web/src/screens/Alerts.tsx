import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useApi } from '../lib/api';
import type { Route, WatchStatus } from '../lib/types';
import { href } from '../lib/router';
import { addDays, fmtDate, fmtMoney, fmtStamp, fmtTime, localDate, today } from '../lib/time';

/** Coleta vai até 30 dias à frente; a policy do banco aplica o mesmo limite. */
const MAX_DAYS = 30;

function addError(msg: string): string {
  if (msg === 'duplicate') return 'Você já monitora esse sentido nessa data.';
  if (/row-level security/i.test(msg)) return `Escolha uma data entre hoje e daqui a ${MAX_DAYS} dias.`;
  if (/chat_chk/i.test(msg)) return 'O chat do Telegram é só número (ex.: 123456789).';
  if (/window_chk/i.test(msg)) return '"Sair depois de" precisa ser antes de "Chegar até".';
  return msg;
}

function WatchCard({ w, onRemove }: { w: WatchStatus; onRemove: () => void }) {
  const hit = w.max_price !== null && w.best_price !== null && Number(w.best_price) <= Number(w.max_price);
  const low = w.min_seats_alert !== null && w.best_min_seats !== null && w.best_min_seats <= w.min_seats_alert;
  const plus = w.best_arrival_at && localDate(w.best_arrival_at) > w.travel_date ? ' (+1)' : '';
  return (
    <article className={`card watch${hit ? ' hit' : ''}`}>
      <div className="card-body">
        <div className="row">
          <strong>{w.origin_city} → {w.dest_city}</strong>
          <span className="muted">{fmtDate(w.travel_date)}</span>
        </div>
        <div className="muted">
          {w.max_price !== null ? `Alvo: ${fmtMoney(w.max_price)}` : 'Sem preço-alvo'}
          {w.min_seats_alert !== null && ` · avisa com ${w.min_seats_alert} lugares ou menos`}
        </div>
        {(w.depart_after || w.arrive_by) && (
          <div className="muted">
            {[w.depart_after && `Sair depois de ${w.depart_after.slice(0, 5)}`,
              w.arrive_by && `chegar até ${w.arrive_by.slice(0, 5)}`].filter(Boolean).join(' · ')}
          </div>
        )}
        {w.best_price !== null && w.best_departure_at && w.best_arrival_at ? (
          <div>
            Agora: <strong>{fmtMoney(w.best_price)}</strong>
            {' · '}{fmtTime(w.best_departure_at)} → {fmtTime(w.best_arrival_at)}{plus}
            {' '}{w.best_via ? `via ${w.best_via}` : 'direto'}
            {w.best_service_fee ? <span className="muted"> (+ {fmtMoney(w.best_service_fee)} de taxa)</span> : null}
          </div>
        ) : <div className="muted">{w.depart_after || w.arrive_by
          ? 'Nenhuma combinação coletada dentro desse horário.'
          : 'Ainda sem combinações coletadas para essa data.'}</div>}
        <div className="badges">
          {hit && <span className="badge ok">Abaixo do alvo</span>}
          {low && <span className="badge warn">Poucos lugares ({w.best_min_seats})</span>}
        </div>
        {w.data_as_of && <div className="hint">Dados de {fmtStamp(w.data_as_of)}{w.last_alerted_at && ` · último aviso ${fmtStamp(w.last_alerted_at)}`}</div>}
        <div className="row">
          <a className="link" href={href('/r', { o: w.origin_city_id, d: w.dest_city_id, date: w.travel_date, sort: 'price' })}>Ver combinações</a>
          <button className="button secondary small" onClick={onRemove}>Parar de monitorar</button>
        </div>
      </div>
    </article>
  );
}

export function Alerts({ routes, initial }: { routes: Route[]; initial: URLSearchParams }) {
  const api = useApi();
  const t = today();
  const initRoute = routes.findIndex((r) => String(r.origin.id) === initial.get('o') && String(r.dest.id) === initial.get('d'));
  const [ri, setRi] = useState(initRoute >= 0 ? initRoute : 0);
  const [date, setDate] = useState(() => {
    const d = initial.get('date');
    return d && d >= t && d <= addDays(t, MAX_DAYS) ? d : addDays(t, 1);
  });
  const [maxPrice, setMaxPrice] = useState('');
  const [minSeats, setMinSeats] = useState('5');
  const [chat, setChat] = useState('');
  const [after, setAfter] = useState(initial.get('after') ?? '');
  const [until, setUntil] = useState(initial.get('until') ?? '');
  const [list, setList] = useState<WatchStatus[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.watchStatus().then(setList).catch((e) => setErr((e as Error).message));
  }, [api]);
  useEffect(load, [load]);

  if (!routes.length) return <main className="screen"><p>Nenhuma rota cadastrada.</p></main>;
  const route = routes[ri]!;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (after && until && after >= until) { setErr('"Sair depois de" precisa ser antes de "Chegar até".'); return; }
    setBusy(true); setErr(null);
    try {
      await api.addWatch({
        origin: route.origin.id, dest: route.dest.id, date,
        maxPrice: maxPrice ? Number(maxPrice.replace(',', '.')) : null,
        minSeats: minSeats ? Number(minSeats) : null,
        telegramChatId: chat.trim() || null,
        departAfter: after || null, arriveBy: until || null,
      });
      setMaxPrice('');
      load();
    } catch (e2) {
      setErr(addError((e2 as Error).message));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    try { await api.removeWatch(id); load(); } catch (e) { setErr((e as Error).message); }
  }

  return (
    <main className="screen stack">
      <h1>Alertas</h1>
      <p className="muted">
        Monitore uma data e receba aviso no Telegram quando o preço chegar no seu alvo ou os lugares
        estiverem acabando. Com horário escolhido, só contam as combinações dentro dele. A checagem
        roda depois da coleta diária (depende do PC do Ricardo ligado).
      </p>

      <form onSubmit={submit} className="stack card card-body">
        <div className="segmented">
          {routes.map((r, i) => (
            <button type="button" key={`${r.origin.id}>${r.dest.id}`} aria-pressed={i === ri} onClick={() => setRi(i)}>
              {r.origin.name} → {r.dest.name}
            </button>
          ))}
        </div>
        <label>
          Data
          <input type="date" min={t} max={addDays(t, MAX_DAYS)} value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
        </label>
        <div className="two-cols">
          <label>
            Avisar se ficar até (R$)
            <input type="number" inputMode="decimal" min="1" step="0.01" placeholder="ex.: 70" value={maxPrice}
              onChange={(e) => setMaxPrice(e.target.value)} />
          </label>
          <label>
            Avisar com até (lugares)
            <input type="number" inputMode="numeric" min="1" max="50" value={minSeats} onChange={(e) => setMinSeats(e.target.value)} />
          </label>
        </div>
        <div className="two-cols">
          <label>
            Sair depois de (opcional)
            <input type="time" value={after} onChange={(e) => setAfter(e.target.value)} />
          </label>
          <label>
            Chegar até (opcional)
            <input type="time" value={until} onChange={(e) => setUntil(e.target.value)} />
          </label>
        </div>
        <details>
          <summary className="muted">Mandar para outro chat do Telegram</summary>
          <label>
            Chat ID (vazio = chat padrão do Ricardo)
            <input inputMode="numeric" placeholder="ex.: 123456789" value={chat} onChange={(e) => setChat(e.target.value)} />
          </label>
        </details>
        <button className="button" disabled={busy}>{busy ? 'Salvando…' : 'Monitorar'}</button>
        {err && <p className="error">{err}</p>}
      </form>

      <section className="stack">
        <h2>Datas monitoradas</h2>
        {!list && !err && <p className="muted">Carregando…</p>}
        {list?.length === 0 && <p className="muted">Nenhuma data monitorada.</p>}
        {list?.map((w) => <WatchCard key={w.id} w={w} onRemove={() => remove(w.id)} />)}
      </section>
    </main>
  );
}
