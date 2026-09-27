import fs from 'node:fs';
import path from 'node:path';
import { COLLECTOR_DIR } from './browser.js';

/** Carrega o .env da raiz do repo (e depois o de collector/, se existir), sem sobrescrever o ambiente. */
export function loadEnv(): void {
  for (const file of [path.join(COLLECTOR_DIR, '..', '.env'), path.join(COLLECTOR_DIR, '.env')]) {
    if (fs.existsSync(file)) process.loadEnvFile(file); // Node ≥ 20.12
  }
}
