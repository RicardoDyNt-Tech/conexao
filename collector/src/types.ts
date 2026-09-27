import type { BrowserContext } from 'playwright';

/** Viagem normalizada. Nomes em snake_case = colunas da tabela `trips` (Fase 2). */
export interface NormalizedTrip {
  source: string;
  source_trip_id: string;
  /** Slugs usados na busca (na Fase 2 viram origin_city_id/dest_city_id via city_source_ids). */
  search_from: string;
  search_to: string;
  /** Data de saída (AAAA-MM-DD, fuso local da fonte). */
  travel_date: string;
  company: string;
  company_slug: string;
  origin_station: string;
  origin_station_id: number | null;
  dest_station: string;
  dest_station_id: number | null;
  /** ISO 8601 em UTC. */
  departure_at: string;
  arrival_at: string;
  service_class: string;
  price: number;
  original_price: number | null;
  seats_available: number | null;
  seats_total: number | null;
  is_low_fare: boolean;
  /** Número de trechos (1 = direta; >1 = conexão vendida pela própria fonte). */
  parts_count: number;
  buy_url: string;
}

export type LegStatus = 'ok' | 'empty' | 'blocked' | 'error';

export interface LegResult {
  source: string;
  from: string;
  to: string;
  date: string;
  status: LegStatus;
  /** Todas as viagens recebidas (podem incluir outra data, ver `detail`). */
  trips: NormalizedTrip[];
  /** Viagens na data pedida: é o que conta para ok/empty e trips_found. */
  found: number;
  /** Observação para collector_runs.detail (ex.: próxima data disponível). */
  detail?: string;
  /** JSON bruto recebido pela página (quando houver). */
  raw?: unknown;
  error?: string;
  warnings: string[];
  started_at: string;
  finished_at: string;
}

export interface LegQuery {
  from: string;
  to: string;
  date: string;
}

export interface PrepareResult { status: 'ok' | 'blocked' | 'error'; error?: string }

/** Interface comum a todas as fontes (ClickBus agora; Quero Passagem na Fase 5). */
export interface Source {
  name: string;
  /** Uma vez por rodada, antes da 1ª busca (ex.: abrir a home do site como um usuário faria). */
  prepare?(context: BrowserContext): Promise<PrepareResult>;
  collect(context: BrowserContext, query: LegQuery): Promise<LegResult>;
}
