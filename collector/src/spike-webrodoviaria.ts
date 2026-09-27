import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { COLLECTOR_DIR, openBrowser } from './browser.js';
import { dailyPageLimit, takePage } from './budget.js';
import { loadEnv } from './env.js';
import { withCollectorLock } from './lock.js';
import { activeQuarantine, formatUntil, startQuarantine } from './quarantine.js';
import { VIACOES, viacao } from './sources/webrodoviaria.js';
import { captureLeg, OUT_ROOT, type LegReport } from './wr-capture.js';

// Spike da Venda Web (webrodoviaria) da Rota e da Cidade Sol (Fase 5c, Parte 1).
// Para cada viação: abre a raiz, preenche origem/destino/data como um usuário, pesquisa e registra
// tudo o que a página troca com o servidor; no 1º trecho de cada viação, testa a aba do dia seguinte.
//   npm run spike:webrodoviaria                        → 2026-10-10, headless, as duas viações
//   npm run spike:webrodoviaria -- --headed --viacao rota
// Não chama nenhum endpoint direto e não reaproveita sessão/ViewState: só observa a página.

const PAUSE = { min: 15_000, max: 30_000 };
const SETTLE = { min: 4_000, max: 9_000 };   // "olhar a página" antes de digitar
const TYPING = { min: 90, max: 180 };        // ms por tecla

interface SpikeLeg { viacao: string; from: string; to: string }

async function main() {
  const { values } = parseArgs({ options: {
    date: { type: 'string', default: '2026-10-10' },
    headed: { type: 'boolean', default: false },
    viacao: { type: 'string' },
    'no-tab': { type: 'boolean', default: false },
  } });
  const date = values.date!;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('--date deve ser AAAA-MM-DD');
  if (values.viacao) viacao(values.viacao); // valida
  loadEnv();

  const cfg = JSON.parse(await fs.readFile(path.join(COLLECTOR_DIR, 'config', 'legs.json'), 'utf8'));
  const legs = (cfg.spikeWebrodoviaria as SpikeLeg[]).filter((l) => !values.viacao || l.viacao === values.viacao);
  // Rota e Cidade Sol estão na mesma plataforma (e talvez no mesmo servidor): quarentena de
  // uma vale para as duas no spike.
  const sources = Object.keys(VIACOES);
  for (const s of sources) {
    const q = await activeQuarantine(s);
    if (q) { console.log(`⏸ ${viacao(s).name} em quarentena até ${formatUntil(q.until)} (${q.reason}). Nada a fazer.`); return; }
  }

  const limit = dailyPageLimit();
  const reports: LegReport[] = [];
  console.log(`Spike Venda Web — ${legs.length} trechos, ${date}, modo ${values.headed ? 'janela' : 'headless'}\n`);

  await withCollectorLock(async () => {
    const ctx = await openBrowser({ headless: !values.headed });
    try {
      const tested = new Set<string>();
      for (let i = 0; i < legs.length; i++) {
        const { viacao: src, from, to } = legs[i]!;
        const v = viacao(src);
        if (i > 0) {
          const p = PAUSE.min + Math.random() * (PAUSE.max - PAUSE.min);
          console.log(`  … pausa de ${(p / 1000).toFixed(1)} s`);
          await new Promise((res) => setTimeout(res, p));
        }
        console.log(`→ ${v.name}: ${from} → ${to} (${date})`);
        const tryTab = !values['no-tab'] && !tested.has(src);
        tested.add(src);
        const r = await captureLeg(ctx, v, from, to, date, {
          pause: PAUSE, settle: SETTLE, typingDelay: TYPING, tryTab, takePage: () => takePage(limit),
        });
        reports.push(r);
        console.log(`  ${r.status}${r.detail ? ` — ${r.detail}` : ''} · raiz HTTP ${r.rootStatus ?? '?'} · ${(r.waitedMs / 1000).toFixed(1)} s`
          + ` · ${r.pages} página(s) · cards ${r.cards} · XHR na busca ${r.xhrDuringSearch}`
          + (r.searchRequest ? ` · busca = ${r.searchRequest.method} ${r.searchRequest.type} ${r.searchRequest.url}` : '')
          + (r.tabSwitch ? ` · aba: ${r.tabSwitch} (${r.tabCards} cards)` : '')
          + (r.suspiciousMarker ? ` · marcador: ${r.suspiciousMarker}` : ''));
        if (r.status === 'blocked') {
          for (const s of sources) await startQuarantine(s, `spike ${v.name} ${from} → ${to}: ${r.detail ?? 'bloqueio'}`);
          console.log('  ⛔ bloqueio: spike interrompido (não insistir). Quarentena de 24 h da Rota e da Cidade Sol.');
          break;
        }
        if (r.detail?.startsWith('limite diário')) { console.log('📉 Limite diário de páginas atingido: parando.'); break; }
      }
    } finally {
      await ctx.close();
    }
  });

  await fs.mkdir(path.join(OUT_ROOT, date), { recursive: true });
  await fs.writeFile(path.join(OUT_ROOT, date, 'summary.json'), JSON.stringify(reports, null, 2));
  console.log(`\nArquivos em ${path.join(OUT_ROOT, date)}`);
  console.log('Mande: a saída acima, summary.json e, de cada trecho, steps.json, requests.json, forms.json, dom.json,'
    + ' os arquivos NNN_search_* / NNN_tab_* e os prints (results.png, tab.png).');
}

main().catch((e) => {
  console.error(`erro: ${(e as Error).message}`);
  process.exitCode = 1;
});
