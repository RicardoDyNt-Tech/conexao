import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { LegResult } from './types.js';
import type { Leg } from './runner.js';

/** Acesso ao Supabase com a service_role (só no .env do PC; nunca no front). */
export class Store {
  private constructor(private db: SupabaseClient) {}

  /** null quando o .env não tem as credenciais (modo offline). */
  static fromEnv(): Store | null {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return null;
    return new Store(createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }));
  }

  /**
   * Trechos a coletar = origem→hub e hub→destino de cada route_hub, sem repetir,
   * traduzidos para os slugs da fonte (city_source_ids).
   */
  async loadLegs(source: string): Promise<{ legs: Leg[]; warnings: string[] }> {
    const [hubs, slugs] = await Promise.all([
      this.db.from('route_hubs').select('origin_city_id, dest_city_id, hub_city_id')
        .order('origin_city_id').order('dest_city_id').order('hub_city_id'),
      this.db.from('city_source_ids').select('city_id, source_slug').eq('source', source),
    ]);
    if (hubs.error) throw new Error(`route_hubs: ${hubs.error.message}`);
    if (slugs.error) throw new Error(`city_source_ids: ${slugs.error.message}`);

    return deriveLegs(hubs.data, new Map(slugs.data.map((r) => [r.city_id, r.source_slug])), source);
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
      p_started_at: r.started_at,
      p_finished_at: r.finished_at,
    });
    if (error) throw new Error(error.message);
  }
}

export interface RouteHub { origin_city_id: number; dest_city_id: number; hub_city_id: number }

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
