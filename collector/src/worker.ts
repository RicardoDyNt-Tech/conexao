import { parseArgs } from 'node:util';
import { loadEnv } from './env.js';
import { blockedMessage, makeNotifier, roundFailedMessage, telegramFromEnv } from './notify/telegram.js';
import { runRound } from './runner.js';
import { clickbus } from './sources/clickbus.js';
import { legsForRequest, Store } from './store.js';

// "Atualizar agora": atende os pedidos de collect_requests.
//   npm run worker            → fica rodando (Realtime + polling a cada 60 s)
//   npm run worker -- --once  → atende os pendentes e sai (usado pelo run-scheduled.ps1)

const POLL_MS = 60_000;
const log = (m: string) => console.log(`[${new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Bahia' })}] ${m}`);

type Notify = (text: string) => Promise<void>;

/** Atende pedidos até a fila esvaziar. Devolve 'blocked' se a ClickBus bloquear (aí paramos tudo). */
async function processPending(store: Store, notify: Notify, headless: boolean): Promise<'idle' | 'blocked'> {
  for (;;) {
    const req = await store.claimRequest();
    if (!req) return 'idle';
    log(`Pedido #${req.id}: cidades ${req.origin_city_id} → ${req.dest_city_id}, ${req.travel_date}`);
    try {
      const { hubs, slugOf } = await store.routeContext(clickbus.name);
      const { legs, warnings } = legsForRequest(req, hubs, slugOf, clickbus.name);
      warnings.forEach((w) => log(`⚠ ${w}`));
      if (!legs.length) {
        await store.finishRequest(req.id, 'error', 'nenhum trecho para este par (sem slugs/hubs)');
        continue;
      }
      const results = await runRound(clickbus, legs, {
        headless,
        saveRaw: false,
        pauseFirst: true, // outra coleta pode ter acabado de rodar
        log: (m) => log(m.trim()),
        onResult: (r) => store.recordLeg(r),
        onBlocked: (r) => notify(blockedMessage(r, 'atualização pedida no app')),
      });
      const bad = results.filter((r) => r.status !== 'ok' && r.status !== 'empty');
      await store.finishRequest(req.id, bad.length ? 'error' : 'done',
        bad.length ? bad.map((r) => `${r.from}→${r.to}: ${r.status}${'error' in r && r.error ? ` (${r.error})` : ''}`).join('; ') : undefined);
      log(`Pedido #${req.id}: ${bad.length ? 'error' : 'done'}`);
      if (results.some((r) => r.status === 'blocked')) return 'blocked';
    } catch (e) {
      log(`Pedido #${req.id} falhou: ${(e as Error).message}`);
      await store.finishRequest(req.id, 'error', (e as Error).message).catch(() => {});
    }
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    once: { type: 'boolean', default: false },
    headed: { type: 'boolean', default: false },
  } });
  loadEnv();
  const store = Store.fromEnv();
  if (!store) throw new Error('SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes no .env');
  const notify = makeNotifier(telegramFromEnv());
  const headless = !values.headed;

  if (values.once) {
    if ((await processPending(store, notify, headless)) === 'blocked') process.exitCode = 3;
    return;
  }

  // Um atendimento por vez; eventos que chegam no meio só pedem mais uma passada.
  let busy = false, again = false;
  let stop: (() => void) | undefined;
  const drain = async () => {
    if (busy) { again = true; return; }
    busy = true;
    try {
      do {
        again = false;
        if ((await processPending(store, notify, headless)) === 'blocked') {
          log('⛔ Bloqueio: worker encerrado (não insistir). Reinicie depois.');
          process.exitCode = 3;
          stop?.();
          return;
        }
      } while (again);
    } catch (e) {
      log(`⚠ ${(e as Error).message}`); // falha de rede/banco: a próxima passada tenta de novo
    } finally {
      busy = false;
    }
  };

  const channel = store.subscribeRequests(() => void drain(), (status) => {
    if (status === 'SUBSCRIBED') log('Realtime conectado.');
    else log(`Realtime: ${status} (seguimos com polling a cada ${POLL_MS / 1000} s)`);
  });
  const timer = setInterval(() => void drain(), POLL_MS); // rede de segurança se o Realtime cair
  stop = () => { clearInterval(timer); void channel.unsubscribe().finally(() => process.exit()); };
  process.on('SIGINT', () => { log('Encerrando.'); stop?.(); });
  log(`Worker ativo. Polling a cada ${POLL_MS / 1000} s. Ctrl+C para sair.`);
  await drain();
}

main().catch(async (e) => {
  console.error(`erro: ${(e as Error).message}`);
  await makeNotifier(telegramFromEnv())(roundFailedMessage('o worker', e)).catch(() => {});
  process.exitCode = 1;
});
