import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext } from 'playwright';

export const COLLECTOR_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE_DIR = path.join(COLLECTOR_DIR, '.profile');

/** Arquivos de estado local (trava, pausa, contador de páginas). COLLECTOR_STATE_DIR só nos testes. */
export function stateFile(name: string): string {
  return path.join(process.env.COLLECTOR_STATE_DIR || COLLECTOR_DIR, name);
}

/**
 * Chrome instalado + perfil persistente (ver CLAUDE.md).
 * BROWSER_EXECUTABLE troca o Chrome por outro binário (útil só fora do PC do Ricardo).
 */
export async function openBrowser({ headless }: { headless: boolean }): Promise<BrowserContext> {
  const executablePath = process.env.BROWSER_EXECUTABLE || undefined;
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    ...(executablePath ? { executablePath } : { channel: process.env.BROWSER_CHANNEL || 'chrome' }),
    locale: 'pt-BR',
    timezoneId: 'America/Bahia',
    viewport: { width: 1366, height: 768 },
  });
}
