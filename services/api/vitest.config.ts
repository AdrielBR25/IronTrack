import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Testes da API: ambiente Node com PostgreSQL REAL (TEST_DATABASE_URL). Cada arquivo cria um banco descartável.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: { environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 60_000, fileParallelism: false },
});
