import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { freshStart, loadSample } from './helpers';

// Fluxos críticos de backup e restauração na interface. Dados fictícios apenas.

async function finishOneWorkout(page: Page) {
  await page.getByTestId('start-workout').click();
  await expect(page.getByTestId('set-editor')).toBeVisible();
  await page.getByTestId('complete-set').click(); // aquecimento
  await page.getByTestId('rest-skip').click();
  await page.getByTestId('complete-set').click(); // série 1
  await page.getByTestId('rest-skip').click();
  await page.getByTestId('open-finish').click();
  await page.getByTestId('confirm-finish').click();
  await expect(page).toHaveURL(/#\/historico\/.+/);
}

async function exportBackup(page: Page, path: string) {
  await page.goto('./#/config');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-backup').click()]);
  await download.saveAs(path);
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function chooseBackup(page: Page, content: unknown) {
  await page.goto('./#/config');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Restaurar backup' }).click()]);
  await chooser.setFiles({ name: 'irontrack-backup.json', mimeType: 'application/json', buffer: Buffer.from(typeof content === 'string' ? content : JSON.stringify(content)) });
}

async function historyCount(page: Page) {
  await page.goto('./#/historico');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  // O subtítulo "N treinos registrados" só aparece quando a consulta ao banco terminou;
  // contar antes disso devolvia 0 de forma intermitente.
  await expect(page.getByText(/\d+ treinos registrados/)).toBeVisible();
  return page.getByTestId('history-item').count();
}

test('backup: prévia, cancelar, mesclar, substituir, recarregar', async ({ page }, info) => {
  await freshStart(page);
  await loadSample(page);
  await finishOneWorkout(page);

  // 1. Exportar
  const file = info.outputPath('backup.json');
  const backup = await exportBackup(page, file);
  expect(backup).toMatchObject({ app: 'irontrack', kind: 'backup', schemaVersion: 7 }); // P16: v6 (decisões do calendário); P17: v7 (biblioteca de exercícios)
  expect(backup.data.goals).toEqual([]);
  expect(backup.data.calendarDecisions).toEqual([]);
  expect(backup.profile.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(backup.data.sessions).toHaveLength(1);

  // 2–4. Importar o mesmo arquivo: prévia mostra só duplicatas; cancelar não altera nada
  await chooseBackup(page, backup);
  const preview = page.getByTestId('restore-preview');
  await expect(preview).toBeVisible();
  await expect(page.getByTestId('merge-summary')).toContainText('0 a adicionar');
  await expect(page.getByTestId('merge-summary')).toContainText('0 conflitos');
  await expect(page.getByTestId('replace-summary')).toContainText('Apaga os');
  // sem rolagem horizontal na prévia (360 px no Android)
  expect(await preview.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('preview.png') });
  await page.getByTestId('backup-cancel').click();
  await expect(preview).toBeHidden();
  expect(await historyCount(page)).toBe(1);

  // 5. Mesclar: backup com um treino distinto e uma avaliação nova
  const s0 = backup.data.sessions[0];
  const extra = structuredClone(backup);
  extra.data.sessions.push({ ...s0, id: 'e2e-sessao-extra', startedAt: s0.startedAt - 86_400_000, finishedAt: s0.finishedAt - 86_400_000 });
  extra.data.bodyEntries.push({ id: 'e2e-avaliacao', profileId: backup.profile.id, date: '2026-01-10', weightKg: 80, createdAt: 1 });
  await chooseBackup(page, extra);
  await expect(page.getByTestId('merge-summary')).toContainText('2 a adicionar');
  await page.getByTestId('backup-merge').click();
  await expect(page.getByText('Backup mesclado')).toBeVisible();
  await expect(preview).toBeHidden();
  expect(await historyCount(page)).toBe(2);

  // 9–10. Recarregar e confirmar persistência
  await page.reload();
  await expect(page.getByTestId('history-item')).toHaveCount(2);

  // 6. Substituir pelo backup original
  await chooseBackup(page, backup);
  await page.getByTestId('backup-replace').click();
  await page.getByRole('button', { name: 'Substituir', exact: true }).click();
  await expect(page.getByText('Backup restaurado')).toBeVisible();
  expect(await historyCount(page)).toBe(1);
  await page.reload();
  await expect(page.getByTestId('history-item')).toHaveCount(1);
  await page.goto('./#/');
  await expect(page.locator('main')).toContainText(/Treino\s*B|Próximo: Treino B/);
});

test('backup: conflitos exigem confirmação explícita e são informados', async ({ page }, info) => {
  await freshStart(page);
  await loadSample(page);
  await finishOneWorkout(page);
  const backup = await exportBackup(page, info.outputPath('backup.json'));

  // Mesmo ID, conteúdo diferente (editado em "outro aparelho") + um treino novo
  const conflicted = structuredClone(backup);
  conflicted.data.sessions[0].notes = 'versão do outro aparelho';
  conflicted.data.sessions.push({ ...backup.data.sessions[0], id: 'e2e-novo', startedAt: backup.data.sessions[0].startedAt - 86_400_000 });
  await chooseBackup(page, conflicted);
  await expect(page.getByTestId('merge-summary')).toContainText('1 conflitos');
  await expect(page.getByTestId('merge-kept')).toContainText('mantido');
  await expect(page.getByTestId('merge-partial-warning')).toContainText('1 registro(s) do backup não serão restaurados');
  const merge = page.getByTestId('backup-merge');
  await expect(merge).toBeDisabled();
  const dlg = page.getByTestId('restore-preview');
  expect(await dlg.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('conflitos.png') });

  // Cancelar mantém tudo como estava
  await page.getByTestId('backup-cancel').click();
  expect(await historyCount(page)).toBe(1);

  // Confirmar explicitamente e mesclar
  await chooseBackup(page, conflicted);
  await expect(page.getByTestId('backup-merge')).toBeDisabled();
  await page.getByTestId('accept-partial').check();
  await expect(page.getByTestId('backup-merge')).toBeEnabled();
  await page.getByTestId('backup-merge').click();
  await expect(page.getByText('Backup mesclado parcialmente')).toBeVisible();
  await expect(page.getByText(/1 registro\(s\) do backup não foram restaurados/)).toBeVisible();
  expect(await historyCount(page)).toBe(2);
  await page.reload();
  await expect(page.getByTestId('history-item')).toHaveCount(2);
});

test('backup: arquivos incompatíveis ou inconsistentes são rejeitados sem alterar dados', async ({ page }) => {
  await freshStart(page);
  await loadSample(page);
  await finishOneWorkout(page);

  // JSON inválido
  await chooseBackup(page, '{ isto não é json');
  await expect(page.getByText('Backup inválido')).toBeVisible();
  await expect(page.getByTestId('restore-preview')).toBeHidden();

  // Ficha de treino no lugar do backup
  await chooseBackup(page, readFileSync('public/examples/ficha-abc-exemplo.json', 'utf8'));
  await expect(page.getByText(/ficha de treino/).first()).toBeVisible();
  await expect(page.getByTestId('restore-preview')).toBeHidden();

  // Versão futura
  await chooseBackup(page, { app: 'irontrack', kind: 'backup', schemaVersion: 99, exportedAt: '', data: {} });
  await expect(page.getByText(/versão mais nova/).first()).toBeVisible();

  // Estrutura válida, mas IDs repetidos com conteúdos diferentes: prévia bloqueia
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-backup').click()]);
  const b = JSON.parse(readFileSync((await download.path())!, 'utf8'));
  b.data.sessions.push({ ...b.data.sessions[0], notes: 'conteúdo diferente' });
  await chooseBackup(page, b);
  await expect(page.getByTestId('restore-blocked')).toBeVisible();
  await expect(page.getByTestId('backup-merge')).toHaveCount(0);
  await expect(page.getByTestId('backup-replace')).toHaveCount(0);
  await page.getByTestId('backup-cancel').click();

  expect(await historyCount(page)).toBe(1);
});

test('backup: treino em andamento é recuperado após restaurar', async ({ page }, info) => {
  await freshStart(page);
  await loadSample(page);
  await page.getByTestId('start-workout').click();
  await page.getByTestId('complete-set').click(); // aquecimento concluído
  await page.getByTestId('rest-skip').click();
  await expect(page.getByTestId('set-editor')).toContainText('Série 1 de 3');

  const file = info.outputPath('backup-ativo.json');
  const backup = await exportBackup(page, file);
  expect(backup.data.sessions.filter((s: { status: string }) => s.status === 'active')).toHaveLength(1);

  // Apaga tudo e restaura
  await page.getByRole('button', { name: 'Apagar todos os dados' }).click();
  await page.getByRole('button', { name: 'Apagar tudo' }).click();
  await expect(page.getByText('Dados apagados')).toBeVisible();
  await chooseBackup(page, backup);
  await page.getByTestId('backup-replace').click();
  await page.getByRole('button', { name: 'Substituir', exact: true }).click();
  await expect(page.getByText('Backup restaurado')).toBeVisible();

  await page.reload();
  await page.goto('./#/');
  await page.getByTestId('continue-workout').click();
  await expect(page.getByTestId('set-editor')).toContainText('Série 1 de 3');
});

test('integridade: diagnóstico local não altera dados', async ({ page }) => {
  await freshStart(page);
  await loadSample(page);
  await page.goto('./#/config');
  await page.getByTestId('check-integrity').click();
  await expect(page.getByTestId('integrity-report')).toContainText('Nenhum problema encontrado');
});
