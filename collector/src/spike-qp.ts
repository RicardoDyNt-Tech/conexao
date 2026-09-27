import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { COLLECTOR_DIR, openBrowser } from './browser.js';
import { dailyPageLimit, takePage } from './budget.js';
import { loadEnv } from './env.js';
import { withCollectorLock } from './lock.js';
import { activeQuarantine, formatUntil, quarantineFile, startQuarantine } from './quarantine.js';
import { BLOCK_STATUSES } from './sources/blocking.js';
import { QP_HOME } from './sources/queropassagem.js';
import { captureLeg, OUT_ROOT, WAIT_MS, type LegReport } from './qp-capture.js';

// Spike do Quero Passagem (Fase 5a, Parte 1). Abre a página pública de 3 trechos e registra
// tudo o que a própria página recebe, para decidirmos entre ler o JSON de /search/ ou o DOM.
//   npm run spike:qp                      → 2026-10-10, headless
//   npm run spike:qp -- --date 2026-10-12 --headed
// Não chama nenhum endpoint direto e não reaproveita tokens: só observa a página.

const PAUSE_MS = { min: 15_000, max: 30_000 };
const HOME_WAIT_MS = { min: 4_000, max: 9_000 };
const QP_QUARANTINE = () => quarantineFile('queropassagem'); // quarentena só do QP

const rand = (r: { min: number; max: number }) => r.min + Math.random() * (r.max - r.min);
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function main() {
  const { values } = parseArgs({ options: {
    date: { type: 'string', default: '2026-10-10' },
    headed: { type: 'boolean', default: false },
  } });
  const date = values.date!;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('--date deve ser AAAA-MM-DD');
  loadEnv();

  const q = await activeQuarantine('queropassagem', new Date(), QP_QUARANTINE());
  if (q) {
    console.log(`⏸ Quero Passagem em quarentena até ${formatUntil(q.until)} (${q.reason}). Nada a fazer.`);
    return;
  }
  const cfg = JSON.parse(await fs.readFile(path.join(COLLECTOR_DIR, 'config', 'legs.json'), 'utf8'));
  const legs = cfg.spikeQp as Array<{ from: string; to: string }>;
  const limit = dailyPageLimit();
  const reports: LegReport[] = [];
  console.log(`Spike Quero Passagem — ${legs.length} trechos, ${date}, modo ${values.headed ? 'janela' : 'headless'}\n`);

  await withCollectorLock(async () => {
    const ctx = await openBrowser({ headless: !values.headed });
    try {
      if (!(await takePage(limit))) { console.log('📉 Limite diário de páginas atingido.'); return; }
      console.log('→ página inicial do QP');
      const home = await ctx.newPage();
      const nav = await home.goto(QP_HOME, { waitUntil: 'domcontentloaded', timeout: WAIT_MS }).catch((e: Error) => {
        console.log(`  ⚠ home falhou: ${e.message.split('\n')[0]}`); return null;
      });
      if (nav && BLOCK_STATUSES.has(nav.status())) {
        const qq = await startQuarantine('queropassagem', `home: HTTP ${nav.status()}`, new Date(), QP_QUARANTINE());
        console.log(`  ⛔ home devolveu HTTP ${nav.status()}: parado. Quarentena do QP até ${formatUntil(qq.until)}.`);
        return;
      }
      await home.waitForTimeout(rand(HOME_WAIT_MS));
      await home.close();

      for (let i = 0; i < legs.length; i++) {
        const { from, to } = legs[i]!;
        if (i > 0) {
          const p = rand(PAUSE_MS);
          console.log(`  … pausa de ${(p / 1000).toFixed(1)} s`);
          await sleep(p);
        }
        if (!(await takePage(limit))) { console.log('📉 Limite diário de páginas atingido: parando.'); break; }
        console.log(`→ ${from} → ${to} (${date})`);
        const r = await captureLeg(ctx, from, to, date);
        reports.push(r);
        console.log(`  ${r.status}${r.detail ? ` — ${r.detail}` : ''} · HTTP ${r.navStatus ?? '?'} · ${(r.waitedMs / 1000).toFixed(1)} s`
          + ` · JSON ${r.jsonResponses} · /search/ ${r.searchResponses} (${r.searchItems} itens)`
          + ` · cards no DOM ${r.domCards} · JSON-LD BusTrip ${r.jsonLdBusTrips}`
          + (r.suspiciousMarker ? ` · marcador: ${r.suspiciousMarker}` : ''));
        if (r.status === 'blocked') {
          const qq = await startQuarantine('queropassagem', `${from} → ${to}: ${r.detail ?? 'bloqueio'}`, new Date(), QP_QUARANTINE());
          console.log(`  ⛔ bloqueio: spike interrompido (não insistir). Quarentena do QP até ${formatUntil(qq.until)}.`);
          break;
        }
      }
    } finally {
      await ctx.close();
    }
  });

  await fs.mkdir(path.join(OUT_ROOT, date), { recursive: true });
  const summaryFile = path.join(OUT_ROOT, date, 'summary.json');
  await fs.writeFile(summaryFile, JSON.stringify(reports, null, 2));
  console.log(`\nArquivos em ${path.join(OUT_ROOT, date)}`);
  console.log('Mande: a saída acima, summary.json e, de cada trecho, responses.json, os NN_search.json e dom.json.');
}

main().catch((e) => {
  console.error(`erro: ${(e as Error).message}`);
  process.exitCode = 1;
});
