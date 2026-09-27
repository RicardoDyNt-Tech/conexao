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

/**
 * Tira o JWT da URL antes de gravar em log/arquivo (os arquivos do spike vão para o chat e,
 * depois, viram fixtures: nada de token). Guarda só as claims do payload, lidas em texto
 * (sem verificar nem gerar nada), porque dizem qual GDS/cidades a chamada cobre.
 */
export function redactUrl(url: string): { url: string; claims: Record<string, unknown>[] } {
  const claims: Record<string, unknown>[] = [];
  const redacted = url.replace(JWT_RE, (jwt) => {
    try {
      const payload = jwt.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/');
      const parsed = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as unknown;
      if (parsed && typeof parsed === 'object') claims.push(parsed as Record<string, unknown>);
    } catch { /* não era JWT de verdade: só oculta */ }
    return '<jwt>';
  });
  return { url: redacted, claims };
}

/** Resumo de uma resposta de /search/: quantas viagens e de qual provedor. */
export function summarizeSearchBody(body: unknown): { items: number | null; source: unknown } {
  if (!body || typeof body !== 'object') return { items: null, source: null };
  const b = body as Record<string, unknown>;
  const list = Array.isArray(b.itens) ? b.itens : Array.isArray(b.items) ? b.items : Array.isArray(body) ? body : null;
  return { items: list ? list.length : null, source: b.source ?? null };
}
