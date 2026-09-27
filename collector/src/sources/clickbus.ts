import type { BrowserContext, Page, Response } from 'playwright';
import type { LegQuery, LegResult, NormalizedTrip, Source } from '../types.js';
import { SOURCE_TZ, zonedToUtcIso } from '../time.js';

export const SOURCE = 'clickbus';
const TRIPS_API_PATH = '/web/api/v6/trips';
const RESPONSE_TIMEOUT_MS = 30_000;

export function searchPageUrl({ from, to, date }: LegQuery): string {
  return `https://www.clickbus.com.br/onibus/${from}/${to}?departureDate=${date}`;
}

// ---------------------------------------------------------------------------
// Parser: JSON de v6/trips → NormalizedTrip[]
// ---------------------------------------------------------------------------

interface CbPoint { date: string; time: string; name?: string; city?: string; slug?: string; id?: number }
interface CbPart {
  tripId: string;
  departure: CbPoint;
  arrival: CbPoint;
  serviceClass?: { name?: string };
  travelCompany?: { name?: string; slug?: string };
  availableSeats?: number | null;
  totalSeats?: number | null;
  isLowFare?: boolean;
}
interface CbTrip { type?: string; price: number; originalPrice?: number; parts: CbPart[] }
export interface CbTripsResponse { trips?: CbTrip[]; isRedirectResult?: boolean; errors?: unknown[] }

export interface ParseResult {
  trips: NormalizedTrip[];
  warnings: string[];
  /** true quando a ClickBus redirecionou para outro trecho (ex.: Feira → Catu direto). */
  redirected: boolean;
}

function minOrNull(values: Array<number | null | undefined>): number | null {
  const nums = values.filter((v): v is number => typeof v === 'number');
  return nums.length ? Math.min(...nums) : null;
}

export function parseClickbusTrips(json: CbTripsResponse, query: LegQuery, tz: string = SOURCE_TZ): ParseResult {
  if (!json || !Array.isArray(json.trips)) {
    throw new Error('resposta de v6/trips sem o array "trips" (formato mudou?)');
  }
  // Resultado redirecionado = viagens de outro trecho. Não misturar com o trecho pedido.
  if (json.isRedirectResult) return { trips: [], warnings: ['isRedirectResult=true: ignorado'], redirected: true };

  const buyUrl = searchPageUrl(query); // link direto para a viagem: a descobrir (docs/fontes.md)
  const trips: NormalizedTrip[] = [];
  const warnings: string[] = [];

  json.trips.forEach((t, i) => {
    try {
      const first = t.parts?.[0];
      const last = t.parts?.[t.parts.length - 1];
      if (!first || !last) throw new Error('sem parts');
      if (typeof t.price !== 'number') throw new Error('sem price');
      trips.push({
        source: SOURCE,
        source_trip_id: first.tripId,
        search_from: query.from,
        search_to: query.to,
        travel_date: first.departure.date,
        company: first.travelCompany?.name ?? '',
        company_slug: first.travelCompany?.slug ?? '',
        origin_station: first.departure.name ?? '',
        origin_station_id: first.departure.id ?? null,
        dest_station: last.arrival.name ?? '',
        dest_station_id: last.arrival.id ?? null,
        // Cada ponta usa a própria data informada pela fonte (chegada pode ser no dia seguinte).
        departure_at: zonedToUtcIso(first.departure.date, first.departure.time, tz),
        arrival_at: zonedToUtcIso(last.arrival.date, last.arrival.time, tz),
        service_class: first.serviceClass?.name ?? '',
        price: t.price,
        original_price: t.originalPrice ?? null,
        // Em conexões vendidas prontas, o limite é o trecho com menos assentos.
        seats_available: minOrNull(t.parts.map((p) => p.availableSeats)),
        seats_total: minOrNull(t.parts.map((p) => p.totalSeats)),
        is_low_fare: Boolean(first.isLowFare),
        parts_count: t.parts.length,
        buy_url: buyUrl,
      });
    } catch (e) {
      warnings.push(`trips[${i}] ignorada: ${(e as Error).message}`);
    }
  });

  return { trips, warnings, redirected: false };
}

