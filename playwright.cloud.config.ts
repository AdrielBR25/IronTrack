// E2E do modo nuvem (Prompt 21): app com VITE_ACCOUNTS=on servido em "/" (como na Netlify), `/api` pelo proxy do
// vite preview para a API local, PostgreSQL descartável, e-mail e provedor de IA simulados.
// Requer TEST_DATABASE_URL (PostgreSQL local ou serviço do CI). Ver docs/NUVEM_IMPLANTACAO.md §8.
import { defineConfig, devices } from '@playwright/test';

const APP_PORT = 4174;
const API_PORT = 8788;

export default defineConfig({
  testDir: 'e2e-cloud',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-cloud' }]] : 'list',
  use: {
    baseURL: `http://localhost:${APP_PORT}/`,
    trace: 'retain-on-failure',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
  },
  projects: [
    { name: 'android', use: { ...devices['Pixel 7'], viewport: { width: 360, height: 740 } } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, grep: /@desktop/ },
  ],
  webServer: [
    {
      command: 'node e2e-cloud/server.ts',
      url: `http://127.0.0.1:${API_PORT}/api/v1/ready`,
      reuseExistingServer: false,
      env: { E2E_API_PORT: String(API_PORT), E2E_APP_ORIGIN: `http://localhost:${APP_PORT}` },
      stdout: 'pipe',
      timeout: 60_000,
    },
    {
      command: `npx vite build --outDir dist-cloud --emptyOutDir && npx vite preview --outDir dist-cloud --port ${APP_PORT} --strictPort`,
      port: APP_PORT,
      reuseExistingServer: false,
      env: { BASE_PATH: '/', VITE_ACCOUNTS: 'on', API_PROXY_TARGET: `http://127.0.0.1:${API_PORT}` },
      timeout: 180_000,
    },
  ],
});
