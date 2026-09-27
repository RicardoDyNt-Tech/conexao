import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import type { LegQuery, LegResult } from './types.js';
import type { Leg } from './runner.js';

/** Acesso ao Supabase com a service_role (só no .env do PC; nunca no front). */
export class Store {
  private constructor(private db: SupabaseClient) {}

  /** null quando o .env não tem as credenciais (modo offline). */
  static fromEnv(): Store | null {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return null;
    return new Store(createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      // Node 20 não tem WebSocket nativo (o Realtime precisa dele).
      realtime: { transport: WebSocket as never },
    }));
  }

  /**
   * Trechos a coletar = origem→hub e hub→destino de cada route_hub, sem repetir,
   * traduzidos para os slugs da fonte (city_source_ids).
   */
  async loadLegs(source: string): Promise<{ legs: Leg[]; warnings: string[] }> {
    const { hubs, slugOf } = await this.routeContext(source);
    return deriveLegs(hubs, slugOf, source);
  }

  async routeContext(source: string): Promise<{ hubs: RouteHub[]; slugOf: Map<number, string> }> {
    const [hubs, slugs] = await Promise.all([
      this.db.from('route_hubs').select('origin_city_id, dest_city_id, hub_city_id')
        .order('origin_city_id').order('dest_city_id').order('hub_city_id'),
      this.db.from('city_source_ids').select('city_id, source_slug').eq('source', source),
    ]);
    if (hubs.error) throw new Error(`route_hubs: ${hubs.error.message}`);
    if (slugs.error) throw new Error(`city_source_ids: ${slugs.error.message}`);

    return { hubs: hubs.data, slugOf: new Map(slugs.data.map((r) => [r.city_id, r.source_slug])) };
  }

  /** Pega o próximo pedido pendente (já marcado como running), ou null. */
  async claimRequest(): Promise<CollectRequest | null> {
    const { data, error } = await this.db.rpc('claim_collect_request');
    if (error) throw new Error(`claim_collect_request: ${error.message}`);
    return (data as CollectRequest[] | null)?.[0] ?? null;
  }

  async finishRequest(id: number, status: 'done' | 'error', error?: string): Promise<void> {
    const { error: e } = await this.db.from('collect_requests')
      .update({ status, error: error ?? null, done_at: new Date().toISOString() }).eq('id', id);
    if (e) throw new Error(`collect_requests ${id}: ${e.message}`);
  }

  /** Devolve um pedido "running" para a fila (sem ter coletado nada). */
  async requeueRequest(id: number): Promise<void> {
    const { error } = await this.db.from('collect_requests')
      .update({ status: 'pending', started_at: null }).eq('id', id);
    if (error) throw new Error(`collect_requests ${id}: ${error.message}`);
  }

  /** Avisa a cada insert em collect_requests (Realtime). `onStatus` recebe SUBSCRIBED/CHANNEL_ERROR/… */
  subscribeRequests(onInsert: () => void, onStatus: (status: string) => void): RealtimeChannel {
    return this.db.channel('collect_requests_inserts')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'collect_requests' }, () => onInsert())
      .subscribe((status) => onStatus(status));
  }

  /** Grava trips + collector_runs + leg_stats numa transação (função record_leg_result). */
  async recordLeg(r: LegResult): Promise<void> {
    const { error } = await this.db.rpc('record_leg_result', {
      p_source: r.source,
      p_from_slug: r.from,
      p_to_slug: r.to,
      p_date: r.date,
      p_status: r.status,
      p_trips: r.trips,
      p_error: r.error ?? null,
      p_detail: r.detail ?? null,
      p_round_id: r.round_id ?? null,
      p_started_at: r.started_at,
      p_finished_at: r.finished_at,
    });
    if (error) throw new Error(error.message);
  }
}

export interface RouteHub { origin_city_id: number; dest_city_id: number; hub_city_id: number }

export interface CollectRequest { id: number; origin_city_id: number; dest_city_id: number; travel_date: string }

/**
 * Páginas para atender um pedido "atualizar agora": a direta origem→destino e,
 * para cada hub do par, origem→hub e hub→destino, todas na data pedida.
 */
export function legsForRequest(req: CollectRequest, hubs: RouteHub[], slugOf: Map<number, string>, source: string):
  { legs: LegQuery[]; warnings: string[] } {
  const pairs: Array<[number, number]> = [[req.origin_city_id, req.dest_city_id]];
  for (const h of hubs) {
    if (h.origin_city_id !== req.origin_city_id || h.dest_city_id !== req.dest_city_id) continue;
    pairs.push([h.origin_city_id, h.hub_city_id], [h.hub_city_id, h.dest_city_id]);
  }
  const legs: LegQuery[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const [a, b] of pairs) {
    const from = slugOf.get(a), to = slugOf.get(b);
    if (!from || !to) { warnings.push(`sem slug ${source} para a cidade ${!from ? a : b}`); continue; }
    const k = `${from}>${to}`;
    if (!seen.has(k)) { seen.add(k); legs.push({ from, to, date: req.travel_date }); }
  }
  return { legs, warnings };
}

/** origem→hub e hub→destino de cada route_hub, sem repetir, em slugs da fonte. */
export function deriveLegs(hubs: RouteHub[], slugOf: Map<number, string>, source: string):
  { legs: Leg[]; warnings: string[] } {
  const legs: Leg[] = [];
  const seen = new Set<string>();
  const warnings: string[] = [];
  for (const h of hubs) {
    for (const [a, b] of [[h.origin_city_id, h.hub_city_id], [h.hub_city_id, h.dest_city_id]] as const) {
      const from = slugOf.get(a), to = slugOf.get(b);
      if (!from || !to) { warnings.push(`sem slug ${source} para a cidade ${!from ? a : b}`); continue; }
      const k = `${from}>${to}`;
      if (!seen.has(k)) { seen.add(k); legs.push({ from, to }); }
    }
  }
  return { legs, warnings };
}
