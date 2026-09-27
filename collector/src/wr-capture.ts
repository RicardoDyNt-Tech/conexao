import fs from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext, Locator, Page, Request } from 'playwright';
import { COLLECTOR_DIR } from './browser.js';
import { BLOCK_STATUSES, looksBlocked } from './sources/blocking.js';
import {
  addDays, brDate, matchesCity, postFieldNames, redactHtml, redactJsonKeys, redactPostData, redactWrUrl,
  typedQuery, type Viacao,
} from './sources/webrodoviaria.js';
import { slugify } from './sources/queropassagem.js';

// Captura de uma busca na Venda Web (webrodoviaria) para o spike (Fase 5c, Parte 1).
// Ainda não conhecemos o HTML da plataforma: os campos são achados por rótulo/placeholder/nome,
// e cada passo fica registrado em steps.json para ajustarmos a Parte 2 com o que for visto.
// Só age como um usuário (clica, digita, escolhe a sugestão); nunca monta requisição.

export const OUT_ROOT = path.join(COLLECTOR_DIR, 'output', 'webrodoviaria');
export const WAIT_MS = 45_000;       // teto por carregamento
const QUIET_MS = 3_000;              // "terminou" = 3 s sem XHR/fetch/documento em andamento
const MAX_BODY = 2_000_000;          // corpos maiores não são gravados
const SKIP_TYPES = new Set(['image', 'font', 'stylesheet', 'media', 'manifest', 'texttrack']);

export interface Range { min: number; max: number }
export const rand = (r: Range) => r.min + Math.random() * (r.max - r.min);
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

type Phase = 'root' | 'autocomplete' | 'search' | 'tab';

interface NetRecord {
  seq: number;
  phase: Phase;
  type: string;             // resourceType do Playwright (document, xhr, fetch, script...)
  method: string;
  url: string;              // ocultado
  navigation: boolean;
  status: number | null;
  contentType: string;
  size: number | null;
  postData?: string | null; // ocultado
  postFields?: string[];
  file?: string;
  failure?: string;
}

interface Step { at: number; step: string; ok: boolean; info?: string }

export interface LegReport {
  viacao: string;
  leg: string;
  date: string;
  status: 'ok' | 'empty' | 'blocked' | 'error';
  detail?: string;
  rootStatus: number | null;
  resultUrl: string | null;
  /** Requisição que levou aos resultados (documento ou XHR com POST/GET). */
  searchRequest: { method: string; url: string; type: string; postFields: string[] } | null;
  form: { method: string | null; action: string | null } | null;
  cards: number;
  dateTabs: string[];
  /** Troca de aba de data: 'xhr' (mesma página), 'navigation' (nova página), 'none', ou null (não testado). */
  tabSwitch: 'xhr' | 'navigation' | 'none' | null;
  tabCards: number | null;
  idCandidates: string[];
  xhrDuringSearch: number;
  suspiciousMarker: string | null;
  pages: number;
  waitedMs: number;
  dir: string;
}

export interface CaptureOpts {
  /** Pausa mínima entre carregamentos de página (15–30 s no PC; menor só no ensaio). */
  pause: Range;
  /** Espera extra depois de abrir a raiz, antes de começar a digitar. */
  settle: Range;
  typingDelay: Range;
  waitMs?: number;
  quietMs?: number;
  /** Testa a troca de aba de data (custa 1 página se for navegação). */
  tryTab: boolean;
  /** Pede uma página ao orçamento diário; false = parar. */
  takePage: () => Promise<boolean>;
  outRoot?: string;
  log?: (s: string) => void;
}

// ---------------------------------------------------------------------------
// Diagnóstico do DOM (texto puro: o tsx injeta __name em funções TS, e ele não existe na página).
// ---------------------------------------------------------------------------

