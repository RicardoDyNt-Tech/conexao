import { createHash } from 'node:crypto';
import type { BrowserContext, Request } from 'playwright';
import type { LegQuery, LegResult, NormalizedTrip, PrepareResult, Source } from '../types.js';
import { SOURCE_TZ, zonedToUtcIso } from '../time.js';
import { BLOCK_STATUSES, looksBlocked } from './blocking.js';

// Quero Passagem (QP): 2ª fonte. Por enquanto só o necessário para o spike (Fase 5a, Parte 1);
// o parser para NormalizedTrip entra na Parte 2, depois de vermos respostas reais.
// Regras do CLAUDE.md valem igual: nada de forjar/reaproveitar o JWT de /search/ nem chamar
// endpoints fora do navegador. O coletor só LÊ o que a própria página recebe.

export const SOURCE = 'queropassagem';
export const QP_HOME = 'https://www.queropassagem.com.br/';

/** Página pública de busca: /onibus/{origem}-para-{destino}?ida=DD-MM-AAAA. */
export function qpSearchUrl(from: string, to: string, date: string): string {
  const [y, m, d] = date.split('-');
  if (!y || !m || !d) throw new Error(`data inválida: ${date}`);
  return `https://www.queropassagem.com.br/onibus/${from}-para-${to}?ida=${d}-${m}-${y}`;
}

/** Respostas de viagens: /search/{JWT} (uma por GDS) e /search-connections/{token}/… */
export function isSearchUrl(url: string): boolean {
  try {
    const p = new URL(url).pathname;
    return p.startsWith('/search/') || p.startsWith('/search-connections/');
  } catch {
    return false;
  }
}

const JWT_RE = /[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const JWT_FULL = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/;
// O QP também embrulha JWTs em base64 (URL de /search-connections/ e campo "tag" de cada viagem).
// Sem "/" na classe: numa URL o token é um trecho do caminho; um valor inteiro em base64
// (que pode ter "/") é tratado à parte, em redactUrl.
const B64_RE = /[A-Za-z0-9+_-]{40,}={0,2}/g;

function jwtClaims(jwt: string): Record<string, unknown> | null {
  try {
    const payload = jwt.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const parsed = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** JWT "cru" ou embrulhado em base64? Devolve o JWT de dentro, ou null. */
function unwrapJwt(s: string): string | null {
  if (JWT_FULL.test(s)) return s;
  try {
    const inner = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8').trim();
    return JWT_FULL.test(inner) ? inner : null;
  } catch {
    return null;
  }
}

/**
 * Tira JWTs (crus ou em base64) de um texto antes de gravar em log/arquivo: os arquivos do
 * spike vão para o chat e, depois, viram fixtures — nada de token. Guarda só as claims do
 * payload, lidas em texto (sem verificar nem gerar nada), porque dizem qual GDS/cidades cobre.
 */
export function redactUrl(url: string): { url: string; claims: Record<string, unknown>[] } {
  const claims: Record<string, unknown>[] = [];
  const keep = (jwt: string) => { const c = jwtClaims(jwt); if (c) claims.push(c); return '<jwt>'; };
  const whole = url.length >= 40 ? unwrapJwt(url.trim()) : null;
  if (whole) return { url: keep(whole), claims };
  const redacted = url
    .replace(JWT_RE, keep)
    .replace(B64_RE, (m) => { const jwt = unwrapJwt(m); return jwt ? keep(jwt) : m; });
  return { url: redacted, claims };
}

/** Mesma ocultação, em todas as strings de um JSON (ex.: campo "tag" das viagens). */
export function redactTokens<T>(value: T): T {
  if (typeof value === 'string') return redactUrl(value).url as T;
  if (Array.isArray(value)) return value.map((v) => redactTokens(v)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactTokens(v)])) as T;
  }
  return value;
}

/** Resumo de uma resposta de /search/: quantas viagens e de qual provedor. */
export function summarizeSearchBody(body: unknown): { items: number | null; source: unknown } {
  if (!body || typeof body !== 'object') return { items: null, source: null };
  const b = body as Record<string, unknown>;
  const list = Array.isArray(b.itens) ? b.itens : Array.isArray(b.items) ? b.items : Array.isArray(body) ? body : null;
  return { items: list ? list.length : null, source: b.source ?? null };
}

// ---------------------------------------------------------------------------
// Parser: respostas de /search/ (uma por GDS) → NormalizedTrip[]
// Formato em docs/fontes.md (seção Quero Passagem).
// ---------------------------------------------------------------------------


interface QpItem {
  id?: string;
  company?: { name?: string };
  from?: string;
  to?: string;
  departure?: string;        // "2026-10-10 05:00:00" (horário local)
  arrival?: string;
  seatClass?: string;
  price?: number;
  maxPrice?: number | null;
  tax?: number | null;
  availableSeats?: number | null;
  connectionTag?: boolean;
}

