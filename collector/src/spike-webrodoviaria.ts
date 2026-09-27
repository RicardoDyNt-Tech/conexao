import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { COLLECTOR_DIR, openBrowser } from './browser.js';
import { dailyPageLimit, takePage } from './budget.js';
import { loadEnv } from './env.js';
import { withCollectorLock } from './lock.js';
import { activeQuarantine, formatUntil, startQuarantine } from './quarantine.js';
import { captureWrLeg, OUT_ROOT, type Site, type WrLeg, type WrReport } from './webrodoviaria-capture.js';

// Spike da Fase 5c: Venda Web da Cidade Sol e da Rota (config/legs.json, "spikeWebrodoviaria").
//   npm run spike:webrodoviaria                      → 2026-10-10, headless
//   npm run spike:webrodoviaria -- --only rota --headed
//   npm run spike:webrodoviaria -- --leg catu          → só trechos cujo "origem → destino" contém "catu"
// Uma viação de cada vez, 15–30 s entre páginas, teto diário e quarentena por viação.

const PAUSE_MS = { min: 15_000, max: 30_000 };
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const pause = async () => {
  const ms = PAUSE_MS.min + Math.random() * (PAUSE_MS.max - PAUSE_MS.min);
  console.log(`  … pausa de ${(ms / 1000).toFixed(1)} s`);
  await sleep(ms);
};

async function main() {
  const { values } = parseArgs({ options: {
    date: { type: 'string', default: '2026-10-10' },
    headed: { type: 'boolean', default: false },
    only: { type: 'string' },
    leg: { type: 'string' },
  } });
  const date = values.date!;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('--date deve ser AAAA-MM-DD');
  loadEnv();
  const cfg = JSON.parse(await fs.readFile(path.join(COLLECTOR_DIR, 'config', 'legs.json'), 'utf8'));
  const sites = Object.entries(cfg.spikeWebrodoviaria as Record<string, { label: string; base: string; legs: WrLeg[] }>)
    .filter(([source]) => !values.only || source === values.only);
  const limit = dailyPageLimit();
  const reports: WrReport[] = [];

  await withCollectorLock(async () => {
    const ctx = await openBrowser({ headless: !values.headed });
    try {
      let first = true;
      for (const [source, s] of sites) {
        const site: Site = { source, label: s.label, base: s.base };
        const q = await activeQuarantine(source);
        if (q) { console.log(`⏸ ${s.label} em quarentena até ${formatUntil(q.until)}: pulada.`); continue; }
        console.log(`\n== ${s.label} (${s.base})`);
        const legs = s.legs.filter((l) => !values.leg || `${l.from} → ${l.to}`.toLowerCase().includes(values.leg!.toLowerCase()));
        for (const leg of legs) {
          if (!first) await pause();
          first = false;
          console.log(`→ ${leg.from} → ${leg.to} (${date})`);
          const r = await captureWrLeg(ctx, site, leg, date, OUT_ROOT, { takePage: () => takePage(limit), pause });
          reports.push(r);
          r.steps.forEach((st) => console.log(`    · ${st}`));
          (r.navigations ?? []).forEach((n) => console.log(`    ↪ ${n}`));
          console.log(`  ${r.status}${r.detail ? ` — ${r.detail}` : ''} · ${r.cards} cards · XHR ${r.xhrCount} (JSON ${r.jsonResponses})`
            + ` · form ${r.formMethod ?? '?'} ${r.formAction ?? ''} · páginas ${r.pages}`
            + (r.tab.tried ? ` · aba ${r.tab.label}: ${r.tab.via}, ${r.tab.cards} cards` : ''));
          if (r.status === 'blocked') {
            const qq = await startQuarantine(source, `${leg.from} → ${leg.to}: ${r.detail ?? 'bloqueio'}`);
            console.log(`  ⛔ bloqueio: ${s.label} em quarentena até ${formatUntil(qq.until)}. Não insista.`);
            break;
          }
        }
      }
    } finally {
      await ctx.close();
    }
  });

  await fs.mkdir(OUT_ROOT, { recursive: true });
  await fs.writeFile(path.join(OUT_ROOT, `summary-${date}.json`), JSON.stringify(reports, null, 2));
  console.log(`\nArquivos em ${OUT_ROOT}`);
  console.log('Mande: a saída acima e o zip da pasta (sem os .png, se ficar grande).');
}

main().catch((e) => {
  console.error(`erro: ${(e as Error).message}`);
  process.exitCode = 1;
});
