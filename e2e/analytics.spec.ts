import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { freshStart } from './helpers';

// Análise de desempenho (P08): página nova em Evolução, calculada só no aparelho. Dados fictícios apenas,
// carregados pela restauração de backup (mesclar), o mesmo caminho que o usuário usa.

const DAY = 86_400_000;

async function exportBackup(page: Page, path: string) {
  await page.goto('./#/config');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-backup').click()]);
  await download.saveAs(path);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function fakeSessions(profileId: string) {
  const now = Date.now();
  const sessions = [];
  for (let i = 0; i < 16; i++) {
    const startedAt = now - (80 - i * 5) * DAY;
    const load = 60 + i * 2.5;
    const set = (id: string, weight: number | null, reps: number) => ({ id, type: 'normal', status: 'done', weight, reps, completedAt: startedAt + 600_000 });
    sessions.push({
      id: `e2e-analytics-${i}`,
      profileId,
      routineId: 'rotina-excluida',
      workoutId: 'rotina-excluida-A',
      workoutLabel: 'A',
      workoutName: 'Treino A',
      status: 'completed',
      startedAt,
      finishedAt: startedAt + 3_600_000,
      durationSec: 3600,
      exercises: [
        {
          id: `e2e-x-${i}-1`,
          exerciseKey: 'supino ficticio',
          name: 'Supino fictício',
          muscleGroup: 'Peito',
          category: 'compound',
          equipment: 'barbell',
          repMin: 6,
          repMax: 10,
          restSec: 120,
          plannedSets: 2,
          sets: [set(`e2e-s-${i}-1`, load, 8), set(`e2e-s-${i}-2`, load, 8)],
        },
        {
          id: `e2e-x-${i}-2`,
          exerciseKey: 'barra ficticia',
          name: 'Barra fictícia',
          muscleGroup: 'Costas',
          category: 'compound',
          equipment: 'bodyweight',
          repMin: 6,
          repMax: 12,
          restSec: 120,
          plannedSets: 1,
          sets: [set(`e2e-s-${i}-3`, null, 6 + (i % 3))],
        },
      ],
      updatedAt: startedAt + 3_600_000,
    });
  }
  return sessions;
}

async function seed(page: Page, path: string) {
  const backup = await exportBackup(page, path);
  backup.data.sessions.push(...fakeSessions(backup.profile.id));
  await page.goto('./#/config');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Restaurar backup' }).click()]);
  await chooser.setFiles({ name: 'irontrack-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
  await page.getByTestId('backup-merge').click();
  await expect(page.getByText('Backup mesclado')).toBeVisible();
}

const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test('desempenho: vazio, dados fictícios, períodos, exercício, gráficos e layout', async ({ page }, info) => {
  await freshStart(page);

  // Sem treinos: a página explica o motivo.
  await page.goto('./#/evolucao');
  await page.getByTestId('open-analytics').click();
  await expect(page).toHaveURL(/#\/evolucao\/desempenho$/);
  await expect(page.getByText('Conclua seu primeiro treino para ver a análise de desempenho.')).toBeVisible();

  await seed(page, info.outputPath('backup.json'));
  await page.goto('./#/evolucao/desempenho');
  await expect(page.getByTestId('stat-sessions')).toBeVisible();

  // A navegação continua com os mesmos 6 itens e "Evolução" fica ativa na sub-rota.
  const nav = page.getByRole('navigation', { name: 'Principal' }).locator('visible=true');
  await expect(nav.getByRole('link')).toHaveCount(6);
  await expect(nav.getByRole('link', { name: 'Evolução' })).toHaveClass(/text-primary/);

  // 30 dias por padrão: 5 sessões fictícias (a cada 5 dias).
  await expect(page.getByRole('radio', { name: '30 dias' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('stat-sessions')).toContainText(/^Sessões5/);
  await expect(page.getByTestId('insight').first()).toBeVisible();
  await expect(page.getByTestId('chart-frequency').locator('svg.recharts-surface')).toBeVisible();
  await expect(page.getByTestId('chart-volume').locator('svg.recharts-surface')).toBeVisible();
  await expect(page.getByTestId('exercise-chart').locator('svg.recharts-surface')).toBeVisible();
  await expect(page.getByTestId('stat-volume')).toContainText('séries sem carga');
  expect(await noHorizontalScroll(page)).toBe(true);

  // Períodos pelo teclado, sem recarregar a página.
  const navigations: string[] = [];
  page.on('framenavigated', (f) => f === page.mainFrame() && navigations.push(f.url()));
  for (const label of ['7 dias', '60 dias', '90 dias', 'Tudo']) {
    const radio = page.getByRole('radio', { name: label });
    await radio.focus();
    await page.keyboard.press('Enter');
    await expect(radio).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('body')).not.toContainText(/NaN|Infinity/);
    expect(await noHorizontalScroll(page)).toBe(true);
  }
  expect(navigations).toEqual([]);
  await expect(page.getByTestId('stat-sessions')).toContainText(/^Sessões16/);
  await expect(page.getByTestId('period-range')).toContainText('dias');

  // Exercício: carga evolui; peso corporal só em repetições.
  await page.getByTestId('exercise-select').selectOption({ label: 'Supino fictício (16)' });
  await expect(page.getByTestId('exercise-trend')).toContainText('Evolução positiva');
  await expect(page.getByTestId('record-history')).toContainText('antes');
  await page.getByTestId('exercise-select').selectOption({ label: 'Barra fictícia (16)' });
  await expect(page.getByText('Exercício sem carga registrada')).toBeVisible();
  await expect(page.getByRole('radiogroup', { name: 'Métrica do exercício' }).getByRole('radio')).toHaveCount(1);
  expect(await noHorizontalScroll(page)).toBe(true);

  // Teclado: o seletor de exercício é alcançável e operável sem mouse.
  await page.getByTestId('exercise-select').focus();
  await page.keyboard.press('ArrowUp');
  await expect(page.getByTestId('exercise-select')).toBeFocused();

  // Voltar para Evolução pelo link do topo.
  await page.getByTestId('analytics-back').click();
  await expect(page).toHaveURL(/#\/evolucao$/);
});
