// Teste de integração dos contêineres (Prompt 21.1): o navegador fala só com o irontrack-web (Caddy), que serve o app
// e repassa /api/v1 para o irontrack-api. A pilha é subida por scripts/stack-test.sh (services/web/compose.stack.yml).
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e-stack',
  outputDir: 'test-results-stack',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: process.env.STACK_URL ?? 'http://localhost:8090/',
    trace: 'retain-on-failure',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
  },
  projects: [{ name: 'android', use: { ...devices['Pixel 7'], viewport: { width: 360, height: 740 } } }],
});
