import { loadEnv } from './env.js';
import { watchAlertMessage } from './notify/alerts.js';
import { sendTelegram, telegramFromEnv } from './notify/telegram.js';
import { Store } from './store.js';

// Avalia as datas monitoradas e manda os avisos no Telegram (preço-alvo, assentos acabando).
//   npm run alerts
// Só lê o banco (nenhum site é aberto). Cada aviso vai para o chat do alerta ou, se vazio,
// para TELEGRAM_CHAT_ID. Só é marcado como enviado depois de o Telegram confirmar.

async function main() {
  loadEnv();
  const store = Store.fromEnv();
  if (!store) throw new Error('SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes no .env');
  const tg = telegramFromEnv();
  const token = tg?.token ?? process.env.TELEGRAM_BOT_TOKEN?.trim();
  const appUrl = process.env.APP_URL?.trim() || undefined;

  const alerts = await store.evaluateAlerts();
  if (!alerts.length) return console.log('Nenhum alerta a enviar.');
  let sent = 0, skipped = 0, failed = 0;
  for (const a of alerts) {
    const chatId = a.telegram_chat_id ?? tg?.chatId;
    const label = `#${a.watch_id} ${a.kind} ${a.origin_city} → ${a.dest_city} ${a.travel_date}`;
    if (!token || !chatId) { console.warn(`⚠ ${label}: sem bot/chat do Telegram; não enviado.`); skipped++; continue; }
    try {
      await sendTelegram({ token, chatId }, watchAlertMessage(a, appUrl));
      await store.markAlert(a);
      console.log(`✓ ${label}: enviado`);
      sent++;
    } catch (e) {
      // Não marca: tenta de novo na próxima vez.
      console.error(`✗ ${label}: ${(e as Error).message}`);
      failed++;
    }
  }
  console.log(`Alertas: ${sent} enviado(s), ${skipped} sem destino, ${failed} com erro.`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`erro: ${(e as Error).message}`);
  process.exitCode = 1;
});
