import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { useApi } from '../lib/api';
import type { CollectorStatus, Route } from '../lib/types';
import { href } from '../lib/router';
import { fmtDate, fmtStamp } from '../lib/time';

export function Status({ session, routes }: { session: Session; routes: Route[] }) {
  const api = useApi();
  const [s, setS] = useState<CollectorStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.collectorStatus().then(setS).catch((e) => setErr((e as Error).message));
  }, [api]);

  const lr = s?.last_round;
  const first = routes[0];
  return (
    <main className="screen stack">
      <h1>Status do coletor</h1>
      {err && <p className="error">{err}</p>}
      {!s && !err && <p className="muted">Carregando…</p>}
      {s && (
        <>
          <section>
            <h2>Última rodada</h2>
            {lr?.finished_at ? (
              <p>
                {fmtStamp(lr.finished_at)} · {lr.ok} ok · {lr.empty} sem viagens
                {lr.error > 0 && ` · ${lr.error} com erro`}
                {lr.blocked > 0 && ` · ${lr.blocked} bloqueado`}
              </p>
            ) : <p className="muted">Nenhuma coleta registrada.</p>}
          </section>

          <section>
            <h2>Quarentena</h2>
            {s.quarantine ? (
              <p className="banner warn">
                Ativa até {fmtStamp(s.quarantine.until)}. O site bloqueou o coletor
                {s.quarantine.from_city && ` em ${s.quarantine.from_city} → ${s.quarantine.to_city}`}.
              </p>
            ) : <p>Não. O coletor está liberado.</p>}
          </section>

          <section>
            <h2>Pedidos na fila</h2>
            {s.open_requests.length ? (
              <ul>
                {s.open_requests.map((r) => (
                  <li key={r.id}>
                    {r.from_city} → {r.to_city}, {fmtDate(r.travel_date)} ·{' '}
                    {r.status === 'running' ? 'coletando agora' : `na fila desde ${fmtStamp(r.created_at)}`}
                  </li>
                ))}
              </ul>
            ) : <p className="muted">Nenhum.</p>}
            <p className="hint">Os pedidos dependem do PC do Ricardo estar ligado.</p>
          </section>

          <section>
            <h2>Datas com dados</h2>
            {s.collected_dates.length ? (
              <div className="chips">
                {s.collected_dates.map((d) => (
                  first
                    ? <a key={d} className="chip" href={href('/r', { o: first.origin.id, d: first.dest.id, date: d })}>{fmtDate(d)}</a>
                    : <span key={d} className="chip">{fmtDate(d)}</span>
                ))}
              </div>
            ) : <p className="muted">Nenhuma data futura coletada.</p>}
          </section>
        </>
      )}

      <section>
        <p className="muted">Conectado como {session.user.email}</p>
        <button className="button secondary" onClick={() => api.signOut()}>Sair</button>
      </section>
    </main>
  );
}
