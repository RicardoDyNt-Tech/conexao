import { describe, expect, it, vi } from 'vitest';
import {
  blockedMessage, makeNotifier, roundFailedMessage, roundProblemsMessage, sendTelegram, telegramFromEnv,
} from '../src/notify/telegram.js';
import type { RoundEntry } from '../src/runner.js';

const base = { source: 'clickbus', trips: [], found: 0, warnings: [], started_at: '', finished_at: '' };
const ok = (from: string, to: string, date = '2026-10-05'): RoundEntry => ({ ...base, from, to, date, status: 'ok', found: 10 });
const empty = (from: string, to: string, date = '2026-10-05'): RoundEntry => ({ ...base, from, to, date, status: 'empty' });
const err = (from: string, to: string, error: string, date = '2026-10-05'): RoundEntry =>
  ({ ...base, from, to, date, status: 'error', error });
const blocked = (from: string, to: string, date = '2026-10-05'): RoundEntry =>
  ({ ...base, from, to, date, status: 'blocked', error: 'v6/trips devolveu HTTP 403' });
const skipped = (from: string, to: string, date = '2026-10-05'): RoundEntry =>
  ({ source: 'clickbus', from, to, date, status: 'skipped' });

describe('mensagens do Telegram', () => {
  it('rodada sem problema → nenhuma mensagem', () => {
    expect(roundProblemsMessage([ok('a', 'b'), empty('b', 'c')], { label: 'rodada das 07:00' })).toBeNull();
  });

  it('rodada com erro lista os trechos', () => {
    const msg = roundProblemsMessage(
      [ok('a', 'b'), empty('b', 'c'), err('salvador-ba', 'catu-ba', 'v6/trips não chegou em 30 s')],
      { label: 'rodada das 07:00' })!;
    expect(msg).toBe([
      '⚠️ Conexão: rodada das 07:00 com problemas',
      '1 ok · 1 sem viagens · 1 com erro · 0 bloqueado',
      'Erros:',
      '• salvador-ba → catu-ba (05/10): v6/trips não chegou em 30 s',
    ].join('\n'));
  });

  it('bloqueio: mostra o trecho e quantos não rodaram', () => {
    const msg = roundProblemsMessage(
      [ok('a', 'b'), blocked('feira-de-santana-todos', 'salvador-ba'), skipped('x', 'y'), skipped('y', 'z')],
      { label: 'rodada das 19:00' })!;
    expect(msg).toContain('1 ok · 0 sem viagens · 0 com erro · 1 bloqueado · 2 não rodaram');
    expect(msg).toContain('Bloqueio em feira-de-santana-todos → salvador-ba (05/10): rodada interrompida.');
  });

  it('só falha de gravação no banco também avisa', () => {
    expect(roundProblemsMessage([ok('a', 'b')], { label: 'rodada das 07:00', dbFailures: 2 }))
      .toContain('Falha ao gravar no banco: 2 trecho(s).');
  });

  it('muitos erros: lista 5 e resume o resto', () => {
    const errors = Array.from({ length: 8 }, (_, i) => err(`o${i}`, `d${i}`, 'timeout'));
    const msg = roundProblemsMessage(errors, { label: 'rodada das 07:00' })!;
    expect(msg.split('\n').filter((l) => l.startsWith('• o'))).toHaveLength(5);
    expect(msg).toContain('• e mais 3');
  });

  it('mensagem imediata de bloqueio', () => {
    expect(blockedMessage({ from: 'salvador-ba', to: 'catu-ba', date: '2026-10-05', error: 'HTTP 403' })).toBe([
      '⛔ Conexão: ClickBus bloqueou a coleta',
      'Trecho: salvador-ba → catu-ba (05/10)',
      'Motivo: HTTP 403',
      'A rodada parou (não insistimos). Próxima tentativa no próximo horário agendado.',
    ].join('\n'));
  });

  it('falha da rodada inteira', () => {
    expect(roundFailedMessage('rodada das 07:00', new Error('route_hubs: fetch failed')))
      .toBe('❌ Conexão: rodada das 07:00 falhou\nroute_hubs: fetch failed');
  });

  it('mensagem longa é cortada abaixo do limite do Telegram', () => {
    expect(roundFailedMessage('x', 'a'.repeat(10_000)).length).toBeLessThanOrEqual(4000);
  });
});

describe('envio', () => {
  const cfg = { token: '123:SECRET', chatId: '42' };

  it('configuração vem do .env; incompleta → null', () => {
    expect(telegramFromEnv({ TELEGRAM_BOT_TOKEN: '1:a', TELEGRAM_CHAT_ID: ' 9 ' })).toEqual({ token: '1:a', chatId: '9' });
    expect(telegramFromEnv({ TELEGRAM_BOT_TOKEN: '1:a' })).toBeNull();
  });

  it('chama sendMessage com chat_id e texto', async () => {
    const f = vi.fn(async () => new Response('{"ok":true}'));
    await sendTelegram(cfg, 'Conexão: Telegram OK', f as unknown as typeof fetch);
    const [url, init] = f.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/bot123:SECRET/sendMessage');
    expect(JSON.parse(init.body as string)).toMatchObject({ chat_id: '42', text: 'Conexão: Telegram OK' });
  });

  it('erro não vaza o token', async () => {
    const f = vi.fn(async () => new Response('bad token 123:SECRET', { status: 401 }));
    const e = await sendTelegram(cfg, 'x', f as unknown as typeof fetch).catch((x: Error) => x);
    expect((e as Error).message).toContain('HTTP 401');
    expect((e as Error).message).not.toContain('SECRET');
  });

  it('sem configuração: não envia e avisa uma vez só', async () => {
    const warn = vi.fn();
    const notify = makeNotifier(null, warn);
    await notify('a'); await notify('b');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
