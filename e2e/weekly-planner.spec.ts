import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { freshStart, loadSample, setValue } from './helpers';

// Planejamento semanal (IronTrack 2.0 F01/P13), no Android 360 px e no desktop: perfil → rotina → planejamento →
// treino específico → iniciar pelo painel → concluir → calendário → meta semanal → exceção → navegação → backup →
// restauração → offline → duas abas → sem rolagem horizontal. Funciona em qualquer dia da semana. Dados fictícios.

const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const localToday = (page: Page) =>
  page.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
const plusDays = (iso: string, n: number) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const dayCell = (page: Page, date: string) => page.locator(`[data-testid="week-day"][data-date="${date}"]`);

test('planejamento: planejar, iniciar, concluir, meta, exceção, semanas, backup, offline e duas abas', async ({ page, context }, info) => {
  // 1. Perfil local e 2. rotina (ficha ABC de exemplo).
  await freshStart(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.goto('./#/config');
  const name = page.getByTestId('profile-name');
  await name.fill('Perfil do planejamento');
  await name.blur();
  await page.goto('./#/');
  await loadSample(page);
  const today = await localToday(page);

  // Meta semanal (P12) para conferir a integração.
  await page.goto('./#/metas');
  await page.getByTestId('new-goal').click();
  await page.getByTestId('goal-type').selectOption('weekly_frequency');
  await setValue(page, 'goal-target', '2');
  await setValue(page, 'goal-title', 'Treinar 2x por semana');
  await page.getByTestId('goal-save').click();
  await expect(page.getByTestId('goal-form')).toBeHidden();

  // 3. Planejamento pela tela Treinos (sem novo item na navegação).
  await page.goto('./#/treinos');
  await page.getByTestId('open-planner').click();
  await expect(page).toHaveURL(/#\/planejamento$/);
  await expect(page.getByTestId('plan-day')).toHaveAttribute('data-date', today);
  await expect(page.getByTestId('plan-day-empty')).toContainText('Sem atividade planejada');
  await expect(page.getByTestId('cons-realized')).toContainText('Sem planejamento');
  expect(await noHorizontalScroll(page)).toBe(true);

  // 4. Treino específico (B) no modelo semanal deste dia da semana — a rotação indica o A.
  await page.getByTestId('plan-add').click();
  await expect(page.getByTestId('plan-form')).toBeVisible();
  const optB = page.getByTestId('plan-workout').locator('option', { hasText: 'Treino B' });
  await page.getByTestId('plan-workout').selectOption((await optB.getAttribute('value'))!);
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.getByTestId('plan-save').click();
  await expect(page.getByTestId('plan-form')).toBeHidden();
  const activity = page.getByTestId('plan-activity').first();
  await expect(activity.getByTestId('plan-activity-title')).toContainText('Treino B');
  await expect(activity).toHaveAttribute('data-status', 'pendente');
  await expect(page.getByTestId('plan-rotation-note')).toContainText('Treino A');
  await expect(page.getByTestId('plan-day')).toHaveAttribute('data-state', 'planejado');

  // 5. Iniciar o treino planejado: escolha explícita (planejado × rotação), nada muda antes dela.
  await activity.getByTestId('plan-start').click();
  await expect(page.getByTestId('plan-start-choice')).toBeVisible();
  await page.getByTestId('start-planned').click();
  await expect(page).toHaveURL(/#\/treino$/);
  await expect(page.getByTestId('set-editor')).toContainText('Puxada frontal');

  // 6. Concluir a sessão pelo fluxo normal.
  await page.getByTestId('complete-set').click();
  await page.getByTestId('rest-skip').click();
  await expect(page.getByTestId('set-editor')).toContainText('Série 1 de 3');
  await page.getByTestId('complete-set').click();
  await page.getByTestId('rest-skip').click();
  await page.getByTestId('open-finish').click();
  await page.getByTestId('confirm-finish').click();
  await expect(page).toHaveURL(/#\/historico\/.+/);

  // 7. Calendário: dia concluído, sessão associada, sem duplicar.
  await page.goto('./#/planejamento');
  await expect(page.getByTestId('plan-day')).toHaveAttribute('data-state', 'concluido');
  await expect(page.getByTestId('plan-activity').first()).toHaveAttribute('data-status', 'realizada');
  await expect(dayCell(page, today)).toHaveAttribute('data-state', 'concluido');
  await expect(page.getByTestId('plan-session')).toHaveCount(1);
  await expect(page.getByTestId('plan-session').first()).toHaveAttribute('data-extra', 'false');
  await expect(page.getByTestId('cons-sessions')).toContainText('1');
  await expect(page.getByTestId('cons-realized')).toContainText('1 de 1');

  // 8. Meta semanal pelo motor de metas.
  await expect(page.getByTestId('plan-goal-progress')).toContainText('1 de 2 sessões');
  await expect(page.getByTestId('plan-goal-state')).toContainText('Em andamento');
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.screenshot({ path: info.outputPath('planejamento-concluido.png') });

  // 9. Exceção: na próxima semana, só neste dia, descanso — o modelo continua nas outras semanas.
  const nextSame = plusDays(today, 7);
  await page.getByTestId('week-next').click();
  await dayCell(page, nextSame).click();
  await expect(page.getByTestId('plan-day')).toHaveAttribute('data-date', nextSame);
  await expect(page.getByTestId('plan-activity-title').first()).toContainText('Treino B');
  await page.getByTestId('scope-date').click();
  await page.getByTestId('plan-rest').click();
  await page.getByRole('button', { name: 'Marcar descanso' }).click();
  await expect(page.getByTestId('plan-day-empty')).toContainText('Descanso planejado');
  await expect(page.getByTestId('plan-day-source')).toContainText('exceção');

  // 10. Navegar entre semanas: a seguinte mantém o modelo; a anterior não tinha plano; voltar para hoje.
  await page.getByTestId('week-next').click();
  await dayCell(page, plusDays(today, 14)).click();
  await expect(page.getByTestId('plan-activity-title').first()).toContainText('Treino B');
  await page.getByTestId('week-today').click();
  await expect(page.getByTestId('plan-day')).toHaveAttribute('data-date', today);
  await page.getByTestId('week-prev').click();
  await expect(page.getByTestId('cons-realized')).toContainText('Sem planejamento');
  await expect(page.getByTestId('cons-sessions')).toContainText('0');
  await page.getByTestId('week-today').click();
  // Teclado: setas mudam o dia selecionado (para trás, ou para a frente se hoje for segunda).
  const isMonday = (await page.getByTestId('week-day').first().getAttribute('data-date')) === today;
  await dayCell(page, today).focus();
  await page.keyboard.press(isMonday ? 'ArrowRight' : 'ArrowLeft');
  await expect(page.getByTestId('plan-day')).toHaveAttribute('data-date', plusDays(today, isMonday ? 1 : -1));
  await expect(page.locator('[data-testid="week-day"][aria-pressed="true"]')).toHaveCount(1);
  await dayCell(page, today).click();

  // 11. Exportar backup (v5 com o planejamento).
  await page.goto('./#/config');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-backup').click()]);
  const file = info.outputPath('backup-planejamento.json');
  await download.saveAs(file);
  const backup = JSON.parse(readFileSync(file, 'utf8'));
  expect(backup.schemaVersion).toBe(5);
  expect(backup.data.planEntries).toHaveLength(2);
  expect(JSON.stringify(backup.data.planEntries)).toContain('"kind":"rest"');

  // 12. Apagar tudo e restaurar; 13. planejamento de volta, com a sessão associada.
  await page.getByRole('button', { name: 'Apagar todos os dados' }).click();
  await page.getByRole('button', { name: 'Apagar tudo' }).click();
  await page.goto('./#/planejamento');
  await expect(page.getByTestId('plan-day-empty')).toBeVisible();
  await page.goto('./#/config');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Restaurar backup' }).click()]);
  await chooser.setFiles({ name: 'irontrack-backup.json', mimeType: 'application/json', buffer: readFileSync(file) });
  await expect(page.getByTestId('restore-preview')).toContainText('Planejamento');
  await page.getByTestId('backup-replace').click();
  await page.getByRole('button', { name: 'Substituir', exact: true }).click();
  await page.goto('./#/planejamento');
  await expect(page.getByTestId('plan-activity').first()).toHaveAttribute('data-status', 'realizada');
  await page.getByTestId('week-next').click();
  await dayCell(page, nextSame).click();
  await expect(page.getByTestId('plan-day-empty')).toContainText('Descanso planejado');

  // 14. Offline: o painel abre e calcula tudo no aparelho.
  await page.goto('./#/planejamento');
  await page.reload();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId('plan-day')).toHaveAttribute('data-state', 'concluido');
  await context.setOffline(false);

  // 15. Duas abas: edição aberta numa aba enquanto a outra remove → aviso, nada sobrescrito; atualização ao vivo.
  const other = await context.newPage();
  await other.goto(page.url());
  await page.getByTestId('plan-item-edit').first().click();
  await expect(page.getByTestId('plan-form')).toBeVisible();
  await other.getByTestId('plan-item-remove').first().click();
  await other.getByRole('button', { name: 'Remover', exact: true }).click();
  await expect(other.getByTestId('plan-day-empty')).toBeVisible();
  await expect(page.getByTestId('plan-changed-elsewhere')).toBeVisible();
  await page.getByTestId('plan-save').click();
  await expect(page.getByTestId('plan-form-error')).toBeVisible();
  await page.getByRole('button', { name: 'Cancelar' }).click();
  await expect(page.getByTestId('plan-day-empty')).toBeVisible();
  // A sessão continua registrada no dia em que aconteceu (agora fora do planejado); nada foi apagado.
  await expect(page.getByTestId('plan-session').first()).toHaveAttribute('data-extra', 'true');
  await other.close();

  // 16. Sem rolagem horizontal.
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.screenshot({ path: info.outputPath('planejamento.png'), fullPage: true });
});
