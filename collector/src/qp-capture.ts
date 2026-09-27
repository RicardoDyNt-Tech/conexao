import fs from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext, Request } from 'playwright';
import { COLLECTOR_DIR } from './browser.js';
import { BLOCK_STATUSES, looksBlocked } from './sources/blocking.js';
import { isSearchUrl, qpSearchUrl, redactTokens, redactUrl, summarizeSearchBody } from './sources/queropassagem.js';

// Captura de uma página de busca do Quero Passagem para o spike (Fase 5a, Parte 1):
// registra as respostas JSON que a própria página recebe e o que aparece no DOM.

export const WAIT_MS = 45_000;        // teto de espera pelas chamadas de todos os GDS
const QUIET_MS = 5_000;        // "terminou" = 5 s sem chamada de /search/ em andamento
export const OUT_ROOT = path.join(COLLECTOR_DIR, 'output', 'qp');

interface JsonResponse {
  url: string;              // JWT ocultado
  method: string;
  status: number;
  contentType: string;
  size: number | null;
  search: boolean;
  claims?: Record<string, unknown>[];
  items?: number | null;
  provider?: unknown;
  file?: string;
}

export interface LegReport {
  leg: string;
  url: string;
  status: 'ok' | 'empty' | 'blocked' | 'error';
  detail?: string;
  navStatus: number | null;
  waitedMs: number;
  timedOut: boolean;
  jsonResponses: number;
  searchResponses: number;
  searchItems: number;
  suspiciousMarker: string | null;
  domCards: number;
  jsonLdBusTrips: number;
  dir: string;
}

interface DomDump { cards: Array<{ tag: string; cls: string; text: string }>; jsonLd: unknown[]; title: string }

/**
 * Extrai do DOM candidatos a "card de viagem" (elemento mais interno com horário e preço) e o
 * JSON-LD (schema.org BusTrip). É texto puro de propósito: o tsx/esbuild injeta um helper
 * (__name) em funções TS, e ele não existe dentro da página.
 */
const EXTRACT_DOM = `(() => {
  const out = { cards: [], jsonLd: [], title: document.title };
  const hasTime = /\\b\\d{2}:\\d{2}\\b/, hasPrice = /R\\$\\s?\\d/;
  const matches = (el) => { const t = el.innerText || ''; return hasTime.test(t) && hasPrice.test(t); };
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    if (!matches(el)) continue;
    if (Array.from(el.children).some((c) => matches(c))) continue;
    out.cards.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 120),
      text: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 400) });
    if (out.cards.length >= 80) break;
  }
  for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    try { out.jsonLd.push(JSON.parse(s.textContent || '')); } catch (e) { /* ignora */ }
  }
  return out;
})()`;

function countBusTrips(ld: unknown): number {
  if (Array.isArray(ld)) return ld.reduce((n: number, x) => n + countBusTrips(x), 0);
  if (!ld || typeof ld !== 'object') return 0;
  const o = ld as Record<string, unknown>;
  return (o['@type'] === 'BusTrip' ? 1 : 0) + countBusTrips(o['@graph']) + countBusTrips(o.itemListElement)
    + countBusTrips(o.item);
}

