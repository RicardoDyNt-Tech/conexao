import { useEffect, useState } from 'react';

// Rotas no hash (#/r?o=…): funciona em qualquer hospedagem estática, sem configurar redirects.
export interface Route { path: string; params: URLSearchParams }

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '');
  // O link mágico do Supabase volta com #access_token=…: não é rota (o supabase-js consome e limpa).
  if (!raw.startsWith('/')) return { path: '/', params: new URLSearchParams() };
  const [path, query = ''] = raw.split('?') as [string, string?];
  return { path: path || '/', params: new URLSearchParams(query) };
}

export function href(path: string, params?: Record<string, string | number | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return `#${path}${s ? `?${s}` : ''}`;
}

export function navigate(path: string, params?: Record<string, string | number | undefined | null>, replace = false): void {
  const h = href(path, params);
  if (replace) {
    history.replaceState(null, '', h);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = h;
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
