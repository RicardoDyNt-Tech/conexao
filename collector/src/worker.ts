import { parseArgs } from 'node:util';
import { loadEnv } from './env.js';
import { blockedMessage, budgetMessage, makeNotifier, roundFailedMessage, telegramFromEnv } from './notify/telegram.js';
import { runRound, type RoundEntry } from './runner.js';
import { activeQuarantine, formatUntil } from './quarantine.js';
import { dailyPageLimit, pagesLeft } from './budget.js';
import { todayIn } from './time.js';
import { SOURCES, sourceLabel } from './sources/index.js';
import type { Source } from './types.js';
import { legsForRequest, Store } from './store.js';

// "Atualizar agora": atende os pedidos de collect_requests.
//   npm run worker            → fica rodando (Realtime + polling a cada 60 s); coleta em todas as
//                               fontes fora de quarentena (com todas em quarentena, pedidos ficam pending)
//   npm run worker -- --once  → atende os pendentes e sai (usado pelo run-scheduled.ps1)

const POLL_MS = 60_000;
const log = (m: string) => console.log(`[${new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Bahia' })}] ${m}`);

type Notify = (text: string) => Promise<void>;

const pausedLogged = new Map<string, string>();
let budgetLogged: string | null = null;

/** Fontes fora de quarentena agora (as outras ficam para depois; cada site tem a sua). */
async function activeSources(): Promise<Source[]> {
  const out: Source[] = [];
  for (const s of SOURCES) {
    const q = await activeQuarantine(s.name);
    if (!q) { out.push(s); continue; }
    if (pausedLogged.get(s.name) !== q.until) {
      log(`⏸ ${sourceLabel(s.name)} em quarentena até ${formatUntil(q.until)}; pedidos seguem pelas outras fontes.`);
      pausedLogged.set(s.name, q.until);
    }
  }
  return out;
}

/**
 * Atende pedidos até a fila esvaziar, em todas as fontes fora de quarentena. Com todas em
 * quarentena (ou sem páginas no dia), não pega pedido nenhum: eles ficam pending.
 */
async function processPending(store: Store, notify: Notify, headless: boolean): Promise<'idle' | 'paused'> {
  for (;;) {
    const sources = await activeSources();
    if (!sources.length) return 'paused';
    const limit = dailyPageLimit();
    if ((await pagesLeft(limit)).left < 2) {
      if (budgetLogged !== todayIn()) {
        log(`📉 Limite diário de ${limit} páginas atingido; pedidos ficam na fila até amanhã.`);
        budgetLogged = todayIn();
      }
      return 'paused';
    }
    const req = await store.claimRequest();
    if (!req) return 'idle';
    log(`Pedido #${req.id}: cidades ${req.origin_city_id} → ${req.dest_city_id}, ${req.travel_date} · fontes: ${sources.map((x) => sourceLabel(x.name)).join(', ')}`);
    try {
      const results: RoundEntry[] = [];
      for (const source of sources) {
        const { hubs, slugOf } = await store.routeContext(source.name);
        const { legs, warnings } = legsForRequest(req, hubs, slugOf, source.name);
        warnings.forEach((w) => log(`⚠ ${w}`));
        if (!legs.length) continue;
        results.push(...await runRound(source, legs, {
          headless,
          saveRaw: false,
          pauseFirst: true, // outra coleta pode ter acabado de rodar
          log: (m) => log(m.trim()),
          onResult: (r) => store.recordLeg(r),
          onBlocked: (r, c) => notify(blockedMessage(r, formatUntil(c.until), 'atualização pedida no app')),
          onBudgetExhausted: (info) => notify(budgetMessage(info)),
        }));
      }
      if (!results.length) {
        await store.finishRequest(req.id, 'error', 'nenhum trecho para este par (sem slugs/hubs)');
        continue;
      }
      if (results.every((r) => r.status === 'skipped')) {
        // Quarentena ou limite diário começou enquanto esperávamos a trava: devolve o pedido.
        await store.requeueRequest(req.id);
        return 'paused';
      }
      // Pulado por quarentena de uma fonte não é erro do pedido: as outras fontes atenderam.
      const bad = results.filter((r) => r.status === 'error' || r.status === 'blocked'
        || (r.status === 'skipped' && 'reason' in r && r.reason));
      await store.finishRequest(req.id, bad.length ? 'error' : 'done',
        bad.length ? bad.map((r) => {
          const why = ('error' in r && r.error) || ('reason' in r && r.reason);
          return `${sourceLabel(r.source)} ${r.from}→${r.to}: ${r.status}${why ? ` (${why})` : ''}`;
        }).join('; ') : undefined);
      log(`Pedido #${req.id}: ${bad.length ? 'error' : 'done'}`);
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
    await processPending(store, notify, headless);
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
        // Em pausa: sai e tenta de novo no próximo evento/polling (que também respeita a pausa).
        if ((await processPending(store, notify, headless)) === 'paused') return;
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
