import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { freshStart, loadSample, storageOutsideAux } from './helpers';

// Consolidação de agendas (IronTrack 2.0 F01/P15), no Android 360 px e no desktop: perfil → agenda antiga →
// planejamento → prévia da importação → conflitos → importar só dias vazios → calendário → Início → Treinos →
// desfazer → reimportar → preferências → Semana/Mês → backup → restauração → integridade → offline → duas abas →
// sem rolagem horizontal. Funciona em qualquer dia da semana. Dados fictícios.

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
const weekdayOf = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};
const agendaDay = (page: Page, date: string) => page.locator(`[data-testid="agenda-day"][data-date="${date}"]`);
const importItem = (page: Page, key: string) => page.locator(`[data-testid="import-item"][data-key="${key}"]`);
const planCount = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const req = indexedDB.open('irontrack');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const tx = req.result.transaction('planEntries', 'readonly');
          const c = tx.objectStore('planEntries').count();
          c.onsuccess = () => {
            resolve(c.result);
            req.result.close();
          };
        };
      }),
  );

async function confirmImport(page: Page) {
  await page.getByTestId('import-confirm').click();
  await expect(page.getByTestId('import-confirm-dialog')).toBeVisible();
  await page.getByTestId('import-apply').click();
  await expect(page.getByTestId('import-confirm-dialog')).toBeHidden();
}

