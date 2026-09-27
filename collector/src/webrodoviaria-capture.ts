import fs from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext, Page, Request } from 'playwright';
import { COLLECTOR_DIR } from './browser.js';
import { BLOCK_STATUSES, looksBlocked } from './sources/blocking.js';
import { redactUrl } from './sources/queropassagem.js';

// Spike da Fase 5c: sites de venda da Rota e da Cidade Sol (plataforma "Venda Web" da webrodoviaria).
// Não sabemos ainda o HTML do formulário: o spike preenche por heurística (como um usuário) e
// grava tudo o que precisa para ajustarmos depois: campos do formulário, passos, rede e resultado.
// Só observa a página: nada de chamar endpoint direto nem reaproveitar sessão fora dela.

export const OUT_ROOT = path.join(COLLECTOR_DIR, 'output', 'webrodoviaria');
const WAIT_MS = 45_000;

export interface Site { source: string; label: string; base: string }
export interface WrLeg { from: string; to: string }   // nomes como na plataforma: "SALVADOR - BA"

export interface NetEntry {
  seq: number;
  kind: string;                 // document | xhr | fetch
  method: string;
  url: string;                  // tokens ocultados
  postData?: string;            // idem, truncado
  status?: number;
  contentType?: string;
  size?: number | null;
  file?: string;
  phase: string;                // home | search | tab
}

export interface WrReport {
  source: string;
  leg: string;
  status: 'ok' | 'empty' | 'blocked' | 'error' | 'form-not-found';
  detail?: string;
  steps: string[];
  pages: number;                // carregamentos de página (documento) usados
  resultUrl?: string;
  cards: number;
  tab: { tried: boolean; label?: string; via?: 'xhr' | 'navigation' | 'none'; cards?: number; changed?: boolean };
  formMethod?: string | null;
  formAction?: string | null;
  xhrCount: number;
  jsonResponses: number;
  dir: string;
}

// ---------------------------------------------------------------------------
// Ocultação: sessão/estado de formulário (ViewState, CSRF, JSESSIONID…) não vai para arquivo.
// ---------------------------------------------------------------------------

const SENSITIVE_KEY = /(token|csrf|viewstate|eventvalidation|session|jsession|auth|cookie|captcha|__requestverification)/i;

/** "a=1&javax.faces.ViewState=xyz" → oculta valores sensíveis ou muito longos. */
export function redactForm(body: string): string {
  const trimmed = body.slice(0, 4000);
  if (/^[\[{]/.test(trimmed.trim())) {
    try { return JSON.stringify(redactJson(JSON.parse(body))).slice(0, 4000); } catch { /* segue como texto */ }
  }
  return redactUrl(trimmed.split('&').map((pair) => {
    const [k = '', v = ''] = pair.split('=');
    const key = decodeURIComponent(k.replace(/\+/g, ' '));
    return SENSITIVE_KEY.test(key) || v.length > 60 ? `${k}=<redacted>` : pair;
  }).join('&')).url;
}

export function redactJson<T>(v: T, key = ''): T {
  if (typeof v === 'string') return (SENSITIVE_KEY.test(key) || v.length > 200 ? '<redacted>' : redactUrl(v).url) as T;
  if (Array.isArray(v)) return v.map((x) => redactJson(x, key)) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactJson(x, k)])) as T;
  return v;
}

/** Oculta strings com cara de token (40+ caracteres sem espaço) em qualquer lugar de um JSON. */
export function redactTokenLike<T>(v: T): T {
  if (typeof v === 'string') return (/^\S{40,}$/.test(v) && !/^https?:\/\//.test(v) ? '<redacted>' : v) as T;
  if (Array.isArray(v)) return v.map((x) => redactTokenLike(x)) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactTokenLike(x)])) as T;
  return v;
}

