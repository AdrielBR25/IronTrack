import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Testes do gateway: ambiente Node, sem jsdom e sem os testes do app.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
