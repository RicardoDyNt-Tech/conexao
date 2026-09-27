import { loadEnv } from './env.js';
import { sendTelegram, telegramFromEnv } from './notify/telegram.js';

loadEnv();
const cfg = telegramFromEnv();
if (!cfg) {
  console.error('Faltam TELEGRAM_BOT_TOKEN e/ou TELEGRAM_CHAT_ID no .env');
  process.exitCode = 1;
} else {
  sendTelegram(cfg, 'Conexão: Telegram OK')
    .then(() => console.log('Mensagem enviada.'))
    .catch((e) => { console.error((e as Error).message); process.exitCode = 1; });
}
