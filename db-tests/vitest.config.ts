import { defineConfig } from 'vitest/config';
// PGlite leva ~1 s para subir; cada teste cria seu próprio banco.
export default defineConfig({ test: { testTimeout: 30_000, hookTimeout: 30_000 } });
