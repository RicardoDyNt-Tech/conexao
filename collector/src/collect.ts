import { parseArgs } from 'node:util';
import { parseSources, sourceLabel } from './sources/index.js';
import { addDays, defaultStartDate, parseDateList } from './time.js';
import { formatSummary, loadLegs, runRound, shuffle, type Leg, type RoundEntry } from './runner.js';
import { activeQuarantine, formatUntil } from './quarantine.js';
import { loadEnv } from './env.js';
import { Store, watchedQueries } from './store.js';
import { blockedMessage, budgetMessage, makeNotifier, roundFailedMessage, roundProblemsMessage, telegramFromEnv } from './notify/telegram.js';
import type { LegQuery, Source } from './types.js';

const USAGE = `Uso:
  npm run collect -- [--source clickbus|queropassagem|all] ...   (padrão: all, uma fonte de cada vez)
  npm run collect -- --source clickbus --from salvador-ba --to catu-ba --date 2026-10-05
  npm run collect -- --legs all [--days 5] [--start AAAA-MM-DD]
  npm run collect -- --legs all --dates 2026-10-10,2026-10-12
  npm run collect -- --source queropassagem --from salvador-ba --to catu --dates 2026-10-10,2026-10-12
    (--from/--to usam os slugs de UMA fonte: exigem --source)
    (sem --start: começa hoje, ou amanhã se já passou das 20:00 em America/Bahia)
Opções: --headed (janela visível)  --no-save (não grava output/)
        --offline (não usa o Supabase: trechos de config/legs.json, nada é gravado no banco)
        --notify  (rodada agendada: resumo no Telegram se houver erro/bloqueio)
        --watched (com --legs all: também as datas monitoradas no app, até 30 dias; só os
                   trechos do sentido monitorado)
        --ignore-quarantine (uso manual consciente: roda mesmo em quarentena; se não houver
                             bloqueio, a quarentena acaba)
Bloqueio é avisado no Telegram (se configurado) e põe AQUELA fonte em quarentena por 24 h;
as outras fontes seguem.
Limite diário de páginas: DAILY_PAGE_LIMIT no .env (padrão 120); o que passar fica para o dia seguinte.`;

const roundLabel = () =>
  `rodada das ${new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Bahia', hour: '2-digit', minute: '2-digit' })}`;
let failureLabel: string | null = null; // preenchido com --notify: avisa se a rodada inteira falhar

