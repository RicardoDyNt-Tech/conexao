import { redactUrl } from './queropassagem.js';

// Venda Web da webrodoviaria: plataforma de venda própria das viações (Rota e Cidade Sol usam a
// mesma). Por enquanto só o necessário para o spike (Fase 5c, Parte 1); o parser entra na Parte 2,
// depois de vermos o que a página recebe de verdade.
// Regras do CLAUDE.md valem igual: o coletor preenche o formulário como um usuário e só LÊ o que a
// página recebe. Nada de montar POST, reaproveitar sessão/ViewState ou chamar endpoint fora dela.

export interface Viacao {
  /** Valor de trips.source (e do arquivo de quarentena). */
  source: 'rota' | 'cidadesol';
  /** Nome exibido no app ("Comprar no site da ..."). */
  name: string;
  /** Raiz da Venda Web: abre o formulário de busca. */
  baseUrl: string;
}

export const VIACOES: Record<Viacao['source'], Viacao> = {
  rota: { source: 'rota', name: 'Rota', baseUrl: 'https://rotatransportes.webrodoviaria.com.br/VendaWebRotaTransportes/' },
  cidadesol: { source: 'cidadesol', name: 'Cidade Sol', baseUrl: 'https://cidadedosol.webrodoviaria.com.br/VendaWebCidadeDoSol/' },
};

export function viacao(source: string): Viacao {
  const v = VIACOES[source as Viacao['source']];
  if (!v) throw new Error(`viação desconhecida: ${source} (use ${Object.keys(VIACOES).join(' | ')})`);
  return v;
}

/** "Feira de Santana - BA" ≈ "FEIRA DE SANTANA - BA" ≈ "feira de santana-ba". */
export function normalizeName(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/\s*-\s*/g, ' - ').replace(/\s+/g, ' ').trim();
}

/** O que digitar no campo para o autocomplete aparecer: o nome sem a UF ("CATU - BA" → "CATU"). */
export function typedQuery(cityName: string): string {
  return normalizeName(cityName).split(' - ')[0]!;
}

/** Texto de uma sugestão/opção corresponde à cidade? Aceita "CATU - BA", "Catu/BA", "CATU (BA)". */
export function matchesCity(text: string, cityName: string): boolean {
  const key = (x: string) => normalizeName(x).replace(/[-/()]/g, ' ').replace(/\s+/g, ' ').trim();
  return key(text) === key(cityName);
}

/** AAAA-MM-DD → DD/MM/AAAA (formato dos campos de data da plataforma, a confirmar no spike). */
export function brDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) throw new Error(`data inválida: ${iso}`);
  return `${d}/${m}/${y}`;
}

/** AAAA-MM-DD + n dias → AAAA-MM-DD (datas de calendário, sem fuso). */
export function addDays(iso: string, n: number): string {
  const t = Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Ocultação: nada de sessão, ViewState, CSRF ou token em arquivo/log (CLAUDE.md).
// ---------------------------------------------------------------------------

/** Nomes de campo/parâmetro cujo valor é estado de sessão ou anti-bot. */
const SENSITIVE_NAME = /viewstate|eventvalidation|token|csrf|xsrf|session|sessid|nonce|captcha|recaptcha|auth|signature|^sig$|secret|cookie|^key$|apikey|hash/i;

export const isSensitiveName = (name: string) => SENSITIVE_NAME.test(name);

/** "ViewState=abc", "csrfToken: 'abc'", "jsessionid=abc" soltos em JS/texto (ex.: onclick de abas). */
const INLINE_SECRET = /((?:javax\.faces\.)?viewstate|eventvalidation|csrf[\w-]*|xsrf[\w-]*|[\w.-]*token|jsessionid|sessionid|nonce)((?:%3D|["']?\s*[=:]\s*["']?))([^"'&\s<>;,)]{6,})/gi;

function redactInline(text: string): string {
  return text.replace(INLINE_SECRET, (_m, k: string, sep: string) => `${k}${sep}<token>`);
}

/** Oculta ;jsessionid=..., parâmetros sensíveis e JWT/base64 longo numa URL. */
export function redactWrUrl(url: string): string {
  let out = url.replace(/;jsessionid=[^?#/]*/gi, ';jsessionid=<token>');
  try {
    const u = new URL(out);
    for (const k of [...u.searchParams.keys()]) if (isSensitiveName(k)) u.searchParams.set(k, '<token>');
    out = u.toString().replace(/%3Ctoken%3E/g, '<token>');
  } catch { /* não é URL absoluta: segue só com as regex */ }
  return redactUrl(redactInline(out)).url;
}

/** Corpo de POST (form-urlencoded ou JSON): mantém os nomes, oculta valores sensíveis. */
export function redactPostData(data: string | null): string | null {
  if (data == null) return null;
  const trimmed = data.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { return JSON.stringify(redactJsonKeys(JSON.parse(trimmed))); } catch { /* segue como texto */ }
  }
  if (/^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(trimmed)) {
    return trimmed.split('&').map((pair) => {
      const i = pair.indexOf('=');
      const k = pair.slice(0, i), v = pair.slice(i + 1);
      let name = k;
      try { name = decodeURIComponent(k.replace(/\+/g, ' ')); } catch { /* nome cru */ }
      return `${k}=${isSensitiveName(name) ? '<token>' : redactUrl(v).url}`;
    }).join('&');
  }
  return redactUrl(redactInline(data)).url;
}

/** Nomes dos campos de um POST form-urlencoded (para saber o que o formulário manda). */
export function postFieldNames(data: string | null): string[] {
  if (!data || !/^[^=&\s]+=/.test(data.trim())) return [];
  return data.trim().split('&').map((p) => {
    const k = p.split('=')[0]!;
    try { return decodeURIComponent(k.replace(/\+/g, ' ')); } catch { return k; }
  });
}

/** JSON: oculta valores de chaves sensíveis e JWT/base64 em qualquer string. */
export function redactJsonKeys<T>(value: T): T {
  if (typeof value === 'string') return redactUrl(redactInline(value)).url as T;
  if (Array.isArray(value)) return value.map((v) => redactJsonKeys(v)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) =>
      [k, isSensitiveName(k) && v != null && typeof v !== 'object' ? '<token>' : redactJsonKeys(v)])) as T;
  }
  return value;
}

/**
 * HTML/XML (página inteira, fragmento ou partial-response do JSF): oculta o value de inputs
 * sensíveis (ViewState, CSRF...), blocos <update id="...ViewState..."> e jsessionid em links.
 */
export function redactHtml(html: string): string {
  return redactUrl(redactInline(html
    .replace(/<input\b[^>]*>/gi, (tag) => {
      const name = /\b(?:name|id)\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? '';
      return isSensitiveName(name) ? tag.replace(/\bvalue\s*=\s*(["'])[\s\S]*?\1/i, 'value="<token>"') : tag;
    })
    .replace(/(<update\b[^>]*id="[^"]*viewstate[^"]*"[^>]*>)[\s\S]*?(<\/update>)/gi, '$1<![CDATA[<token>]]>$2')
    .replace(/(<meta\b[^>]*name=["'][^"']*(?:csrf|token)[^"']*["'][^>]*content=)(["'])[^"']*\2/gi, '$1"<token>"')
    .replace(/;jsessionid=[^?#"'\s/<>]*/gi, ';jsessionid=<token>'))).url;
}
