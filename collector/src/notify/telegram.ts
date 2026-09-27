import type { LegResult } from '../types.js';
import type { RoundEntry } from '../runner.js';

const MAX_LEN = 4000;   // limite do Telegram é 4096
const MAX_ITEMS = 5;    // itens listados por mensagem; o resto vira "e mais N"

export interface TelegramConfig { token: string; chatId: string }

export function telegramFromEnv(env: NodeJS.ProcessEnv = process.env): TelegramConfig | null {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  return token && chatId ? { token, chatId } : null;
}

/** Envia texto simples (sem parse_mode, para não precisar escapar nada). Nunca expõe o token em erros. */
export async function sendTelegram(cfg: TelegramConfig, text: string, fetchFn: typeof fetch = fetch): Promise<void> {
  let res: Response;
  try {
    res = await fetchFn(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.chatId, text: truncate(text), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new Error(`Telegram inacessível: ${(e as Error).message.replaceAll(cfg.token, '***')}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Telegram HTTP ${res.status}: ${body.replaceAll(cfg.token, '***').slice(0, 200)}`);
  }
}

/** Notificador que vira no-op (com aviso único) quando o .env não tem o bot configurado. */
export function makeNotifier(cfg: TelegramConfig | null, log: (m: string) => void = console.warn) {
  let warned = false;
  return async (text: string) => {
    if (!cfg) {
      if (!warned) { log('⚠ TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID ausentes: aviso não enviado.'); warned = true; }
      return;
    }
    await sendTelegram(cfg, text);
  };
}

// ---------------------------------------------------------------------------
// Mensagens (funções puras, testadas)
// ---------------------------------------------------------------------------

function truncate(s: string): string {
  return s.length <= MAX_LEN ? s : `${s.slice(0, MAX_LEN - 1)}…`;
}
const ddmm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const legLabel = (e: { from: string; to: string; date: string }) => `${e.from} → ${e.to} (${ddmm(e.date)})`;

function list(items: string[]): string[] {
  const shown = items.slice(0, MAX_ITEMS).map((i) => `• ${i}`);
  if (items.length > MAX_ITEMS) shown.push(`• e mais ${items.length - MAX_ITEMS}`);
  return shown;
}

/**
 * Único aviso de um bloqueio: durante a pausa, rodadas e pedidos são pulados em silêncio.
 * `resumeAt` já formatado (ex.: "03/10 01:15").
 */
export function blockedMessage(r: Pick<LegResult, 'from' | 'to' | 'date' | 'error'>, resumeAt: string,
  hours: number, context = 'coleta'): string {
  return [
    `⛔ Conexão: ClickBus bloqueou a ${context}`,
    `Trecho: ${legLabel(r)}`,
    `Motivo: ${r.error ?? 'não informado'}`,
    `Coleta e pedidos pausados por ${hours} h, até ${resumeAt}. Sem novos avisos nesse período.`,
  ].join('\n');
}

export interface RoundMeta {
  label: string;          // ex.: "rodada das 07:00"
  dbFailures?: number;    // trechos que não conseguiram ser gravados no banco
}

/** Resumo da rodada, ou null se não houve problema (nada a avisar). */
export function roundProblemsMessage(entries: RoundEntry[], meta: RoundMeta): string | null {
  const count = (s: string) => entries.filter((e) => e.status === s).length;
  const errors = entries.filter((e) => e.status === 'error');
  const blocked = entries.filter((e) => e.status === 'blocked');
  const dbFailures = meta.dbFailures ?? 0;
  if (!errors.length && !blocked.length && !dbFailures) return null;

  const lines = [
    `⚠️ Conexão: ${meta.label} com problemas`,
    `${count('ok')} ok · ${count('empty')} sem viagens · ${errors.length} com erro · ${blocked.length} bloqueado` +
      (count('skipped') ? ` · ${count('skipped')} não rodaram` : ''),
  ];
  if (blocked.length) lines.push(`Bloqueio em ${legLabel(blocked[0]!)}: rodada interrompida.`);
  if (errors.length) {
    lines.push('Erros:', ...list(errors.map((e) => `${legLabel(e)}: ${'error' in e && e.error ? e.error : '?'}`)));
  }
  if (dbFailures) lines.push(`Falha ao gravar no banco: ${dbFailures} trecho(s).`);
  return truncate(lines.join('\n'));
}

export function roundFailedMessage(label: string, error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  return truncate(`❌ Conexão: ${label} falhou\n${msg}`);
}