async function main() {
  const { values: a } = parseArgs({
    options: {
      from: { type: 'string' }, to: { type: 'string' }, date: { type: 'string' },
      source: { type: 'string', default: 'all' },
      legs: { type: 'string' }, days: { type: 'string' }, start: { type: 'string' }, dates: { type: 'string' },
      headed: { type: 'boolean', default: false },
      'no-save': { type: 'boolean', default: false },
      offline: { type: 'boolean', default: false },
      notify: { type: 'boolean', default: false },
      'ignore-quarantine': { type: 'boolean', default: false },
      watched: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (a.help) return console.log(USAGE);

  loadEnv();
  const notify = makeNotifier(telegramFromEnv());
  const label = roundLabel();
  if (a.notify) failureLabel = label;
  const sources = parseSources(a.source);
  if ((a.from || a.to) && sources.length > 1) throw new Error('--from/--to usam slugs de uma fonte: informe --source');

  if (a.dates && (a.days || a.start || a.date)) {
    throw new Error('--dates não combina com --days, --start ou --date');
  }
  // Validadas antes de abrir qualquer coisa: erro de digitação não gasta página.
  const dateList = a.dates ? parseDateList(a.dates) : null;
  const days = Number(a.days ?? 5);
  if (a.legs && a.legs !== 'all') throw new Error('--legs só aceita "all" por enquanto');
  if (a.legs && !dateList && (!Number.isInteger(days) || days < 1 || days > 30)) throw new Error('--days deve ser inteiro entre 1 e 30');
  if (!a.legs && !(a.from && a.to && (dateList || a.date))) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  const store = a.offline ? null : Store.fromEnv();
  if (!store && !a.offline) console.warn('⚠ SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes: modo offline (nada é gravado).');

  const queriesFor = async (source: Source): Promise<LegQuery[]> => {
    if (!a.legs) {
      if (dateList) return dateList.map((date) => ({ from: a.from!, to: a.to!, date }));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(a.date!)) throw new Error('--date deve ser AAAA-MM-DD');
      return [{ from: a.from!, to: a.to!, date: a.date! }];
    }
    let legs: Leg[];
    if (store) {
      const fromDb = await store.loadLegs(source.name); // slugs dessa fonte (city_source_ids)
      fromDb.warnings.forEach((w) => console.warn(`⚠ ${w}`));
      legs = fromDb.legs;
    } else {
      legs = await loadLegs(source.name); // fallback offline
    }
    let dates: string[];
    if (dateList) {
      dates = dateList;
    } else {
      const start = a.start ?? a.date ?? defaultStartDate();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) throw new Error('--start deve ser AAAA-MM-DD');
      dates = Array.from({ length: days }, (_, d) => addDays(start, d));
    }
    // Data por fora, trecho por dentro: se bloquear, as datas mais próximas já foram coletadas.
    // Ordem dos trechos sorteada a cada dia, para a rodada não repetir sempre a mesma sequência.
    const window = dates.flatMap((date) => shuffle(legs).map((l) => ({ ...l, date })));
    if (!a.watched) return window;
    if (!store) { console.warn('⚠ --watched precisa do Supabase: datas monitoradas ignoradas.'); return window; }
    // Datas monitoradas depois da janela (até 30 dias), só os trechos do sentido monitorado.
    const today = defaultStartDate();
    const watches = await store.listWatches(today, addDays(today, 30));
    const { hubs, slugOf } = await store.routeContext(source.name);
    const extra = watchedQueries(watches, hubs, slugOf, source.name, window);
    if (extra.length) console.log(`Datas monitoradas (${sourceLabel(source.name)}): ${extra.length} página(s) a mais`);
    return [...window, ...extra];
  };

  const results: RoundEntry[] = [];
  const quarantined: Array<{ source: string; until: string }> = [];
  let dbFailures = 0;
  for (const source of sources) {
    const label2 = sourceLabel(source.name);
    const paused = await activeQuarantine(source.name);
    if (paused && !a['ignore-quarantine']) {
      // Quarentena por bloqueio: não abre páginas e não avisa de novo (o aviso saiu no bloqueio).
      console.log(`⏸ ${label2} em quarentena até ${formatUntil(paused.until)} (${paused.reason}): pulada.\n`);
      quarantined.push({ source: source.name, until: formatUntil(paused.until) });
      continue;
    }
    if (paused) console.warn(`⚠ Quarentena de ${label2} até ${formatUntil(paused.until)} ignorada (--ignore-quarantine).`);
    const queries = await queriesFor(source);
    console.log(`== ${label2}: ${queries.length} página(s), modo ${a.headed ? 'janela' : 'headless'}\n`);
    results.push(...await runRound(source, queries, {
      headless: !a.headed,
      saveRaw: !a['no-save'],
      onResult: store ? async (r) => {
        try { await store.recordLeg(r); } catch (e) { dbFailures++; throw e; }
      } : undefined,
      onBlocked: (r, c) => notify(blockedMessage(r, formatUntil(c.until))),
      onBudgetExhausted: (info) => notify(budgetMessage(info)),
      ignoreQuarantine: a['ignore-quarantine'],
    }));
    console.log('');
  }

  if (!results.length) {
    console.log('Nada coletado (todas as fontes em quarentena).');
    return;
  }
  console.log(`Resumo\n${formatSummary(results)}`);
  // O bloqueio já teve aviso imediato; o resumo só sai se houver outro problema (erro, banco).
  const otherProblems = dbFailures > 0 || results.some((r) => r.status === 'error');
  if (a.notify && otherProblems) {
    const msg = roundProblemsMessage(results, { label, dbFailures, quarantined });
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