export async function captureLeg(ctx: BrowserContext, from: string, to: string, date: string,
  outRoot: string = OUT_ROOT, opts: { waitMs?: number; quietMs?: number } = {}): Promise<LegReport> {
  const WAIT = opts.waitMs ?? WAIT_MS, QUIET = opts.quietMs ?? QUIET_MS;
  const url = qpSearchUrl(from, to, date);
  const dir = path.join(outRoot, date, `${from}_${to}`);
  await fs.mkdir(dir, { recursive: true });
  const report: LegReport = { leg: `${from} → ${to}`, url, status: 'error', navStatus: null, waitedMs: 0, timedOut: false,
    jsonResponses: 0, searchResponses: 0, searchItems: 0, suspiciousMarker: null, domCards: 0, jsonLdBusTrips: 0, dir };

  const page = await ctx.newPage();
  const responses: JsonResponse[] = [];
  const tasks: Promise<void>[] = [];
  const pending = new Set<Request>();
  let lastSearchActivity = Date.now();
  let searchSeq = 0;

  page.on('request', (r) => { if (isSearchUrl(r.url())) { pending.add(r); lastSearchActivity = Date.now(); } });
  const done = (r: Request) => { if (pending.delete(r)) lastSearchActivity = Date.now(); };
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  page.on('response', (resp) => {
    const ct = resp.headers()['content-type'] ?? '';
    const search = isSearchUrl(resp.url());
    if (!search && !ct.includes('json')) return;
    tasks.push((async () => {
      let body: Buffer | null = null;
      try { body = await resp.body(); } catch { /* redirect/sem corpo */ }
      const { url: safeUrl, claims } = redactUrl(resp.url());
      const rec: JsonResponse = { url: safeUrl, method: resp.request().method(), status: resp.status(),
        contentType: ct, size: body?.length ?? null, search, ...(claims.length ? { claims } : {}) };
      if (search && body) {
        const n = String(++searchSeq).padStart(2, '0');
        let parsed: unknown = null;
        try { parsed = JSON.parse(body.toString('utf8')); } catch { /* não-JSON: grava cru */ }
        const file = `${n}_search.${parsed === null ? 'txt' : 'json'}`;
        await fs.writeFile(path.join(dir, file), parsed === null ? redactUrl(body.toString('utf8')).url
          : JSON.stringify(redactTokens(parsed), null, 2)); // sem tokens
        const sum = summarizeSearchBody(parsed);
        Object.assign(rec, { file, items: sum.items, provider: sum.source });
      }
      responses.push(rec);
    })());
  });

  const t0 = Date.now();
  try {
    const nav = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: WAIT });
    report.navStatus = nav?.status() ?? null;
    if (nav && BLOCK_STATUSES.has(nav.status())) {
      report.status = 'blocked'; report.detail = `página devolveu HTTP ${nav.status()}`;
    } else {
      // Espera as chamadas de todos os GDS: alguma /search/ vista, nenhuma em andamento há 5 s.
      for (;;) {
        await page.waitForTimeout(500);
        const quiet = pending.size === 0 && Date.now() - lastSearchActivity > QUIET;
        if (searchSeq > 0 && quiet) break;
        if (Date.now() - t0 > WAIT) { report.timedOut = true; break; }
      }
    }
    report.waitedMs = Date.now() - t0;
    await Promise.all(tasks);

    const blockedSearch = responses.find((r) => r.search && BLOCK_STATUSES.has(r.status));
    report.suspiciousMarker = await looksBlocked(page);
    // Diagnóstico do DOM: nunca derruba o resultado (ex.: página de 403 sem nada).
    try {
      const dom = (await page.evaluate(EXTRACT_DOM)) as DomDump;
      report.domCards = dom.cards.length;
      report.jsonLdBusTrips = countBusTrips(dom.jsonLd);
      await fs.writeFile(path.join(dir, 'dom.json'), JSON.stringify(dom, null, 2));
    } catch (e) {
      await fs.writeFile(path.join(dir, 'dom.json'), JSON.stringify({ error: (e as Error).message }, null, 2));
    }
    await fs.writeFile(path.join(dir, 'page.html'), redactUrl(await page.content()).url).catch(() => {}); // sem JWT
    await page.screenshot({ path: path.join(dir, 'page.png'), fullPage: true }).catch(() => {});

    report.jsonResponses = responses.length;
    report.searchResponses = responses.filter((r) => r.search).length;
    report.searchItems = responses.reduce((n, r) => n + (r.items ?? 0), 0);

    if (report.status === 'blocked') { /* já decidido pela navegação */ }
    else if (blockedSearch) { report.status = 'blocked'; report.detail = `/search/ devolveu HTTP ${blockedSearch.status}`; }
    // Marcador de captcha sem nenhum resultado = desafio. Com resultados, só fica registrado
    // (o QP pode ter reCAPTCHA em formulários da página normal).
    else if (report.suspiciousMarker && report.searchResponses === 0 && report.domCards === 0) {
      report.status = 'blocked'; report.detail = report.suspiciousMarker;
    } else if (report.searchItems > 0 || report.domCards > 0) report.status = 'ok';
    else {
      // Só JSON-LD não basta: no QP ele não traz preço por viagem (docs/fontes.md).
      report.status = 'empty';
      report.detail = [report.timedOut ? `nenhuma /search/ em ${WAIT / 1000} s` : null,
        report.jsonLdBusTrips ? `só JSON-LD (${report.jsonLdBusTrips} BusTrip)` : null].filter(Boolean).join('; ') || undefined;
    }
  } catch (e) {
    report.status = 'error'; report.detail = (e as Error).message.split('\n')[0];
    report.waitedMs = Date.now() - t0;
  } finally {
    responses.sort((a, b) => Number(b.search) - Number(a.search));
    await fs.writeFile(path.join(dir, 'responses.json'), JSON.stringify(responses, null, 2)).catch(() => {});
    await page.close().catch(() => {});
  }
  return report;
}

