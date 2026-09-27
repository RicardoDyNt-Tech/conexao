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