/** Campos de formulário visíveis, com rótulos, e os <form> (method/action). */
const DUMP_FORMS = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const labelOf = (el) => { const id = el.id; let t = '';
    if (id) { const l = document.querySelector('label[for="' + CSS.escape(id) + '"]'); if (l) t = l.innerText; }
    if (!t && el.closest('label')) t = el.closest('label').innerText;
    return (t || '').replace(/\\s+/g, ' ').trim().slice(0, 80); };
  const sensitive = /viewstate|eventvalidation|token|csrf|xsrf|session|sessid|nonce|captcha|auth|signature|secret|hash/i;
  const fields = Array.from(document.querySelectorAll('input, select, textarea, button, a[onclick], [role=combobox]')).map((el) => ({
    tag: el.tagName.toLowerCase(), type: el.getAttribute('type'), id: el.id || null, name: el.getAttribute('name'),
    placeholder: el.getAttribute('placeholder'), label: labelOf(el), cls: String(el.className || '').slice(0, 100),
    readonly: el.hasAttribute('readonly'), visible: vis(el),
    text: el.tagName === 'SELECT' ? null : (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
    value: sensitive.test((el.getAttribute('name') || '') + ' ' + (el.id || '')) ? '<token>' : String(el.value || '').slice(0, 60),
    options: el.tagName === 'SELECT' ? Array.from(el.options).slice(0, 400).map((o) => o.text.trim()) : undefined,
    form: el.form ? (el.form.id || el.form.getAttribute('name') || 'form') : null,
  })).filter((f) => f.visible || f.type === 'hidden');
  const forms = Array.from(document.forms).map((f) => ({ id: f.id || null, name: f.getAttribute('name'),
    method: (f.getAttribute('method') || 'get').toLowerCase(), action: f.getAttribute('action') }));
  return { url: location.href, title: document.title, forms, fields };
})()`;

/** Cards de viagem (elemento mais interno com horário e preço), abas de data e ids candidatos. */
const DUMP_RESULTS = `(() => {
  const out = { title: document.title, cards: [], tabs: [], ids: [] };
  const hasTime = /\\b\\d{2}:\\d{2}\\b/, hasPrice = /R\\$\\s?\\d/;
  const matches = (el) => { const t = el.innerText || ''; return hasTime.test(t) && hasPrice.test(t); };
  const sensitive = /viewstate|token|csrf|session|nonce|captcha|signature|secret|hash/i;
  const attrsOf = (el) => Array.from(el.attributes).filter((a) => /^(id|data-|onclick|href|value|name|class)/.test(a.name))
    .map((a) => a.name + '=' + (sensitive.test(a.name + a.value.slice(0, 30)) ? '<token>' : a.value.slice(0, 160)));
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    if (!matches(el)) continue;
    if (Array.from(el.children).some((c) => matches(c))) continue;
    const inner = Array.from(el.querySelectorAll('[id], [data-id], [data-viagem], [onclick], input[type=hidden], a[href], button'))
      .slice(0, 25).map((x) => x.tagName.toLowerCase() + ' ' + attrsOf(x).join(' '));
    out.cards.push({ tag: el.tagName.toLowerCase(), attrs: attrsOf(el), inner,
      text: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 500) });
    if (out.cards.length >= 120) break;
  }
  for (const el of Array.from(document.querySelectorAll('a, button, li, [role=tab], [onclick], td, div, span'))) {
    const t = (el.innerText || '').replace(/\\s+/g, ' ').trim();
    if (t.length > 40 || !/\\b\\d{2}\\/\\d{2}\\b/.test(t)) continue;
    if (Array.from(el.children).some((c) => /\\b\\d{2}\\/\\d{2}\\b/.test(c.innerText || '') && (c.innerText || '').length <= 40)) continue;
    out.tabs.push({ tag: el.tagName.toLowerCase(), text: t, attrs: attrsOf(el) });
    if (out.tabs.length >= 40) break;
  }
  return out;
})()`;

interface ResultsDump {
  title: string;
  cards: Array<{ tag: string; attrs: string[]; inner: string[]; text: string }>;
  tabs: Array<{ tag: string; text: string; attrs: string[] }>;
}

// ---------------------------------------------------------------------------
// Achar e preencher campos (heurísticas; o que for tentado vai para steps.json)
// ---------------------------------------------------------------------------

const ORIGIN_RE = /origem|saindo|sa[ií]da|partida|de onde|^de$/i;
const DEST_RE = /destino|indo para|chegada|para onde|^para$/i;
const DATE_RE = /data|ida\b|dia da viagem/i;
const SEARCH_RE = /pesquisar|buscar|consultar|procurar|pesquisa/i;

async function firstVisible(cands: Locator[]): Promise<Locator | null> {
  for (const c of cands) {
    const n = await c.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 10); i++) {
      const el = c.nth(i);
      if (await el.isVisible().catch(() => false)) return el;
    }
  }
  return null;
}

function fieldCandidates(page: Page, re: RegExp, attrWords: string[]): Locator[] {
  const attr = attrWords.flatMap((w) => [`[name*="${w}" i]`, `[id*="${w}" i]`])
    .flatMap((a) => [`input${a}:not([type=hidden])`, `select${a}`]).join(', ');
  return [page.getByLabel(re), page.getByPlaceholder(re), page.locator(attr), page.getByRole('combobox', { name: re })];
}

const tagOf = (el: Locator) => el.evaluate((e) => e.tagName.toLowerCase());

async function fillCity(page: Page, el: Locator, cityName: string, typing: Range, steps: Step[], what: string): Promise<boolean> {
  const t0 = Date.now();
  const push = (ok: boolean, info: string) => steps.push({ at: Date.now() - t0, step: `${what}`, ok, info });
  if ((await tagOf(el)) === 'select') {
    const opts = await el.locator('option').allTextContents();
    const label = opts.find((o) => matchesCity(o, cityName));
    if (!label) { push(false, `select sem opção "${cityName}" (${opts.length} opções)`); return false; }
    await el.selectOption({ label });
    push(true, `select → "${label.trim()}"`);
    return true;
  }
  await el.click();
  await el.fill('');
  await el.pressSequentially(typedQuery(cityName), { delay: rand(typing) });
  // Sugestão do autocomplete: qualquer elemento visível cujo texto seja a cidade.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(400);
    const sugg = page.locator('li, a, [role=option], .ui-menu-item, .autocomplete-suggestion, div, span, td')
      .filter({ hasText: new RegExp(typedQuery(cityName).split(' ')[0]!, 'i') });
    const n = await sugg.count().catch(() => 0);
    for (let i = n - 1; i >= Math.max(0, n - 300); i--) {   // de trás para frente: o menu costuma vir depois do campo
      const s = sugg.nth(i);
      const text = await s.innerText().catch(() => '');
      if (!matchesCity(text, cityName) || !(await s.isVisible().catch(() => false))) continue;
      await s.click();
      push(true, `sugestão clicada: "${text.trim()}" → campo = "${await el.inputValue().catch(() => '?')}"`);
      return true;
    }
  }
  // Sem sugestão clicável: para aqui. Nada de Enter, que submeteria o formulário fora do
  // orçamento e da pausa entre páginas.
  push(false, `nenhuma sugestão visível igual a "${cityName}" em 10 s; campo = "${await el.inputValue().catch(() => '?')}"`);
  return false;
}

async function fillDate(el: Locator, iso: string, typing: Range, steps: Step[]): Promise<boolean> {
  const type = await el.getAttribute('type');
  const want = type === 'date' ? iso : brDate(iso);
  if (!(await el.getAttribute('readonly').then((r) => r !== null).catch(() => false))) {
    await el.click();
    await el.fill('');
    await el.pressSequentially(type === 'date' ? want.split('-').reverse().join('') : want, { delay: rand(typing) });
  }
  // (sem Enter aqui também: submeteria o formulário)
  let v = await el.inputValue().catch(() => '');
  let how = 'digitado';
  if (v !== want) {
    // Campo só-leitura (datepicker): define o valor e dispara os eventos que o site escuta.
    await el.evaluate((e, val) => {
      (e as HTMLInputElement).value = val;
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
    }, want);
    v = await el.inputValue().catch(() => '');
    how = 'definido via evento (campo só-leitura ou máscara)';
  }
  await el.press('Tab').catch(() => {});
  steps.push({ at: 0, step: 'data', ok: v === want, info: `${how} → "${v}" (esperado "${want}")` });
  return v === want;
}

// ---------------------------------------------------------------------------
// Captura
// ---------------------------------------------------------------------------

export async function captureLeg(ctx: BrowserContext, v: Viacao, fromName: string, toName: string, date: string,
  opts: CaptureOpts): Promise<LegReport> {
  const WAIT = opts.waitMs ?? WAIT_MS, QUIET = opts.quietMs ?? QUIET_MS;
  const log = opts.log ?? console.log;
  const dir = path.join(opts.outRoot ?? OUT_ROOT, date, `${v.source}_${slugify(fromName)}_${slugify(toName)}`);
  await fs.rm(dir, { recursive: true, force: true }); // sem restos de uma execução anterior
  await fs.mkdir(dir, { recursive: true });
  const report: LegReport = { viacao: v.source, leg: `${fromName} → ${toName}`, date, status: 'error', rootStatus: null,
    resultUrl: null, searchRequest: null, form: null, cards: 0, dateTabs: [], tabSwitch: null, tabCards: null,
    idCandidates: [], xhrDuringSearch: 0, suspiciousMarker: null, pages: 0, waitedMs: 0, dir };
  const steps: Step[] = [];
  const net: NetRecord[] = [];
  const tasks: Promise<void>[] = [];
  const pending = new Set<Request>();
  let phase: Phase = 'root';
  let lastActivity = Date.now();
  let seq = 0;

  const page = await ctx.newPage();
  const watched = (r: Request) => !SKIP_TYPES.has(r.resourceType());
  page.on('request', (r) => { if (watched(r)) { pending.add(r); lastActivity = Date.now(); } });
  const done = (r: Request) => { if (pending.delete(r)) lastActivity = Date.now(); };
  page.on('requestfinished', done);
  page.on('requestfailed', (r) => {
    done(r);
    if (!watched(r)) return;
    net.push({ seq: ++seq, phase, type: r.resourceType(), method: r.method(), url: redactWrUrl(r.url()),
      navigation: r.isNavigationRequest(), status: null, contentType: '', size: null, failure: r.failure()?.errorText ?? '?' });
  });
  page.on('response', (resp) => {
    const req = resp.request();
    if (!watched(req)) return;
    const rec: NetRecord = { seq: ++seq, phase, type: req.resourceType(), method: req.method(), url: redactWrUrl(resp.url()),
      navigation: req.isNavigationRequest(), status: resp.status(), contentType: resp.headers()['content-type'] ?? '',
      size: null };
    if (req.method() !== 'GET') {
      const pd = req.postData();
      rec.postData = redactPostData(pd)?.slice(0, 4000) ?? null;
      rec.postFields = postFieldNames(pd);
    }
    net.push(rec);
    tasks.push((async () => {
      let body: Buffer | null = null;
      try { body = await resp.body(); } catch { /* redirect/sem corpo */ }
      rec.size = body?.length ?? null;
      // Grava corpos de XHR/fetch/documento (JSON, HTML, XML do JSF), sem tokens.
      const isData = ['xhr', 'fetch', 'document'].includes(rec.type) && rec.phase !== 'root';
      if (!body || !isData || body.length > MAX_BODY || resp.status() >= 300) return;
      const text = body.toString('utf8');
      let json: unknown = undefined;
      if (rec.contentType.includes('json')) { try { json = JSON.parse(text); } catch { /* grava como texto */ } }
      const ext = json !== undefined ? 'json' : rec.contentType.includes('html') ? 'html' : rec.contentType.includes('xml') ? 'xml' : 'txt';
      rec.file = `${String(rec.seq).padStart(3, '0')}_${rec.phase}_${rec.type}.${ext}`;
      await fs.writeFile(path.join(dir, rec.file),
        json !== undefined ? JSON.stringify(redactJsonKeys(json), null, 2) : redactHtml(text));
    })());
  });

  /** Espera a rede sossegar (nenhum XHR/fetch/documento em andamento há QUIET ms). */
  const settle = async () => {
    const t0 = Date.now();
    await page.waitForLoadState('domcontentloaded', { timeout: WAIT }).catch(() => {});
    for (;;) {
      await page.waitForTimeout(300);
      if (pending.size === 0 && Date.now() - lastActivity > QUIET) return false;
      if (Date.now() - t0 > WAIT) return true;
    }
  };
  const blockedNet = () => net.find((r) => r.status != null && BLOCK_STATUSES.has(r.status) && ['document', 'xhr', 'fetch'].includes(r.type));
  /**
   * HTTP 401/403/429 = bloqueio. Marcador de captcha só conta se a página não tiver o que
   * esperamos (formulário/cards): a Venda Web pode ter reCAPTCHA no login da página normal.
   */
  const checkBlocked = async (where: string, hasContent: boolean): Promise<boolean> => {
    const b = blockedNet();
    if (b) { report.status = 'blocked'; report.detail = `${where}: HTTP ${b.status} em ${b.url}`; return true; }
    const m = await looksBlocked(page);
    if (m) report.suspiciousMarker = m;
    if (m && !hasContent) { report.status = 'blocked'; report.detail = `${where}: ${m}`; return true; }
    return false;
  };

  const t0 = Date.now();
  try {
    // 1) Raiz da Venda Web (formulário).
    if (!(await opts.takePage())) { report.status = 'error'; report.detail = 'limite diário de páginas'; return report; }
    report.pages++;
    const nav = await page.goto(v.baseUrl, { waitUntil: 'domcontentloaded', timeout: WAIT });
    const openedAt = Date.now();
    report.rootStatus = nav?.status() ?? null;
    if (nav && BLOCK_STATUSES.has(nav.status())) { report.status = 'blocked'; report.detail = `raiz: HTTP ${nav.status()}`; return report; }
    await settle();
    await fs.writeFile(path.join(dir, 'root.html'), redactHtml(await page.content())).catch(() => {});
    const forms = await page.evaluate(DUMP_FORMS).catch((e: Error) => ({ error: e.message }));
    await fs.writeFile(path.join(dir, 'forms.json'), JSON.stringify(redactJsonKeys(forms), null, 2));
    await page.waitForTimeout(rand(opts.settle));

    // 2) Preenche como um usuário.
    phase = 'autocomplete';
    const origin = await firstVisible(fieldCandidates(page, ORIGIN_RE, ['origem', 'partida', 'saida']));
    const dest = await firstVisible(fieldCandidates(page, DEST_RE, ['destino', 'chegada']));
    const dateEl = await firstVisible([...fieldCandidates(page, DATE_RE, ['data', 'dtida', 'dataida']),
      page.locator('input[type=date]')]);
    steps.push({ at: 0, step: 'campos', ok: !!(origin && dest && dateEl),
      info: `origem ${origin ? 'ok' : 'não achada'}, destino ${dest ? 'ok' : 'não achado'}, data ${dateEl ? 'ok' : 'não achada'}` });
    if (await checkBlocked('raiz', !!(origin && dest))) return report;
    if (!origin || !dest || !dateEl) { report.status = 'error'; report.detail = 'campos do formulário não achados (ver forms.json)'; return report; }
    report.form = await origin.evaluate((e) => {
      const f = (e as HTMLInputElement).form;
      return f ? { method: (f.getAttribute('method') || 'get').toLowerCase(), action: f.getAttribute('action') } : null;
    }).catch(() => null);

    if (!(await fillCity(page, origin, fromName, opts.typingDelay, steps, 'origem'))) {
      report.status = 'error'; report.detail = `origem "${fromName}" não selecionada`; return report;
    }
    if (!(await fillCity(page, dest, toName, opts.typingDelay, steps, 'destino'))) {
      report.status = 'error'; report.detail = `destino "${toName}" não selecionado`; return report;
    }
    await fillDate(dateEl, date, opts.typingDelay, steps);
    if (await checkBlocked('autocomplete', true)) return report;

    const button = await firstVisible([page.getByRole('button', { name: SEARCH_RE }), page.getByRole('link', { name: SEARCH_RE }),
      page.locator('input[type=submit], button[type=submit]')]);
    if (!button) { report.status = 'error'; report.detail = 'botão de pesquisa não achado'; return report; }

    // 15–30 s entre páginas: conta desde que a raiz abriu (o tempo de preencher entra na pausa).
    const wait = openedAt + rand(opts.pause) - Date.now();
    if (wait > 0) { log(`  … ${(wait / 1000).toFixed(1)} s antes de pesquisar`); await sleep(wait); }
    if (!(await opts.takePage())) { report.status = 'error'; report.detail = 'limite diário de páginas (antes de pesquisar)'; return report; }
    report.pages++;

    // 3) Pesquisa.
    phase = 'search';
    const beforeUrl = page.url();
    const searchedAt = Date.now();
    await button.click();
    const timedOut = await settle();
    steps.push({ at: Date.now() - searchedAt, step: 'pesquisa', ok: !timedOut, info: `URL ${redactWrUrl(beforeUrl)} → ${redactWrUrl(page.url())}` });
    await Promise.all(tasks);
    report.resultUrl = redactWrUrl(page.url());
    const searchNet = net.filter((r) => r.phase === 'search');
    report.xhrDuringSearch = searchNet.filter((r) => r.type === 'xhr' || r.type === 'fetch').length;
    const main = searchNet.find((r) => r.navigation && r.type === 'document')
      ?? searchNet.find((r) => (r.type === 'xhr' || r.type === 'fetch') && r.method !== 'GET')
      ?? searchNet.find((r) => r.type === 'xhr' || r.type === 'fetch');
    if (main) report.searchRequest = { method: main.method, url: main.url, type: main.type, postFields: main.postFields ?? [] };

    await fs.writeFile(path.join(dir, 'results.html'), redactHtml(await page.content())).catch(() => {});
    await page.screenshot({ path: path.join(dir, 'results.png'), fullPage: true }).catch(() => {});
    const res = (await page.evaluate(DUMP_RESULTS)) as ResultsDump;
    await fs.writeFile(path.join(dir, 'dom.json'), JSON.stringify(redactJsonKeys(res), null, 2));
    if (await checkBlocked('pesquisa', res.cards.length > 0)) return report;
    report.cards = res.cards.length;
    report.dateTabs = [...new Set(res.tabs.map((t) => t.text))];
    report.idCandidates = redactJsonKeys([...new Set(res.cards.flatMap((c) => [...c.attrs, ...c.inner])
      .filter((a) => /(^| )(id|data-[\w-]+|onclick|value|href)=/.test(a) && /\d{3,}/.test(a)))].slice(0, 30));
    report.status = report.cards > 0 ? 'ok' : 'empty';

    // 4) Aba do dia seguinte: troca por XHR (mesma página) ou navega?
    if (opts.tryTab) {
      const next = brDate(addDays(date, 1)).slice(0, 5); // "11/10"
      const tab = await firstVisible([page.locator('a, button, [role=tab], li, [onclick]').filter({ hasText: next })]);
      if (!tab) steps.push({ at: 0, step: 'aba', ok: false, info: `aba "${next}" não achada` });
      else {
        const p = rand(opts.pause);
        log(`  … pausa de ${(p / 1000).toFixed(1)} s antes da aba ${next}`);
        await sleep(p);
        if (!(await opts.takePage())) { steps.push({ at: 0, step: 'aba', ok: false, info: 'limite diário de páginas' }); }
        else {
          report.pages++;
          phase = 'tab';
          const tabAt = Date.now();
          await tab.click();
          await settle();
          await Promise.all(tasks);
          const tabNet = net.filter((r) => r.phase === 'tab');
          report.tabSwitch = tabNet.some((r) => r.navigation && r.type === 'document') ? 'navigation'
            : tabNet.some((r) => r.type === 'xhr' || r.type === 'fetch') ? 'xhr' : 'none';
          const tabRes = (await page.evaluate(DUMP_RESULTS)) as ResultsDump;
          if (await checkBlocked('aba', tabRes.cards.length > 0)) return report;
          report.tabCards = tabRes.cards.length;
          await fs.writeFile(path.join(dir, 'tab_dom.json'), JSON.stringify(redactJsonKeys(tabRes), null, 2));
          await fs.writeFile(path.join(dir, 'tab.html'), redactHtml(await page.content())).catch(() => {});
          await page.screenshot({ path: path.join(dir, 'tab.png'), fullPage: true }).catch(() => {});
          steps.push({ at: Date.now() - tabAt, step: 'aba', ok: true, info: `${next}: ${report.tabSwitch}, ${report.tabCards} cards` });
          // Na Parte 2, se for "xhr", a página pode percorrer os 5 dias sem novo carregamento.
          // O orçamento conta a aba como página nos dois casos (conservador).
        }
      }
    }
  } catch (e) {
    report.status = report.status === 'blocked' ? 'blocked' : 'error';
    report.detail = report.detail ?? (e as Error).message.split('\n')[0];
  } finally {
    report.waitedMs = Date.now() - t0;
    await Promise.all(tasks).catch(() => {});
    await fs.writeFile(path.join(dir, 'requests.json'), JSON.stringify(net, null, 2)).catch(() => {});
    await fs.writeFile(path.join(dir, 'steps.json'), JSON.stringify(steps, null, 2)).catch(() => {});
    await page.close().catch(() => {});
  }
  return report;
}