// ---------------------------------------------------------------------------
// Captura: abre a página pública e lê a resposta de v6/trips que ela recebe.
// Nada de chamar a API direto nem mexer em headers/tokens (ver CLAUDE.md).
// ---------------------------------------------------------------------------

const BLOCK_STATUSES = new Set([401, 403, 429]);

/** Sinais de página de desafio/bloqueio (captcha, "access denied"). */
export async function looksBlocked(page: Page): Promise<string | null> {
  try {
    const title = (await page.title()).toLowerCase();
    const html = (await page.content()).toLowerCase();
    if (title.includes('access') && title.includes('denied')) return `título: ${title}`;
    for (const marker of ['px-captcha', 'press & hold', 'pressione e segure', 'g-recaptcha', 'h-captcha', 'cf-challenge']) {
      if (html.includes(marker)) return `marcador na página: ${marker}`;
    }
  } catch {
    /* página fechou/navegou: sem diagnóstico */
  }
  return null;
}

function isTripsResponse(r: Response, q: LegQuery): boolean {
  if (r.request().method() !== 'GET' || !r.url().includes(TRIPS_API_PATH)) return false;
  const u = new URL(r.url());
  // Garante que é a resposta do trecho/data pedidos, não de outra busca da página.
  return u.searchParams.get('from') === q.from && u.searchParams.get('to') === q.to
    && u.searchParams.get('departureDate') === q.date;
}

export async function captureTripsJson(page: Page, q: LegQuery, timeoutMs = RESPONSE_TIMEOUT_MS):
  Promise<{ status: 'ok' | 'blocked' | 'error'; json?: CbTripsResponse; error?: string }> {
  const responseP = page.waitForResponse((r) => isTripsResponse(r, q), { timeout: timeoutMs });
  responseP.catch(() => {}); // evita unhandled rejection se a navegação falhar antes

  let nav: Response | null;
  try {
    nav = await page.goto(searchPageUrl(q), { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  } catch (e) {
    return { status: 'error', error: `falha ao abrir a página: ${(e as Error).message.split('\n')[0]}` };
  }
  if (nav && BLOCK_STATUSES.has(nav.status())) return { status: 'blocked', error: `página devolveu HTTP ${nav.status()}` };

  let resp: Response;
  try {
    resp = await responseP;
  } catch {
    const why = await looksBlocked(page);
    if (why) return { status: 'blocked', error: why };
    return { status: 'error', error: `v6/trips não chegou em ${timeoutMs / 1000} s` };
  }

  if (BLOCK_STATUSES.has(resp.status())) return { status: 'blocked', error: `v6/trips devolveu HTTP ${resp.status()}` };
  if (!resp.ok()) return { status: 'error', error: `v6/trips devolveu HTTP ${resp.status()}` };
  try {
    return { status: 'ok', json: (await resp.json()) as CbTripsResponse };
  } catch (e) {
    return { status: 'error', error: `corpo de v6/trips ilegível: ${(e as Error).message}` };
  }
}

export const clickbus: Source = {
  name: SOURCE,
  async collect(context: BrowserContext, query: LegQuery): Promise<LegResult> {
    const started_at = new Date().toISOString();
    const base = { source: SOURCE, ...query, trips: [] as NormalizedTrip[], warnings: [] as string[], started_at };
    const page = await context.newPage();
    try {
      const cap = await captureTripsJson(page, query);
      if (cap.status !== 'ok') return { ...base, status: cap.status, error: cap.error, finished_at: new Date().toISOString() };
      const parsed = parseClickbusTrips(cap.json!, query);
      return {
        ...base,
        status: parsed.trips.length ? 'ok' : 'empty',
        trips: parsed.trips,
        warnings: parsed.warnings,
        raw: cap.json,
        finished_at: new Date().toISOString(),
      };
    } catch (e) {
      return { ...base, status: 'error', error: (e as Error).message, finished_at: new Date().toISOString() };
    } finally {
      await page.close().catch(() => {});
    }
  },
};
