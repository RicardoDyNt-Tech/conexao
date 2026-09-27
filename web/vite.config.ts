import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // Formatação sempre em America/Bahia, independentemente do fuso da máquina de teste.
    env: { TZ: 'UTC' },
  },
});
