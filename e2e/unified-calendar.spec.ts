import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { freshStart, loadSample, setValue } from './helpers';

// Calendário unificado (IronTrack 2.0 F01/P14), no Android 360 px e no desktop: perfil → rotina → agenda anterior →
// planejamento → conflito → aviso → exceção → precedência → semana → mês → iniciar → concluir → calendário → Início →
// Treinos → metas → backup → restauração → offline → sem rolagem horizontal. Funciona em qualquer dia da semana.

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
const agendaDay = (page: Page, date: string) => page.locator(`[data-testid="agenda-day"][data-date="${date}"]`);

async function selectPlannerDay(page: Page, date: string) {
  if ((await dayCell(page, date).count()) === 0) await page.getByTestId('week-next').click();
  await dayCell(page, date).click();
  await expect(page.getByTestId('plan-day')).toHaveAttribute('data-date', date);
}

test('calendário unificado: agenda anterior × planejamento, conflitos, exceção, semana, mês, treino, backup e offline', async ({ page, context }, info) => {
  test.setTimeout(150_000);
  // 1. Perfil local.
  await freshStart(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.goto('./#/config');
  const name = page.getByTestId('profile-name');
  await name.fill('Perfil do calendário');
  await name.blur();

  // 2. Rotina (ficha ABC de exemplo).
  await page.goto('./#/');
  await loadSample(page);
  const today = await localToday(page);
  const tomorrow = plusDays(today, 1);

  // 3. Agenda anterior: todos os dias de treino (independe do dia da semana) e um reagendamento amanhã (Treino C).
  await page.goto('./#/config');
  const group = page.getByText('Dias de treino', { exact: true }).locator('..');
  for (const d of ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom']) {
    const b = group.getByRole('button', { name: d, exact: true });
    if ((await b.getAttribute('aria-pressed')) === 'false') await b.click();
    await expect(b).toHaveAttribute('aria-pressed', 'true');
  }
  await expect(page.getByTestId('training-days-hint')).toContainText('agenda anterior');
  await page.goto('./#/treinos');
  await expect(page.getByTestId('agenda-day')).toHaveCount(14);
  await expect(agendaDay(page, today)).toHaveAttribute('data-origin', 'legacy');
  await agendaDay(page, tomorrow).click();
  const dialog = page.getByTestId('agenda-day-dialog');
  await expect(dialog.getByTestId('agenda-legacy-edit')).toContainText('O planejamento semanal não muda');
  const optC = dialog.getByLabel('Treino para reagendar').locator('option', { hasText: 'Treino C' });
  await dialog.getByLabel('Treino para reagendar').selectOption((await optC.getAttribute('value'))!);
  await dialog.getByRole('button', { name: 'Definir' }).click();
  await expect(dialog).toBeHidden();
  await expect(agendaDay(page, tomorrow)).toHaveAttribute('aria-label', /Treino C.*reagendado na agenda anterior/);

  // Meta semanal (P12) para conferir a integração.
  await page.goto('./#/metas');
  await page.getByTestId('new-goal').click();
  await page.getByTestId('goal-type').selectOption('weekly_frequency');
  await setValue(page, 'goal-target', '2');
  await setValue(page, 'goal-title', 'Treinar 2x por semana');
  await page.getByTestId('goal-save').click();
  await expect(page.getByTestId('goal-form')).toBeHidden();

  // Sem planejamento: a agenda anterior aparece como sugestão no Planejamento.
  await page.goto('./#/planejamento');
  await expect(page.getByTestId('plan-day')).toHaveAttribute('data-origin', 'legacy');
  await expect(page.getByTestId('plan-legacy')).toHaveAttribute('data-defines', 'true');
  await expect(page.getByTestId('plan-legacy-text')).toContainText('Treino A');

  // 4. Planejamento semanal: Treino B toda semana neste dia (a agenda anterior sugere A) → 5. conflito.
  await page.getByTestId('plan-add').click();
  const optB = page.getByTestId('plan-workout').locator('option', { hasText: 'Treino B' });
  await page.getByTestId('plan-workout').selectOption((await optB.getAttribute('value'))!);
  await page.getByTestId('plan-save').click();
  await expect(page.getByTestId('plan-form')).toBeHidden();

  // 6. Aviso compreensível, sem resolver nada sozinho.
  await expect(page.getByTestId('conflict-message').first()).toContainText('Seu planejamento indica Treino B');
  await expect(page.getByTestId('conflict-message').first()).toContainText('a agenda anterior sugere Treino A');
  await expect(dayCell(page, today)).toHaveAttribute('data-warning', 'true');
  await expect(page.getByTestId('plan-legacy')).toHaveAttribute('data-defines', 'false');
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.getByTestId('conflict-details').click();
  await expect(page.getByTestId('conflict-detail-list')).toContainText('Agenda anterior');
  await page.getByTestId('conflict-keep').click();
  await expect(page.getByTestId('conflict-message')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('calendario-conflito.png') });

  // 7. Exceção: amanhã, só neste dia, descanso (a agenda anterior tem o reagendamento para o C).
  await selectPlannerDay(page, tomorrow);
  await expect(page.getByTestId('plan-day')).toHaveAttribute('data-origin', 'legacy');
  await page.getByTestId('scope-date').click();
  await page.getByTestId('plan-rest').click();
  await expect(page.getByTestId('plan-day-empty')).toContainText('Descanso planejado');

  // 8. Precedência: a exceção define o dia; a agenda anterior continua visível e a divergência é avisada.
  await expect(page.getByTestId('plan-day')).toHaveAttribute('data-origin', 'plan_exception');
  await expect(page.getByTestId('plan-day')).toHaveAttribute('data-status', 'rest');
  await expect(page.getByTestId('plan-legacy')).toHaveAttribute('data-defines', 'false');
  await expect(page.getByTestId('conflict-message').first()).toContainText('agenda anterior sugere Treino C');

  // 9. Navegar na semana.
  await page.getByTestId('week-next').click();
  await page.getByTestId('week-prev').click();
  await page.getByTestId('week-prev').click();
  await expect(page.getByTestId('week-today')).toBeVisible();
  await page.getByTestId('week-today').click();
  await expect(page.getByTestId('plan-day')).toHaveAttribute('data-date', today);

  // 10. Navegar no mês.
  await page.getByTestId('view-month').click();
  await expect(page.getByTestId('month-grid')).toBeVisible();
  await expect(page.locator(`[data-testid="month-day"][data-date="${today}"]`)).toHaveAttribute('aria-current', 'date');
  await expect(page.locator(`[data-testid="month-day"][data-date="${tomorrow}"]`)).toHaveAttribute('data-status', 'rest');
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.screenshot({ path: info.outputPath('calendario-mes.png'), fullPage: true });
  const label = await page.getByTestId('month-label').textContent();
  await page.getByTestId('month-next').click();
  await expect(page.getByTestId('month-label')).not.toHaveText(label!);
  await page.getByTestId('month-prev').click();
  await page.getByTestId('month-prev').click();
  await page.getByTestId('month-today').click();
  await expect(page.getByTestId('month-label')).toHaveText(label!);
  await expect(page.getByTestId('plan-day')).toHaveAttribute('data-date', today);
  // Teclado: setas movem o dia selecionado na grade.
  const gridDates = await page.getByTestId('month-day').evaluateAll((els) => els.map((e) => e.getAttribute('data-date')));
  const back = gridDates.indexOf(today) > 0;
  await page.locator(`[data-testid="month-day"][data-date="${today}"]`).focus();
  await page.keyboard.press(back ? 'ArrowLeft' : 'ArrowRight');
  await expect(page.getByTestId('plan-day')).toHaveAttribute('data-date', plusDays(today, back ? -1 : 1));
  await page.getByTestId('view-week').click();
  if (await page.getByTestId('week-today').isVisible()) await page.getByTestId('week-today').click();
  await dayCell(page, today).click();

  // 11. Iniciar pela Início: o planejado (B) difere da rotação (A) → escolha explícita.
  await page.goto('./#/');
  await expect(page.getByTestId('home-today')).toHaveAttribute('data-origin', 'plan_recurring');
  await expect(page.getByTestId('home-conflict')).toContainText('Seu planejamento indica Treino B');
  await expect(page.getByTestId('home-next')).toBeVisible();
  await expect(page.getByTestId('home-rotation')).toContainText('Treino A');
  await page.getByTestId('start-workout').click();
  await expect(page.getByTestId('plan-start-choice')).toBeVisible();
  await page.getByTestId('start-planned').click();
  await expect(page).toHaveURL(/#\/treino$/);
  await expect(page.getByTestId('set-editor')).toContainText('Puxada frontal');

  // 12. Concluir a sessão pelo fluxo normal.
  await page.getByTestId('complete-set').click();
  await page.getByTestId('rest-skip').click();
  await page.getByTestId('complete-set').click();
  await page.getByTestId('rest-skip').click();
  await page.getByTestId('open-finish').click();
  await page.getByTestId('confirm-finish').click();
  await expect(page).toHaveURL(/#\/historico\/.+/);

  // 13. Calendário: sessão é fato, associada ao planejado, sem duplicar; a divergência de hoje some (já foi feito).
  await page.goto('./#/planejamento');
  await expect(page.getByTestId('plan-day')).toHaveAttribute('data-status', 'done');
  await expect(page.getByTestId('plan-session')).toHaveCount(1);
  await expect(page.getByTestId('plan-session').first()).toHaveAttribute('data-extra', 'false');
  await expect(page.getByTestId('conflict-message')).toHaveCount(0);

  // 16. Metas pelo motor de metas.
  await expect(page.getByTestId('plan-goal-progress')).toContainText('1 de 2 sessões');

  // 14. Início consistente com o Planejamento.
  await page.goto('./#/');
  await expect(page.getByTestId('home-done')).toContainText('Treino B feito');
  await expect(page.locator(`[data-testid="home-week-day"][data-status="done"]`)).toHaveCount(1);
  expect(await noHorizontalScroll(page)).toBe(true);

  // 15. Treinos consistente: hoje concluído, amanhã pela exceção (descanso), rotação seguiu a regra de sempre.
  await page.goto('./#/treinos');
  await expect(agendaDay(page, today)).toHaveAttribute('data-status', 'done');
  await expect(agendaDay(page, tomorrow)).toHaveAttribute('data-origin', 'plan_exception');
  await expect(agendaDay(page, tomorrow)).toHaveAttribute('data-warning', 'true');
  await expect(page.getByLabel('Corrigir próximo treino da sequência').locator('option:checked')).toContainText('Treino C');
  expect(await noHorizontalScroll(page)).toBe(true);
  await agendaDay(page, tomorrow).click();
  await expect(page.getByTestId('agenda-day-dialog')).toContainText('Planejamento só deste dia (exceção)');
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.keyboard.press('Escape');

  // 17. Exportar backup (v5, com o planejamento e a agenda anterior intactos).
  await page.goto('./#/config');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-backup').click()]);
  const file = info.outputPath('backup-calendario.json');
  await download.saveAs(file);
  const backup = JSON.parse(readFileSync(file, 'utf8'));
  expect(backup.schemaVersion).toBe(6);
  expect(backup.data.planEntries).toHaveLength(2);
  expect(backup.data.overrides).toHaveLength(1);
  expect(backup.data.overrides[0]).toMatchObject({ date: tomorrow, kind: 'workout' });
  expect(JSON.stringify(backup)).not.toMatch(/conflict|forecast|resolved/i); // nada calculado é persistido

  // 18. Apagar tudo e restaurar (substituir): tudo volta igual.
  await page.getByRole('button', { name: 'Apagar todos os dados' }).click();
  await page.getByRole('button', { name: 'Apagar tudo' }).click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Restaurar backup' }).click()]);
  await chooser.setFiles({ name: 'irontrack-backup.json', mimeType: 'application/json', buffer: readFileSync(file) });
  await expect(page.getByTestId('restore-preview')).toContainText('Planejamento');
  await page.getByTestId('backup-replace').click();
  await page.getByRole('button', { name: 'Substituir', exact: true }).click();
  await page.goto('./#/planejamento');
  await expect(page.getByTestId('plan-day')).toHaveAttribute('data-status', 'done');
  await selectPlannerDay(page, tomorrow);
  await expect(page.getByTestId('plan-day')).toHaveAttribute('data-origin', 'plan_exception');
  await expect(page.getByTestId('conflict-message').first()).toContainText('agenda anterior sugere Treino C');

  // 19. Offline: o calendário abre e resolve tudo no aparelho.
  await page.goto('./#/planejamento');
  await page.reload();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId('plan-day')).toHaveAttribute('data-status', 'done');
  await page.getByTestId('view-month').click();
  await expect(page.getByTestId('month-grid')).toBeVisible();
  await context.setOffline(false);

  // 20. Sem rolagem horizontal.
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.screenshot({ path: info.outputPath('calendario.png'), fullPage: true });
});
