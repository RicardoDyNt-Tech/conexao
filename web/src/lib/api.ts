import { createContext, useContext } from 'react';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import type {
  CollectRequest, CollectorStatus, Connection, CoverageLeg, Route, SecondLeg, SortKey, Trip,
} from './types';

/**
 * Tudo o que o app lê/escreve no banco. Só RPCs (find_connections, find_second_legs,
 * date_coverage, collector_status, request_collect) e selects simples; o cruzamento
 * de horários fica no SQL. Os testes injetam uma implementação falsa (sem rede).
 */
export interface Api {
  // Autenticação
  getSession(): Promise<Session | null>;
  onAuthChange(cb: (s: Session | null) => void): () => void;
  sendMagicLink(email: string): Promise<void>;
  signOut(): Promise<void>;

  // Leitura
  listRoutes(): Promise<Route[]>;
  findConnections(p: { origin: number; dest: number; date: string; sort: SortKey }): Promise<Connection[]>;
  dateCoverage(p: { origin: number; dest: number; date: string }): Promise<CoverageLeg[]>;
  firstLegs(p: { origin: number; hubIds: number[]; date: string }): Promise<Trip[]>;
  secondLegs(p: { firstTripId: number; dest: number }): Promise<SecondLeg[]>;
  collectorStatus(): Promise<CollectorStatus>;

  // "Atualizar agora"
  openRequest(p: { origin: number; dest: number; date: string }): Promise<CollectRequest | null>;
  requestCollect(p: { origin: number; dest: number; date: string }): Promise<CollectRequest>;
  getRequest(id: number): Promise<CollectRequest | null>;
  /** Avisa mudanças de status de um pedido (Realtime). Devolve a função para parar. */
  watchRequest(id: number, cb: (r: CollectRequest) => void): () => void;
}

const REQUEST_COLS = 'id, origin_city_id, dest_city_id, travel_date, status, created_at, done_at, error';

function check<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}

export function supabaseApi(sb: SupabaseClient): Api {
  const getRequest = async (id: number) =>
    check(await sb.from('collect_requests').select(REQUEST_COLS).eq('id', id).maybeSingle()) as CollectRequest | null;

  return {
    async getSession() { return (await sb.auth.getSession()).data.session; },
    onAuthChange(cb) {
      const { data } = sb.auth.onAuthStateChange((_e, s) => cb(s));
      return () => data.subscription.unsubscribe();
    },
    async sendMagicLink(email) {
      const { error } = await sb.auth.signInWithOtp({
        email,
        // Cadastro desligado: só entra quem já foi convidado.
        options: { shouldCreateUser: false, emailRedirectTo: window.location.origin + window.location.pathname },
      });
      if (error) throw new Error(error.message);
    },
    async signOut() { await sb.auth.signOut(); },

    async listRoutes() {
      const [hubs, cities] = await Promise.all([
        sb.from('route_hubs').select('origin_city_id, dest_city_id, hub_city_id'),
        sb.from('cities').select('id, name'),
      ]);
      const rows = check(hubs) as Array<{ origin_city_id: number; dest_city_id: number; hub_city_id: number }>;
      const byId = new Map((check(cities) as Array<{ id: number; name: string }>).map((c) => [c.id, c]));
      const routes = new Map<string, Route>();
      for (const r of rows) {
        const key = `${r.origin_city_id}>${r.dest_city_id}`;
        const o = byId.get(r.origin_city_id), d = byId.get(r.dest_city_id), h = byId.get(r.hub_city_id);
        if (!o || !d || !h) continue;
        if (!routes.has(key)) routes.set(key, { origin: o, dest: d, hubs: [] });
        routes.get(key)!.hubs.push(h);
      }
      for (const r of routes.values()) r.hubs.sort((a, b) => a.name.localeCompare(b.name));
      return [...routes.values()];
    },
    async findConnections({ origin, dest, date, sort }) {
      return check(await sb.rpc('find_connections', { p_origin: origin, p_dest: dest, p_date: date, p_order: sort })) as Connection[];
    },
    async dateCoverage({ origin, dest, date }) {
      return check(await sb.rpc('date_coverage', { p_origin: origin, p_dest: dest, p_date: date })) as CoverageLeg[];
    },
    async firstLegs({ origin, hubIds, date }) {
      return check(await sb.from('trips')
        .select('id, company, service_class, origin_station, dest_station, dest_city_id, departure_at, arrival_at, price, seats_available, buy_url, fetched_at')
        .eq('origin_city_id', origin).in('dest_city_id', hubIds).eq('travel_date', date)
        .order('departure_at')) as Trip[];
    },
    async secondLegs({ firstTripId, dest }) {
      return check(await sb.rpc('find_second_legs', { p_first_trip_id: firstTripId, p_dest: dest })) as SecondLeg[];
    },
    async collectorStatus() {
      return check(await sb.rpc('collector_status')) as CollectorStatus;
    },

    async openRequest({ origin, dest, date }) {
      return check(await sb.from('collect_requests').select(REQUEST_COLS)
        .eq('origin_city_id', origin).eq('dest_city_id', dest).eq('travel_date', date)
        .in('status', ['pending', 'running']).maybeSingle()) as CollectRequest | null;
    },
    async requestCollect({ origin, dest, date }) {
      // request_collect deduplica: com pedido em aberto para o mesmo par e data, devolve o mesmo id.
      const id = check(await sb.rpc('request_collect', { p_origin: origin, p_dest: dest, p_date: date })) as number;
      const r = await getRequest(id);
      if (!r) throw new Error('pedido criado, mas não encontrado');
      return r;
    },
    getRequest,
    watchRequest(id, cb) {
      const ch = sb.channel(`collect_request_${id}`)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'collect_requests', filter: `id=eq.${id}` },
          (p) => cb(p.new as CollectRequest))
        .subscribe();
      return () => { void sb.removeChannel(ch); };
    },
  };
}

export const ApiContext = createContext<Api | null>(null);
export function useApi(): Api {
  const api = useContext(ApiContext);
  if (!api) throw new Error('ApiContext ausente');
  return api;
}