test('consolidação: prévia, importação segura, desfazer, reimportar, preferências, backup, offline e duas abas', async ({ page, context }, info) => {
  test.setTimeout(180_000);
  // 1. Perfil local.
  await freshStart(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.goto('./#/config');
  const name = page.getByTestId('profile-name');
  await name.fill('Perfil da consolidação');
  await name.blur();

  // 2. Agenda antiga: rotina ABC, todos os dias de treino, reagendamento amanhã (C) e descanso daqui a 3 dias.
  await page.goto('./#/');
  await loadSample(page);
  const today = await localToday(page);
  const tomorrow = plusDays(today, 1);
  const restDay = plusDays(today, 3);
  await page.goto('./#/config');
  const group = page.getByText('Dias de treino', { exact: true }).locator('..');
  for (const d of ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom']) {
    const b = group.getByRole('button', { name: d, exact: true });
    if ((await b.getAttribute('aria-pressed')) === 'false') await b.click();
    await expect(b).toHaveAttribute('aria-pressed', 'true');
  }
  await page.goto('./#/treinos');
  await agendaDay(page, tomorrow).click();
  let dialog = page.getByTestId('agenda-day-dialog');
  const optC = dialog.getByLabel('Treino para reagendar').locator('option', { hasText: 'Treino C' });
  await dialog.getByLabel('Treino para reagendar').selectOption((await optC.getAttribute('value'))!);
  await dialog.getByRole('button', { name: 'Definir' }).click();
  await expect(dialog).toBeHidden();
  await agendaDay(page, restDay).click();
  dialog = page.getByTestId('agenda-day-dialog');
  await dialog.getByRole('button', { name: 'Marcar como descanso' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('treinos-open-import')).toBeVisible();

  // 3. Planejamento: Treino B toda semana no dia de hoje (a agenda antiga indica a rotação → conflito).
  await page.goto('./#/planejamento');
  await expect(page.getByTestId('plan-day')).toHaveAttribute('data-date', today);
  await page.getByTestId('plan-add').click();
  const optB = page.getByTestId('plan-workout').locator('option', { hasText: 'Treino B' });
  await page.getByTestId('plan-workout').selectOption((await optB.getAttribute('value'))!);
  await page.getByTestId('plan-save').click();
  await expect(page.getByTestId('plan-form')).toBeHidden();
  expect(await planCount(page)).toBe(1);

  // 4. Prévia da importação (aberta pelo Planejamento), no modo seguro (padrão).
  await page.getByTestId('open-import').click();
  await expect(page).toHaveURL(/#\/planejamento\/importar$/);
  await expect(page.getByTestId('import-overview')).toBeVisible();
  await expect(page.getByTestId('mode-empty').locator('xpath=..')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('ov-days')).toContainText('Seg');
  await expect(page.getByTestId('ov-overrides')).toHaveText('1');
  await expect(page.getByTestId('ov-rest')).toHaveText('1');
  expect(await noHorizontalScroll(page)).toBe(true);

  // 5. Conflitos: hoje tem Treino B planejado → manter e pedir decisão; reagendamento e descanso → criar.
  const todayKey = `weekday:${weekdayOf(today)}`;
  await expect(page.getByTestId('ov-conflicts')).toHaveText('1');
  await expect(importItem(page, todayKey)).toHaveAttribute('data-outcome', 'keep');
  await expect(importItem(page, todayKey).getByTestId('import-item-proposal')).toContainText('Manter Treino B');
  await expect(importItem(page, `date:${tomorrow}`)).toHaveAttribute('data-outcome', 'create');
  await expect(importItem(page, `date:${tomorrow}`).getByTestId('import-item-proposal')).toContainText('Treino C');
  await expect(importItem(page, `date:${restDay}`).getByTestId('import-item-proposal')).toContainText('descanso');
  await expect(page.getByTestId('ov-create')).toHaveText('8');
  expect(await planCount(page)).toBe(1); // a prévia não grava
  await page.screenshot({ path: info.outputPath('importacao-previa.png'), fullPage: true });
  // Revisar conflitos mostra as três escolhas, com "manter" marcado.
  await page.getByTestId('mode-review').click();
  await expect(importItem(page, todayKey).getByTestId('decision-keep')).toBeChecked();
  await page.getByTestId('mode-empty').click();

  // 6. Importar só os dias vazios.
  await confirmImport(page);
  await expect(page.getByTestId('import-last')).toHaveAttribute('data-status', 'applied');
  await expect.poll(() => planCount(page)).toBe(9);

  // 7. Calendário: amanhã pela exceção (Treino C), hoje continua o Treino B (conflito mantido, não escondido).
  await page.goto('./#/planejamento');
  await expect(page.getByTestId('plan-day')).toHaveAttribute('data-origin', 'plan_recurring');
  await expect(page.getByTestId('conflict-message').first()).toContainText('Seu planejamento indica Treino B');
  if ((await page.locator(`[data-testid="week-day"][data-date="${tomorrow}"]`).count()) === 0) await page.getByTestId('week-next').click();
  await page.locator(`[data-testid="week-day"][data-date="${tomorrow}"]`).click();
  await expect(page.getByTestId('plan-day')).toHaveAttribute('data-date', tomorrow);
  await expect(page.getByTestId('plan-day')).toHaveAttribute('data-origin', 'plan_exception');
  await expect(page.getByTestId('plan-activity-title')).toContainText('Treino C');
  await expect(page.getByTestId('plan-legacy')).toHaveAttribute('data-agrees', 'true'); // mostrado uma vez só
  // Central de divergências: o conflito de hoje aparece com origem e impacto.
  await page.getByTestId('open-conflict-center').click();
  await expect(page.locator('[data-testid="conflict-group"][data-kind="plan_vs_legacy_workout"]')).toContainText('Impacto');
  expect(await noHorizontalScroll(page)).toBe(true);

  // 8. Início: hoje planejado (B) com origem, divergência visível; a próxima atividade não se repete.
  await page.goto('./#/');
  await expect(page.getByTestId('home-today')).toHaveAttribute('data-origin', 'plan_recurring');
  await expect(page.getByTestId('home-today-source')).toContainText('Planejado');
  await expect(page.getByTestId('home-conflict')).toContainText('Treino B');
  await expect(page.getByTestId('home-next')).toContainText('Treino C');
  expect(await noHorizontalScroll(page)).toBe(true);

  // 9. Treinos: agenda de 14 dias consistente; agenda antiga intacta (o reagendamento continua lá).
  await page.goto('./#/treinos');
  await expect(page.getByTestId('agenda-day')).toHaveCount(14);
  await expect(agendaDay(page, tomorrow)).toHaveAttribute('data-origin', 'plan_exception');
  await agendaDay(page, tomorrow).click();
  await expect(page.getByTestId('agenda-legacy-edit')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Voltar ao padrão' })).toBeVisible(); // reagendamento preservado
  await page.keyboard.press('Escape');
  expect(await noHorizontalScroll(page)).toBe(true);

  // 10. Desfazer a importação (com confirmação): volta só o planejamento manual.
  await page.goto('./#/planejamento/importar');
  await page.getByTestId('import-undo').click();
  await expect(page.getByTestId('import-undo-dialog')).toHaveAttribute('data-ok', 'true');
  await page.getByTestId('import-undo-apply').click();
  await expect(page.getByTestId('import-last')).toHaveAttribute('data-status', 'undone');
  await expect.poll(() => planCount(page)).toBe(1);

  // 11. Reimportar: cria de novo; uma terceira vez não duplica.
  await expect(page.getByTestId('ov-create')).toHaveText('8');
  await confirmImport(page);
  await expect.poll(() => planCount(page)).toBe(9);
  await expect(page.getByTestId('ov-create')).toHaveText('0');
  await expect(page.getByTestId('import-confirm')).toBeDisabled();

  // 12. Preferências de exibição: metas ocultas, sugestões ocultas, abrir no mês.
  await page.goto('./#/planejamento');
  await page.getByTestId('open-calendar-prefs').click();
  await page.getByTestId('pref-showGoals').click();
  await page.getByTestId('pref-view-month').click();
  await page.getByTestId('calendar-prefs-close').click();
  await expect(page.getByTestId('goals-hidden')).toBeVisible();
  const aux = await storageOutsideAux(page);
  expect(aux.other).toEqual([]); // a chave das preferências está no estado auxiliar documentado
  expect(aux.auxText).not.toMatch(/Treino|planEntries/);
  expect(await planCount(page)).toBe(9); // preferências não gravam no banco

  // 13. Semana/Mês: a preferência abre no mês; ?visao=semana e ?data= prevalecem; alternância manual.
  await page.reload();
  await expect(page.getByTestId('month-grid')).toBeVisible();
  await expect(page.locator(`[data-testid="month-day"][data-date="${today}"]`)).toHaveAttribute('aria-current', 'date');
  await expect(page.getByTestId('month-day-summary')).toContainText('hoje');
  await page.goto(`./#/planejamento?data=${tomorrow}&visao=semana`);
  await expect(page.getByTestId('week-strip')).toBeVisible();
  await expect(page.getByTestId('plan-day')).toHaveAttribute('data-date', tomorrow);
  await page.getByTestId('view-month').click();
  await expect(page.getByTestId('month-grid')).toBeVisible();
  await page.getByTestId('view-week').click();
  await expect(page.getByTestId('week-strip')).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);

  // 14. Exportar backup: v5, com o planejamento importado e a agenda antiga; sem o registro do desfazer.
  await page.goto('./#/config');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-backup').click()]);
  const file = info.outputPath('backup-consolidacao.json');
  await download.saveAs(file);
  const backup = JSON.parse(readFileSync(file, 'utf8'));
  expect(backup.schemaVersion).toBe(5);
  expect(backup.data.planEntries).toHaveLength(9);
  expect(backup.data.overrides).toHaveLength(2);
  expect(JSON.stringify(backup)).not.toMatch(/planImport|calendarPrefs/);

  // 15. Apagar tudo e restaurar (substituir).
  await page.getByRole('button', { name: 'Apagar todos os dados' }).click();
  await page.getByRole('button', { name: 'Apagar tudo' }).click();
  await expect.poll(() => planCount(page)).toBe(0);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Restaurar backup' }).click()]);
  await chooser.setFiles({ name: 'irontrack-backup.json', mimeType: 'application/json', buffer: readFileSync(file) });
  await expect(page.getByTestId('restore-preview')).toContainText('Planejamento');
  await page.getByTestId('backup-replace').click();
  await page.getByRole('button', { name: 'Substituir', exact: true }).click();
  await expect.poll(() => planCount(page)).toBe(9);

  // 16. Integridade: sem erros; reimportar continua sem duplicar; o registro do desfazer não voltou com o backup.
  await page.goto('./#/config');
  await page.getByTestId('check-integrity').click();
  await expect(page.getByTestId('integrity-report')).toContainText(/Nenhum problema encontrado|0 erro\(s\)/);
  await page.keyboard.press('Escape');
  await page.goto('./#/planejamento/importar');
  await expect(page.getByTestId('ov-create')).toHaveText('0');
  await expect(page.getByTestId('import-last')).toHaveCount(0);

  // 17. Offline: a prévia e o calendário funcionam no aparelho.
  await page.reload();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId('import-overview')).toBeVisible();
  await page.goto('./#/planejamento');
  await expect(page.getByTestId('plan-day')).toBeVisible();
  await context.setOffline(false);

  // 18. Duas abas: a segunda abre a confirmação, a primeira muda o planejamento → a segunda não grava nada.
  await page.goto('./#/planejamento');
  const ex = page.getByTestId('plan-day');
  await expect(ex).toHaveAttribute('data-date', today);
  const other = await context.newPage();
  await other.goto('./#/planejamento/importar');
  await other.getByTestId('mode-review').click();
  await importItem(other, todayKey).getByTestId('decision-legacy').check();
  await other.getByTestId('import-confirm').click();
  await expect(other.getByTestId('import-confirm-dialog')).toBeVisible();
  // Primeira aba: remove o Treino B de hoje (planejamento manual).
  await page.getByTestId('plan-item-remove').first().click();
  await page.getByRole('button', { name: 'Remover', exact: true }).click();
  await expect.poll(() => planCount(page)).toBeLessThan(10);
  const countAfterEdit = await planCount(page);
  await other.getByTestId('import-apply').click();
  await expect(other.getByText('mudaram desde a prévia')).toBeVisible();
  expect(await planCount(page)).toBe(countAfterEdit); // nada sobrescrito
  await expect(other.getByTestId('import-refreshed')).toBeVisible();
  // Preferência alterada numa aba chega na outra.
  await other.goto('./#/planejamento');
  await expect(other.getByTestId('month-grid')).toBeVisible(); // preferência "mês" da outra aba
  await page.getByTestId('open-calendar-prefs').click();
  await page.getByTestId('pref-showGoals').click();
  await page.getByTestId('calendar-prefs-close').click();
  await other.getByTestId('view-week').click();
  await expect(other.getByTestId('goals-hidden')).toHaveCount(0);
  await other.close();

  // 19. Sem rolagem horizontal.
  await page.goto('./#/planejamento/importar');
  await expect(page.getByTestId('import-overview')).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.screenshot({ path: info.outputPath('importacao.png'), fullPage: true });
});
