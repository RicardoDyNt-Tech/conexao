import { parseArgs } from 'node:util';
import { clickbus } from './sources/clickbus.js';
import { nextMonday, todayIn } from './time.js';
import { formatSummary, loadLegs, runRound } from './runner.js';

// Spike da Fase 1: os 5 trechos de config/legs.json ("spike"), próxima segunda-feira.
// npm run spike            → headless
// npm run spike -- --headed → janela visível
async function main() {
  const { values } = parseArgs({ options: { headed: { type: 'boolean', default: false }, date: { type: 'string' } } });
  const date = values.date ?? nextMonday(todayIn());
  const legs = await loadLegs('spike');
  const mode = values.headed ? 'janela' : 'headless';
  console.log(`Spike ClickBus — ${legs.length} trechos, ${date}, modo ${mode}\n`);
  const results = await runRound(clickbus, legs.map((l) => ({ ...l, date })), { headless: !values.headed, saveRaw: true });
  console.log(`\nResumo (${mode})\n${formatSummary(results)}`);
}

main().catch((e) => {
  console.error(`erro: ${(e as Error).message}`);
  process.exitCode = 1;
});
