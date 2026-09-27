import type { Page } from 'playwright';

/** Respostas que contam como bloqueio (regra do CLAUDE.md: parar e não insistir). */
export const BLOCK_STATUSES = new Set([401, 403, 429]);

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
