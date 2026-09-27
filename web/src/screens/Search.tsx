import { useState, type FormEvent } from 'react';
import type { Route } from '../lib/types';
import { navigate } from '../lib/router';
import { addDays, fmtDate, nextWeekday, today } from '../lib/time';

const ROUTE_KEY = 'conexao.route';

function savedRoute(routes: Route[]): number {
  try {
    const k = localStorage.getItem(ROUTE_KEY);
    const i = routes.findIndex((r) => `${r.origin.id}>${r.dest.id}` === k);
    return i >= 0 ? i : 0;
  } catch { return 0; }
}

export function Search({ routes, initial }: { routes: Route[]; initial: URLSearchParams }) {
  const t = today();
  const initRoute = routes.findIndex((r) => String(r.origin.id) === initial.get('o') && String(r.dest.id) === initial.get('d'));
  const [ri, setRi] = useState(initRoute >= 0 ? initRoute : savedRoute(routes));
  const [date, setDate] = useState(initial.get('date') ?? t);
  const [after, setAfter] = useState(initial.get('after') ?? '');
  const [until, setUntil] = useState(initial.get('until') ?? '');

  if (!routes.length) return <main className="screen"><p>Nenhuma rota cadastrada no banco (route_hubs).</p></main>;
  const route = routes[ri]!;

  const shortcuts: Array<[string, string]> = [
    // "Sexta"/"Domingo" = a próxima depois de hoje (num domingo, "Domingo" é o da semana que vem).
    ['Hoje', t], ['Amanhã', addDays(t, 1)], ['Sexta', nextWeekday(addDays(t, 1), 5)], ['Domingo', nextWeekday(addDays(t, 1), 0)],
  ];

  function submit(e: FormEvent) {
    e.preventDefault();
    try { localStorage.setItem(ROUTE_KEY, `${route.origin.id}>${route.dest.id}`); } catch { /* ok */ }
    navigate('/r', { o: route.origin.id, d: route.dest.id, date, after, until });
  }

  return (
    <main className="screen">
      <form onSubmit={submit} className="stack">
        <fieldset>
          <legend>Sentido</legend>
          <div className="segmented">
            {routes.map((r, i) => (
              <button type="button" key={`${r.origin.id}>${r.dest.id}`} aria-pressed={i === ri} onClick={() => setRi(i)}>
                {r.origin.name} → {r.dest.name}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend>Data</legend>
          <div className="chips">
            {shortcuts.map(([label, d]) => (
              <button type="button" key={label} aria-pressed={date === d} onClick={() => setDate(d)}>{label}</button>
            ))}
          </div>
          <input type="date" aria-label="Escolher data" min={t} value={date}
            onChange={(e) => e.target.value && setDate(e.target.value)} />
          <p className="muted">{fmtDate(date)}</p>
        </fieldset>

        <fieldset>
          <legend>Horário (opcional)</legend>
          <div className="two-cols">
            <label>Sair depois de<input type="time" value={after} onChange={(e) => setAfter(e.target.value)} /></label>
            <label>Chegar até<input type="time" value={until} onChange={(e) => setUntil(e.target.value)} /></label>
          </div>
        </fieldset>

        <button className="button big">Buscar</button>
      </form>
    </main>
  );
}
