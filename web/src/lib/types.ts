// Formatos devolvidos pelo Supabase (RPCs e selects). Horários em ISO (timestamptz).

export interface City { id: number; name: string }

/** Um sentido de busca (ex.: Feira → Catu) com seus hubs, vindo de route_hubs. */
export interface Route { origin: City; dest: City; hubs: City[] }

export interface Connection {
  kind: 'direct' | 'connection';
  via_city_id: number | null;
  via_city: string | null;
  leg1_trip_id: number;
  leg1_company: string | null;
  leg1_service_class: string | null;
  leg1_origin_station: string | null;
  leg1_dest_station: string | null;
  leg1_departure_at: string;
  leg1_arrival_at: string;
  leg1_price: number | null;
  leg1_seats: number | null;
  leg1_buy_url: string | null;
  leg2_trip_id: number | null;
  leg2_company: string | null;
  leg2_service_class: string | null;
  leg2_origin_station: string | null;
  leg2_dest_station: string | null;
  leg2_departure_at: string | null;
  leg2_arrival_at: string | null;
  leg2_price: number | null;
  leg2_seats: number | null;
  leg2_buy_url: string | null;
  departure_at: string;
  arrival_at: string;
  total_price: number | null;
  same_station: boolean | null;
  data_as_of: string | null;
}

export type SortKey = 'arrival' | 'price' | 'duration';

export interface CoverageLeg {
  from_city_id: number;
  from_city: string;
  to_city_id: number;
  to_city: string;
  hub_city_id: number | null;
  hub_city: string | null;
  status: 'ok' | 'empty' | null;   // null = ainda não coletado nessa data
  trips_found: number | null;
  finished_at: string | null;
  detail: string | null;
}

export type RequestStatus = 'pending' | 'running' | 'done' | 'error';
export interface CollectRequest {
  id: number;
  origin_city_id: number;
  dest_city_id: number;
  travel_date: string;
  status: RequestStatus;
  created_at: string;
  done_at: string | null;
  error: string | null;
}

export interface Trip {
  id: number;
  company: string | null;
  service_class: string | null;
  origin_station: string | null;
  dest_station: string | null;
  dest_city_id: number;
  departure_at: string;
  arrival_at: string;
  price: number | null;
  seats_available: number | null;
  buy_url: string | null;
  fetched_at: string;
}

export interface SecondLeg {
  trip_id: number;
  company: string | null;
  service_class: string | null;
  origin_station: string | null;
  dest_station: string | null;
  departure_at: string;
  arrival_at: string;
  price: number | null;
  seats_available: number | null;
  buy_url: string | null;
  fetched_at: string;
  total_price: number | null;
  same_station: boolean | null;
  compatible: boolean;
  reason: string | null;
}

export interface Quarantine {
  until: string;
  since: string;
  reason: string | null;
  from_city: string | null;
  to_city: string | null;
  travel_date: string | null;
}

export interface CollectorStatus {
  last_round: { started_at: string | null; finished_at: string | null; ok: number; empty: number; error: number; blocked: number } | null;
  quarantine: Quarantine | null;
  open_requests: Array<{ id: number; status: RequestStatus; travel_date: string; created_at: string; from_city: string; to_city: string }>;
  collected_dates: string[];
}
