import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { useApi } from '../lib/api';
import type { CollectorStatus, Route } from '../lib/types';
import { href } from '../lib/router';
import { fmtDate, fmtStamp } from '../lib/time';
import { sourceLabel, sourceStatuses } from '../lib/sources';

export function Status({ session, routes }: { session: Session; routes: Route[] }) {
  const api = useApi();
  const [s, setS] = useState<CollectorStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.collectorStatus().then(setS).catch((e) => setErr((e as Error).message));
  }, [api]);

  const first = routes[0];
  return (
    <main className="screen stack">
      <h1>Status do coletor</h1>
      {err && <p className="error">{err}</p>}
      {!s && !err && <p className="muted">Carregando…</p>}
      {s && (
        <>
          {(sourceStatuses(s).length ? sourceStatuses(s) : [{ source: '', quarantine: null, last_round: s.last_round }]).map((src) => (
            <section key={src.source || 'geral'} className="source-status">
              <h2>{src.source ? sourceLabel(src.source) : 'Coletor'}</h2>
              <p>
                <strong>Última rodada:</strong>{' '}
                {src.last_round?.finished_at ? (
                  <>
                    {fmtStamp(src.last_round.finished_at)} · {src.last_round.ok} ok · {src.last_round.empty} sem viagens
                    {src.last_round.error > 0 && ` · ${src.last_round.error} com erro`}
                    {src.last_round.blocked > 0 && ` · ${src.last_round.blocked} bloqueado`}
                  </>
                ) : <span className="muted">nenhuma coleta registrada.</span>}
              </p>
              {src.quarantine ? (
                <p className="banner warn">
                  Pausada até {fmtStamp(src.quarantine.until)}: o site bloqueou o coletor
                  {src.quarantine.from_city && ` em ${src.quarantine.from_city} → ${src.quarantine.to_city}`}.
                </p>
              ) : <p><strong>Quarentena:</strong> não, liberada.</p>}
            </section>
          ))}

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