/** HTML sem valores de campos ocultos longos (ViewState etc.) nem tokens. */
export function redactHtml(html: string): string {
  return redactUrl(html.replace(/(<input[^>]*type=["']?hidden["']?[^>]*value=["'])([^"']{40,})(["'])/gi, '$1<redacted>$3')
    .replace(/(<input[^>]*value=["'])([^"']{40,})(["'][^>]*type=["']?hidden)/gi, '$1<redacted>$3')).url;
}

// ---------------------------------------------------------------------------
// Scripts que rodam na página (texto puro: o tsx injeta __name em funções TS).
// ---------------------------------------------------------------------------

/** Lista os campos visíveis do formulário e marca cada um com data-cx-idx. */
const DUMP_FIELDS = `(() => {
  const vis = (el) => !!(el.offsetParent || el.getClientRects().length);
  // Valor de input só para botões; nunca de campo oculto (ViewState, tokens).
  const text = (el) => {
    const isBtn = el.tagName === 'BUTTON' || /^(submit|button)$/i.test(el.getAttribute('type') || '');
    const raw = el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA'
      ? (isBtn ? el.value : '') : el.innerText;
    return (raw || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  };
  const labelOf = (el) => {
    if (el.labels && el.labels[0]) return text(el.labels[0]);
    const l = el.closest('label'); if (l) return text(l);
    let prev = el.previousElementSibling;
    while (prev && /^(INPUT|SELECT|TEXTAREA|SCRIPT)$/.test(prev.tagName)) prev = prev.previousElementSibling;
    return prev ? text(prev) : '';
  };
  const out = [];
  let i = 0;
  for (const el of Array.from(document.querySelectorAll('input, select, textarea, button, a[role=button], [onclick]'))) {
    if (!vis(el)) continue;
    el.setAttribute('data-cx-idx', String(i));
    const f = el.form;
    out.push({ idx: i++, tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '', name: el.getAttribute('name') || '',
      id: el.id || '', placeholder: el.getAttribute('placeholder') || '', aria: el.getAttribute('aria-label') || '',
      cls: String(el.className || '').slice(0, 80), label: labelOf(el), text: el.tagName === 'SELECT' ? '' : text(el),
      readonly: !!el.readOnly,
      options: el.tagName === 'SELECT' ? Array.from(el.options).slice(0, 60).map((o) => o.text.trim()) : undefined,
      formMethod: f ? (f.getAttribute('method') || 'get') : null, formAction: f ? f.getAttribute('action') : null });
    if (i >= 200) break;
  }
  return out;
})()`;

/** Cards com horário e preço (elemento mais interno), com atributos data-* (candidatos a id). */
const DUMP_CARDS = `(() => {
  const hasTime = /\\b\\d{2}:\\d{2}\\b/, hasPrice = /R\\$\\s?\\d/;
  const m = (el) => { const t = el.innerText || ''; return hasTime.test(t) && hasPrice.test(t); };
  const out = [];
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    if (!m(el) || Array.from(el.children).some((c) => m(c))) continue;
    const attrs = {};
    for (const a of Array.from(el.attributes)) if (a.name.startsWith('data-') || a.name === 'id') attrs[a.name] = a.value.slice(0, 80);
    let p = el.parentElement, depth = 0;
    while (p && depth < 3) { for (const a of Array.from(p.attributes)) if (a.name.startsWith('data-') || a.name === 'id') attrs['^' + depth + ':' + a.name] = a.value.slice(0, 80); p = p.parentElement; depth++; }
    out.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 100), attrs,
      text: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 300) });
    if (out.length >= 100) break;
  }
  return out;
})()`;

/** Define o valor de um campo e dispara input/change (datepicker só-leitura). Recebe [idx, valor]. */
const SET_VALUE = `(args) => {
  const el = document.querySelector('[data-cx-idx="' + args[0] + '"]');
  if (!el) return false;
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  el.removeAttribute('readonly');
  setter.call(el, args[1]);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));
  return true;
}`;

interface Field {
  idx: number; tag: string; type: string; name: string; id: string; placeholder: string; aria: string;
  cls: string; label: string; text: string; readonly: boolean; options?: string[];
  formMethod: string | null; formAction: string | null;
}

const describe = (f: Field) => [f.name, f.id, f.placeholder, f.aria, f.label, f.cls].join(' ').toLowerCase();
const isInput = (f: Field) => ['input', 'select', 'textarea'].includes(f.tag) && !['hidden', 'submit', 'button', 'checkbox', 'radio'].includes(f.type);

/** Heurística: qual campo é origem, destino, data e qual botão pesquisa. */
export function pickFields(fields: Field[]) {
  const inputs = fields.filter(isInput);
  const find = (re: RegExp, exclude: Field[] = []) => inputs.find((f) => re.test(describe(f)) && !exclude.includes(f));
  const origin = find(/origem|origin|partida|saida|saída|\bde\b|from/);
  const dest = find(/destino|destination|chegada|\bpara\b|\bto\b/, origin ? [origin] : []);
  const date = find(/data|date|ida|dia|embarque/, [origin, dest].filter(Boolean) as Field[])
    ?? inputs.find((f) => f.type === 'date');
  const submit = fields.find((f) => !isInput(f) && /pesquis|busc|consult|procur|search/i.test(`${f.text} ${f.aria} ${f.id} ${f.name}`));
  return { origin, dest, date, submit };
}

// ---------------------------------------------------------------------------

async function fillCity(page: Page, f: Field, city: string, steps: string[]): Promise<boolean> {
  const loc = page.locator(`[data-cx-idx="${f.idx}"]`);
  if (f.tag === 'select') {
    const opt = f.options?.find((o) => o.toUpperCase().includes(city.toUpperCase()));
    if (!opt) { steps.push(`select ${f.name || f.id}: opção "${city}" não encontrada`); return false; }
    await loc.selectOption({ label: opt });
    steps.push(`select ${f.name || f.id} = "${opt}"`);
    return true;
  }
  const full = city.split(' - ')[0]!;                       // "SALVADOR - BA" → "SALVADOR"
  // Digita só o começo (como uma pessoa, e com menos chamadas de autocomplete); completa se preciso.
  const chunks = [full.slice(0, 6), full.slice(6)].filter(Boolean);
  await loc.click();
  await loc.fill('');
  // Sugestão do autocomplete: elemento visível com o nome completo, que não seja o próprio campo.
  const sug = page.locator('li, [role=option], .ui-menu-item, .autocomplete-suggestion, .dropdown-item, .tt-suggestion, a, span, div')
    .filter({ hasText: new RegExp(city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') })
    .filter({ hasNot: page.locator(`[data-cx-idx="${f.idx}"]`) });
  let typed = '';
  for (const chunk of chunks) {
    await loc.pressSequentially(chunk, { delay: 110 });
    typed += chunk;
    await page.waitForTimeout(1_800);
    const n = await sug.count();
    for (let i = n - 1; i >= 0 && i >= n - 15; i--) {       // o mais interno costuma vir por último
      const s = sug.nth(i);
      if (await s.isVisible().catch(() => false)) {
        const txt = (await s.innerText().catch(() => '')).trim().slice(0, 60);
        if (txt.length > city.length + 40) continue;        // container grande demais
        await s.click().catch(() => {});
        steps.push(`campo ${f.name || f.id || f.placeholder}: digitou "${typed}", clicou sugestão "${txt}"`);
        await page.waitForTimeout(600);
        return true;
      }
    }
  }
  await loc.press('ArrowDown').catch(() => {});
  await loc.press('Enter').catch(() => {});
  steps.push(`campo ${f.name || f.id || f.placeholder}: digitou "${typed}", sem sugestão visível (tentou ↓ + Enter)`);
  return true;
}

async function fillDate(page: Page, f: Field, date: string, steps: string[]): Promise<void> {
  const [y, m, d] = date.split('-');
  const value = f.type === 'date' ? date : `${d}/${m}/${y}`;
  const loc = page.locator(`[data-cx-idx="${f.idx}"]`);
  try {
    await loc.fill(value, { timeout: 3_000 });
    steps.push(`data ${f.name || f.id}: preencheu "${value}"`);
  } catch {
    await page.evaluate(`(${SET_VALUE})(${JSON.stringify([f.idx, value])})`);
    steps.push(`data ${f.name || f.id}: campo só-leitura; valor definido por script "${value}"`);
  }
  await page.keyboard.press('Escape').catch(() => {});      // fecha o calendário, se abriu
}

export interface CaptureOpts { waitMs?: number; takePage: () => Promise<boolean>; pause: () => Promise<void> }

/**
 * Um trecho numa viação: abre a Venda Web, pesquisa, grava rede + resultado e tenta a aba do
 * dia seguinte (para saber se troca por XHR). Devolve o relatório; nunca lança.
 */
export async function captureWrLeg(ctx: BrowserContext, site: Site, leg: WrLeg, date: string,
  outRoot: string, opts: CaptureOpts): Promise<WrReport> {
  const WAIT = opts.waitMs ?? WAIT_MS;
  const slug = (s: string) => s.split(' - ')[0]!.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const dir = path.join(outRoot, site.source, date, `${slug(leg.from)}_${slug(leg.to)}`);
  await fs.mkdir(dir, { recursive: true });
  const r: WrReport = { source: site.source, leg: `${leg.from} → ${leg.to}`, status: 'error', steps: [], pages: 0,
    cards: 0, tab: { tried: false }, xhrCount: 0, jsonResponses: 0, dir };
  const net: NetEntry[] = [];
  const pending: Promise<void>[] = [];
  let phase = 'home';
  let seq = 0;
  let blockedStatus: number | null = null;
  const page = await ctx.newPage();

  page.on('response', (resp) => {
    const req: Request = resp.request();
    const kind = req.resourceType();
    if (!['document', 'xhr', 'fetch'].includes(kind)) return;
    const n = ++seq;
    const e: NetEntry = { seq: n, kind, method: req.method(), url: redactUrl(req.url()).url, phase, status: resp.status(),
      contentType: resp.headers()['content-type'] ?? '' };
    const post = req.postData();
    if (post) e.postData = redactForm(post);
    // Página inteira: 401/403/429. XHR: só 403/429 (a plataforma pode responder 401 em chamadas
    // que exigem login, como o mapa de poltronas, sem que isso seja bloqueio).
    if (kind === 'document' ? BLOCK_STATUSES.has(resp.status()) : [403, 429].includes(resp.status())) blockedStatus = resp.status();
    net.push(e);
    if (kind === 'document') return;
    pending.push((async () => {
      const body = await resp.body().catch(() => null);
      e.size = body?.length ?? null;
      if (!body || body.length > 800_000) return;
      const txt = body.toString('utf8');
      if ((e.contentType ?? '').includes('json') || /^\s*[\[{]/.test(txt)) {
        try {
          e.file = `${String(n).padStart(2, '0')}_${e.phase}.json`;
          await fs.writeFile(path.join(dir, e.file), JSON.stringify(redactJson(JSON.parse(txt)), null, 2));
          return;
        } catch { /* não era JSON */ }
      }
      e.file = `${String(n).padStart(2, '0')}_${e.phase}.txt`;
      await fs.writeFile(path.join(dir, e.file), redactHtml(txt));
    })());
  });

  const dump = async (name: string) => {
    const cards = (await page.evaluate(DUMP_CARDS).catch(() => [])) as unknown[];
    await fs.writeFile(path.join(dir, `${name}.cards.json`), JSON.stringify(cards, null, 2));
    await fs.writeFile(path.join(dir, `${name}.html`), redactHtml(await page.content().catch(() => '')));
    await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true }).catch(() => {});
    return cards.length;
  };

  try {
    // 1) Venda Web (página inicial da viação)
    if (!(await opts.takePage())) { r.status = 'error'; r.detail = 'limite diário de páginas'; return r; }
    r.pages++;
    const nav = await page.goto(site.base, { waitUntil: 'domcontentloaded', timeout: WAIT });
    if (nav && BLOCK_STATUSES.has(nav.status())) { r.status = 'blocked'; r.detail = `início devolveu HTTP ${nav.status()}`; return r; }
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(2_000 + Math.random() * 3_000);

    const fields = (await page.evaluate(DUMP_FIELDS)) as Field[];
    await fs.writeFile(path.join(dir, 'form.fields.json'), JSON.stringify(redactTokenLike(fields), null, 2));
    const pick = pickFields(fields);
    r.formMethod = pick.origin?.formMethod ?? null;
    r.formAction = pick.origin?.formAction ?? null;
    r.steps.push(`campos: origem=${pick.origin?.idx ?? '?'} destino=${pick.dest?.idx ?? '?'} data=${pick.date?.idx ?? '?'} botão=${pick.submit?.idx ?? '?'}`);
    if (!pick.origin || !pick.dest || !pick.submit) {
      r.status = 'form-not-found';
      r.detail = 'não achei origem/destino/botão; veja form.fields.json e home.png';
      await dump('home');
      return r;
    }

    // 2) Preenche e pesquisa
    await fillCity(page, pick.origin, leg.from, r.steps);
    await fillCity(page, pick.dest, leg.to, r.steps);
    if (pick.date) await fillDate(page, pick.date, date, r.steps);
    else r.steps.push('campo de data não identificado (segue com a data padrão do site)');
    await page.waitForTimeout(800 + Math.random() * 1_200);

    if (!(await opts.takePage())) { r.status = 'error'; r.detail = 'limite diário de páginas'; return r; }
    r.pages++;
    phase = 'search';
    await page.locator(`[data-cx-idx="${pick.submit.idx}"]`).click();
    r.steps.push(`clicou "${pick.submit.text || pick.submit.id}"`);
    await page.waitForLoadState('domcontentloaded', { timeout: WAIT }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(2_000);
    await Promise.all(pending);
    r.resultUrl = redactUrl(page.url()).url;
    if (blockedStatus) { r.status = 'blocked'; r.detail = `HTTP ${blockedStatus} na busca`; await dump('results'); return r; }
    r.cards = await dump('results');
    const marker = await looksBlocked(page);
    if (marker && r.cards === 0) { r.status = 'blocked'; r.detail = marker; return r; }
    r.status = r.cards > 0 ? 'ok' : 'empty';

    // 3) Aba do dia seguinte: troca por XHR ou recarrega a página?
    const [y, m, d] = date.split('-').map(Number) as [number, number, number];
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    const label = `${String(next.getUTCDate()).padStart(2, '0')}/${String(next.getUTCMonth() + 1).padStart(2, '0')}`;
    const tab = page.getByText(label, { exact: false }).filter({ hasNotText: /\d{2}:\d{2}/ }).first();
    if (r.cards > 0 && await tab.isVisible().catch(() => false)) {
      await opts.pause();
      const docsBefore = net.filter((x) => x.kind === 'document').length;
      const xhrBefore = net.filter((x) => x.kind !== 'document').length;
      phase = 'tab';
      if (!(await opts.takePage())) { r.steps.push('aba não testada: limite diário'); }
      else {
        r.pages++;
        const firstBefore = JSON.stringify(((await page.evaluate(DUMP_CARDS)) as unknown[])[0] ?? null);
        await tab.click().catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
        await page.waitForTimeout(2_000);
        await Promise.all(pending);
        const docs = net.filter((x) => x.kind === 'document').length - docsBefore;
        const xhrs = net.filter((x) => x.kind !== 'document').length - xhrBefore;
        const cards = await dump('tab');
        const firstAfter = JSON.stringify(((await page.evaluate(DUMP_CARDS).catch(() => [])) as unknown[])[0] ?? null);
        r.tab = { tried: true, label, via: docs > 0 ? 'navigation' : xhrs > 0 ? 'xhr' : 'none', cards, changed: firstAfter !== firstBefore };
        if (docs === 0) r.pages--; // troca sem recarregar não conta como página nova
        r.steps.push(`aba "${label}": ${r.tab.via}, ${cards} cards, mudou=${r.tab.changed}`);
        if (blockedStatus) { r.status = 'blocked'; r.detail = `HTTP ${blockedStatus} na aba`; }
      }
    } else {
      r.steps.push(`aba "${label}" não encontrada`);
    }
  } catch (e) {
    r.status = 'error';
    r.detail = (e as Error).message.split('\n')[0];
    await dump('error').catch(() => 0);
  } finally {
    await Promise.all(pending).catch(() => {});
    r.xhrCount = net.filter((x) => x.kind !== 'document').length;
    r.jsonResponses = net.filter((x) => x.file?.endsWith('.json')).length;
    await fs.writeFile(path.join(dir, 'network.json'), JSON.stringify(net, null, 2)).catch(() => {});
    await fs.writeFile(path.join(dir, 'steps.json'), JSON.stringify(r, null, 2)).catch(() => {});
    await page.close().catch(() => {});
  }
  return r;
}
