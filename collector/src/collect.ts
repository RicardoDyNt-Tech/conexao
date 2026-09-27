import { parseArgs } from 'node:util';
import { clickbus } from './sources/clickbus.js';
import { addDays, defaultStartDate } from './time.js';
import { formatSummary, loadLegs, runRound, type Leg } from './runner.js';
import { loadEnv } from './env.js';
import { Store } from './store.js';
import { blockedMessage, makeNotifier, roundFailedMessage, roundProblemsMessage, telegramFromEnv } from './notify/telegram.js';
import type { LegQuery } from './types.js';

const USAGE = `Uso:
  npm run collect -- --from salvador-ba --to catu-ba --date 2026-10-05
  npm run collect -- --legs all --days 7 [--start AAAA-MM-DD]
    (sem --start: começa hoje, ou amanhã se já passou das 20:00 em America/Bahia)
Opções: --headed (janela visível)  --no-save (não grava output/)
        --offline (não usa o Supabase: trechos de config/legs.json, nada é gravado no banco)
        --notify  (rodada agendada: resumo no Telegram se houver erro/bloqueio)
Bloqueio é avisado no Telegram sempre que o bot estiver configurado.`;

const roundLabel = () =>
  `rodada das ${new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Bahia', hour: '2-digit', minute: '2-digit' })}`;
let failureLabel: string | null = null; // preenchido com --notify: avisa se a rodada inteira falhar

async function main() {
  const { values: a } = parseArgs({
    options: {
      from: { type: 'string' }, to: { type: 'string' }, date: { type: 'string' },
      legs: { type: 'string' }, days: { type: 'string' }, start: { type: 'string' },
      headed: { type: 'boolean', default: false },
      'no-save': { type: 'boolean', default: false },
      offline: { type: 'boolean', default: false },
      notify: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (a.help) return console.log(USAGE);

  loadEnv();
  const notify = makeNotifier(telegramFromEnv());
  const label = roundLabel();
  if (a.notify) failureLabel = label;
  const store = a.offline ? null : Store.fromEnv();
  if (!store && !a.offline) console.warn('⚠ SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes: modo offline (nada é gravado).');

  let queries: LegQuery[];
  if (a.legs) {
    if (a.legs !== 'all') throw new Error('--legs só aceita "all" por enquanto');
    const days = Number(a.days ?? 7);
    if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error('--days deve ser inteiro entre 1 e 30');
    let legs: Leg[];
    if (store) {
      const fromDb = await store.loadLegs(clickbus.name);
      fromDb.warnings.forEach((w) => console.warn(`⚠ ${w}`));
      legs = fromDb.legs;
      console.log(`Trechos do banco: ${legs.length}`);
    } else {
      legs = await loadLegs('legs'); // fallback offline
      console.log(`Trechos de config/legs.json (offline): ${legs.length}`);
    }
    const start = a.start ?? a.date ?? defaultStartDate();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) throw new Error('--start deve ser AAAA-MM-DD');
    // Data por fora, trecho por dentro: se bloquear, as datas mais próximas já foram coletadas.
    queries = Array.from({ length: days }, (_, d) => addDays(start, d))
      .flatMap((date) => legs.map((l) => ({ ...l, date })));
  } else if (a.from && a.to && a.date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a.date)) throw new Error('--date deve ser AAAA-MM-DD');
    queries = [{ from: a.from, to: a.to, date: a.date }];
  } else {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  console.log(`${queries.length} página(s), modo ${a.headed ? 'janela' : 'headless'}\n`);
  let dbFailures = 0;
  const results = await runRound(clickbus, queries, {
    headless: !a.headed,
    saveRaw: !a['no-save'],
    onResult: store ? async (r) => {
      try { await store.recordLeg(r); } catch (e) { dbFailures++; throw e; }
    } : undefined,
    onBlocked: (r) => notify(blockedMessage(r)),
  });
  console.log(`\nResumo\n${formatSummary(results)}`);
  if (a.notify) {
    const msg = roundProblemsMessage(results, { label, dbFailures });
    if (msg) await notify(msg).catch((e) => console.error(`⚠ Telegram: ${(e as Error).message}`));
  }
  if (results.some((r) => r.status === 'blocked')) process.exitCode = 3;
}

main().catch(async (e) => {
  console.error(`erro: ${(e as Error).message}`);
  if (failureLabel) {
    await makeNotifier(telegramFromEnv())(roundFailedMessage(failureLabel, e))
      .catch((err) => console.error(`⚠ Telegram: ${(err as Error).message}`));
  }
  process.exitCode = 1;
});