export interface QpParseResult {
  trips: NormalizedTrip[];
  warnings: string[];
  onDate: number;
  nextDate: string | null;
  /** Respostas recebidas e quantas vieram com viagens (diagnóstico). */
  responses: number;
  duplicates: number;
}

/** "Rota Transportes" → "rota-transportes" (mesmo formato do slug da ClickBus). */
export function slugify(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** "EXECUTIVO " → "Executivo", "LEITO CAMA" → "Leito Cama" (como a ClickBus escreve). */
export function normalizeClass(s: string | undefined): string {
  return (s ?? '').trim().toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}

function itemsOf(body: unknown): QpItem[] {
  if (Array.isArray(body)) return body as QpItem[];                   // /search-connections/
  if (body && typeof body === 'object' && Array.isArray((body as { itens?: unknown }).itens)) {
    return (body as { itens: QpItem[] }).itens;
  }
  return [];
}

/** id do QP (hash da viagem, igual entre GDS); sem ele, hash dos dados que identificam o ônibus. */
function tripId(i: QpItem): string {
  if (i.id) return i.id;
  const key = [i.company?.name, i.departure, i.arrival, i.from, i.to].join('|');
  return `h-${createHash('sha1').update(key).digest('hex').slice(0, 32)}`;
}

export function parseQpSearch(bodies: unknown[], query: LegQuery, tz: string = SOURCE_TZ): QpParseResult {
  const buyUrl = qpSearchUrl(query.from, query.to, query.date); // sem link por viagem (o "tag" é token)
  const byId = new Map<string, NormalizedTrip>();
  const warnings: string[] = [];
  let duplicates = 0;

  bodies.forEach((body, r) => itemsOf(body).forEach((i, k) => {
    try {
      const [dd, dt] = (i.departure ?? '').split(' ');
      const [ad, at] = (i.arrival ?? '').split(' ');
      if (!dd || !dt || !ad || !at) throw new Error('sem departure/arrival');
      if (typeof i.price !== 'number') throw new Error('sem price');
      const company = i.company?.name?.trim() ?? '';
      const trip: NormalizedTrip = {
        source: SOURCE,
        source_trip_id: tripId(i),
        search_from: query.from,
        search_to: query.to,
        travel_date: dd,
        company,
        company_slug: slugify(company),
        origin_station: i.from ?? '',
        origin_station_id: null,   // o QP não informa id de rodoviária
        dest_station: i.to ?? '',
        dest_station_id: null,
        // Cada ponta com a própria data (chegada pode ser no dia seguinte).
        departure_at: zonedToUtcIso(dd, dt, tz),
        arrival_at: zonedToUtcIso(ad, at, tz),
        service_class: normalizeClass(i.seatClass),
        price: i.price,
        original_price: typeof i.maxPrice === 'number' && i.maxPrice > i.price ? i.maxPrice : null,
        service_fee: typeof i.tax === 'number' ? i.tax : null,
        seats_available: i.availableSeats ?? null,
        seats_total: null,
        is_low_fare: false,
        // Conexão vendida pelo próprio QP: gravada, mas o cruzamento só usa trechos diretos.
        parts_count: i.connectionTag ? 2 : 1,
        buy_url: buyUrl,
      };
      // O mesmo ônibus vem de mais de um GDS (e às vezes 2× no mesmo): fica o mais barato.
      const prev = byId.get(trip.source_trip_id);
      if (prev) duplicates++;
      if (!prev || trip.price < prev.price) byId.set(trip.source_trip_id, trip);
    } catch (e) {
      warnings.push(`resposta ${r} item ${k} ignorado: ${(e as Error).message}`);
    }
  }));

  const trips = [...byId.values()].sort((a, b) => a.departure_at.localeCompare(b.departure_at));
  const onDate = trips.filter((t) => t.travel_date === query.date).length;
  const other = trips.map((t) => t.travel_date).filter((d) => d !== query.date).sort();
  return { trips, warnings, onDate, nextDate: onDate === 0 ? (other[0] ?? null) : null, responses: bodies.length, duplicates };
}

// ---------------------------------------------------------------------------
// Captura: abre a página pública e lê as respostas de /search/ que ela recebe.
// Nada de chamar /search/ direto nem reaproveitar o JWT (ver CLAUDE.md).
// ---------------------------------------------------------------------------

const WAIT_MS = 45_000;       // teto de espera pelas chamadas de todos os GDS
const QUIET_MS = 5_000;       // terminou = 5 s sem /search/ em andamento
const HOME_WAIT_MS = { min: 4_000, max: 9_000 };

export interface QpCapture {
  status: 'ok' | 'blocked' | 'error';
  bodies: unknown[];
  error?: string;
}

export async function captureQpSearch(ctx: BrowserContext, q: LegQuery,
  opts: { waitMs?: number; quietMs?: number } = {}): Promise<QpCapture> {
  const WAIT = opts.waitMs ?? WAIT_MS, QUIET = opts.quietMs ?? QUIET_MS;
  const page = await ctx.newPage();
  const bodies: unknown[] = [];
  const reads: Promise<void>[] = [];
  const pending = new Set<Request>();
  let lastActivity = Date.now();
  let seen = 0;
  let blockedStatus: number | null = null;

  page.on('request', (r) => { if (isSearchUrl(r.url())) { pending.add(r); lastActivity = Date.now(); } });
  const done = (r: Request) => { if (pending.delete(r)) lastActivity = Date.now(); };
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  page.on('response', (resp) => {
    if (!isSearchUrl(resp.url())) return;
    seen++;
    if (BLOCK_STATUSES.has(resp.status())) blockedStatus = resp.status();
    if (!resp.ok()) return;
    reads.push(resp.json().then((b) => { bodies.push(b); }, () => { /* corpo ilegível: ignora */ }));
  });

  try {
    const nav = await page.goto(qpSearchUrl(q.from, q.to, q.date), { waitUntil: 'domcontentloaded', timeout: WAIT });
    if (nav && BLOCK_STATUSES.has(nav.status())) return { status: 'blocked', bodies, error: `página devolveu HTTP ${nav.status()}` };
    const t0 = Date.now();
    let timedOut = false;
    for (;;) {
      await page.waitForTimeout(500);
      if (seen > 0 && pending.size === 0 && Date.now() - lastActivity > QUIET) break;
      if (Date.now() - t0 > WAIT) { timedOut = true; break; }
    }
    await Promise.all(reads);
    if (blockedStatus) return { status: 'blocked', bodies, error: `/search/ devolveu HTTP ${blockedStatus}` };
    if (seen === 0) {
      // Sem nenhuma busca: se a página tem cara de desafio, é bloqueio; senão, erro.
      const why = await looksBlocked(page);
      if (why) return { status: 'blocked', bodies, error: why };
      return { status: 'error', bodies, error: `nenhuma /search/ em ${WAIT / 1000} s` };
    }
    if (timedOut && pending.size > 0) return { status: 'ok', bodies, error: `${pending.size} /search/ sem resposta em ${WAIT / 1000} s` };
    return { status: 'ok', bodies };
  } catch (e) {
    return { status: 'error', bodies, error: `falha ao abrir a página: ${(e as Error).message.split('\n')[0]}` };
  } finally {
    await page.close().catch(() => {});
  }
}

export const queropassagem: Source = {
  name: SOURCE,
  /** Abre a home e fica alguns segundos, como alguém que chega ao site antes de buscar. */
  async prepare(ctx: BrowserContext): Promise<PrepareResult> {
    const page = await ctx.newPage();
    try {
      const nav = await page.goto(QP_HOME, { waitUntil: 'domcontentloaded', timeout: WAIT_MS });
      if (nav && BLOCK_STATUSES.has(nav.status())) return { status: 'blocked', error: `HTTP ${nav.status()}` };
      await page.waitForTimeout(HOME_WAIT_MS.min + Math.random() * (HOME_WAIT_MS.max - HOME_WAIT_MS.min));
      return { status: 'ok' };
    } catch (e) {
      return { status: 'error', error: (e as Error).message.split('\n')[0] };
    } finally {
      await page.close().catch(() => {});
    }
  },

  async collect(ctx: BrowserContext, query: LegQuery): Promise<LegResult> {
    const started_at = new Date().toISOString();
    const base = { source: SOURCE, ...query, trips: [] as NormalizedTrip[], found: 0, warnings: [] as string[], started_at };
    try {
      const cap = await captureQpSearch(ctx, query);
      if (cap.status !== 'ok') return { ...base, status: cap.status, error: cap.error, finished_at: new Date().toISOString() };
      const parsed = parseQpSearch(cap.bodies, query);
      return {
        ...base,
        status: parsed.onDate ? 'ok' : 'empty',
        trips: parsed.trips,
        found: parsed.onDate,
        warnings: cap.error ? [cap.error, ...parsed.warnings] : parsed.warnings,
        detail: parsed.nextDate ? `sem viagens na data; próxima data disponível: ${parsed.nextDate}` : undefined,
        raw: redactTokens(cap.bodies), // output/ também sem tokens
        finished_at: new Date().toISOString(),
      };
    } catch (e) {
      return { ...base, status: 'error', error: (e as Error).message, finished_at: new Date().toISOString() };
    }
  },
};
