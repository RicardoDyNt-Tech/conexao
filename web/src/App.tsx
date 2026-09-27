import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { useApi } from './lib/api';
import type { Route } from './lib/types';
import { href, useRoute } from './lib/router';
import { Login } from './screens/Login';
import { Search } from './screens/Search';
import { Results } from './screens/Results';
import { BuildYourOwn } from './screens/BuildYourOwn';
import { Status } from './screens/Status';
import { Alerts } from './screens/Alerts';

export function App() {
  const api = useApi();
  const { path, params } = useRoute();
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [routes, setRoutes] = useState<Route[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.getSession().then(setSession).catch(() => setSession(null));
    return api.onAuthChange(setSession);
  }, [api]);

  useEffect(() => {
    if (!session) return;
    api.listRoutes().then(setRoutes).catch((e) => setErr((e as Error).message));
  }, [api, session]);

  if (session === undefined) return <main className="screen"><p className="muted">Carregando…</p></main>;
  if (!session) return <Login />;

  const route = routes?.find((r) => String(r.origin.id) === params.get('o') && String(r.dest.id) === params.get('d'));
  const needsSearch = (path === '/r' || path === '/m') && (!route || !params.get('date'));

  return (
    <>
      <header className="app-header">
        <a href="#/" className="brand">Conexão</a>
        <span className="header-icons">
        <a href={href('/alertas')} className="icon-link" aria-label="Alertas" title="Alertas">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path fill="currentColor" d="M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6V11a6 6 0 0 0-5-5.9V4a1 1 0 0 0-2 0v1.1A6 6 0 0 0 6 11v5l-2 2v1h16v-1z" />
          </svg>
        </a>
        <a href={href('/status')} className="icon-link" aria-label="Status do coletor" title="Status do coletor">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path fill="currentColor" d="M3 13h2v7H3zm4-5h2v12H7zm4 3h2v9h-2zm4-7h2v16h-2zm4 9h2v7h-2z" />
          </svg>
        </a>
        </span>
      </header>
      {err && <p className="error screen">Erro ao carregar rotas: {err}</p>}
      {!routes && !err && <main className="screen"><p className="muted">Carregando…</p></main>}
      {routes && (
        path === '/status' ? <Status session={session} routes={routes} />
          : path === '/alertas' ? <Alerts routes={routes} initial={params} />
          : path === '/r' && route && !needsSearch ? <Results route={route} params={params} />
          : path === '/m' && route && !needsSearch ? <BuildYourOwn route={route} params={params} />
          : <Search routes={routes} initial={params} />
      )}
    </>
  );
}
