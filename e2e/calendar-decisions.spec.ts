import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { freshStart, loadSample, storageOutsideAux } from './helpers';

// Decisões lembradas e desfazer inteligente (IronTrack 2.0 F01/P16), no Android 360 px e no desktop: perfil →
// planejamento × agenda antiga divergentes → central → "Manter planejamento e lembrar" → recarregar → mudança
// irrelevante (decisão fica) → mudança relevante (aviso volta) → remover decisão → importar → editar entrada importada
// → prévia do desfazer → desfazer só os seguros → Início e Treinos → backup → offline → duas abas → sem rolagem
// horizontal. Funciona em qualquer dia da semana. Dados fictícios.

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
const agendaDay = (page: Page, date: string) => page.locator(`[data-testid="agenda-day"][data-date="${date}"]`);
const count = (page: Page, store: string) =>
  page.evaluate(
    (s) =>
      new Promise<number>((resolve, reject) => {
        const req = indexedDB.open('irontrack');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const tx = req.result.transaction(s, 'readonly');
          const c = tx.objectStore(s).count();
          c.onsuccess = () => {
            resolve(c.result);
            req.result.close();
          };
        };
      }),
    store,
  );
const planGroup = (page: Page) => page.locator('[data-testid="conflict-group"][data-kind="plan_vs_legacy_workout"]');
const warnings = (page: Page) => page.getByTestId('open-conflict-center');

/** Abre a central na tela Planejamento (dia de hoje) e lembra "manter planejamento" para a divergência de hoje. */
async function rememberToday(page: Page, today: string) {
  await page.goto(`./#/planejamento?data=${today}&visao=semana`);
  await warnings(page).click();
  await expect(page.getByTestId('conflict-center')).toBeVisible();
  const day = planGroup(page).locator(`[data-testid="conflict-group-day"][data-date="${today}"]`);
  await expect(day.getByTestId('cc-display-actions')).toContainText('não altera treinos');
  await expect(day.getByTestId('cc-plan-actions')).toContainText('Alteração de planejamento');
  await day.getByTestId('cc-remember').click();
  await expect.poll(() => count(page, 'calendarDecisions')).toBe(1);
}

async function confirmImport(page: Page) {
  await page.getByTestId('import-confirm').click();
  await expect(page.getByTestId('import-confirm-dialog')).toBeVisible();
  await page.getByTestId('import-apply').click();
  await expect(page.getByTestId('import-confirm-dialog')).toBeHidden();
}

test('decisões lembradas: lembrar, recarregar, invalidar, rever, desfazer parcial, backup, offline e duas abas', async ({ page, context }, info) => {
  test.setTimeout(180_000);
  // 1. Perfil local.
  await freshStart(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.goto('./#/config');
  const name = page.getByTestId('profile-name');
  await name.fill('Perfil das decisões');
  await name.blur();

  // 3. Agenda antiga: rotina ABC (próximo: Treino A), todos os dias de treino.
  await page.goto('./#/');
  await loadSample(page);
  const today = await localToday(page);
  const tomorrow = plusDays(today, 1);
  const later = plusDays(today, 4);
  await page.goto('./#/config');
  const group = page.getByText('Dias de treino', { exact: true }).locator('..');
  for (const d of ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom']) {
    const b = group.getByRole('button', { name: d, exact: true });
    if ((await b.getAttribute('aria-pressed')) === 'false') await b.click();
    await expect(b).toHaveAttribute('aria-pressed', 'true');
  }

  // 2. Planejamento: Treino B toda semana no dia de hoje → diverge da agenda antiga (Treino A).
  await page.goto('./#/planejamento');
  await expect(page.getByTestId('plan-day')).toHaveAttribute('data-date', today);
  await page.getByTestId('plan-add').click();
  const optB = page.getByTestId('plan-workout').locator('option', { hasText: 'Treino B' });
  await page.getByTestId('plan-workout').selectOption((await optB.getAttribute('value'))!);
  await page.getByTestId('plan-save').click();
  await expect(page.getByTestId('plan-form')).toBeHidden();
  await expect(page.getByTestId('conflict-notice')).toHaveAttribute('data-warning', 'true');
  const sessionsBefore = await count(page, 'sessions');

  // 4–5. Central de conflitos: "Manter planejamento e lembrar" (decisão de exibição; nada no planejamento muda).
  const plansBefore = await count(page, 'planEntries');
  await rememberToday(page, today);
  await expect(warnings(page)).toHaveAttribute('data-warnings', '0');
  await expect(page.getByTestId('cc-remembered-count')).toBeVisible();
  expect(await count(page, 'planEntries')).toBe(plansBefore);
  expect(await count(page, 'overrides')).toBe(0);
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.screenshot({ path: info.outputPath('decisoes-central.png'), fullPage: true });

  // 6–7. Recarregar: a decisão continua lembrada (sem aviso novo) e aparece em "Decisões lembradas".
  await page.reload();
  await expect(page.getByTestId('plan-day')).toHaveAttribute('data-date', today);
  await expect(page.getByTestId('conflict-notice')).toHaveAttribute('data-warning', 'false');
  await expect(page.getByTestId('conflict-remembered')).toBeVisible();
  await page.goto('./#/planejamento?decisoes=1');
  await expect(page.getByTestId('decision-item')).toHaveAttribute('data-status', 'active');
  await expect(page.getByTestId('decision-item')).toContainText('Manter o planejamento');

  // 8–9. Mudança irrelevante (descanso na agenda antiga em outra data): a decisão continua valendo.
  await page.goto('./#/treinos');
  await agendaDay(page, later).click();
  let dialog = page.getByTestId('agenda-day-dialog');
  await dialog.getByRole('button', { name: 'Marcar como descanso' }).click();
  await expect(dialog).toBeHidden();
  await page.goto('./#/planejamento?decisoes=1');
  await expect(page.getByTestId('decision-item')).toHaveAttribute('data-status', 'active');
  await page.goto('./#/');
  await expect(page.getByTestId('home-remembered')).toBeVisible();
  await expect(page.getByTestId('home-conflict')).toHaveCount(0);

  // 10–11. Mudança relevante (reagendar hoje para o Treino C na agenda antiga): o aviso reaparece.
  await page.goto('./#/treinos');
  await agendaDay(page, today).click();
  dialog = page.getByTestId('agenda-day-dialog');
  const optC = dialog.getByLabel('Treino para reagendar').locator('option', { hasText: 'Treino C' });
  await dialog.getByLabel('Treino para reagendar').selectOption((await optC.getAttribute('value'))!);
  await dialog.getByRole('button', { name: 'Definir' }).click();
  await expect(dialog).toBeHidden();
  await page.goto('./#/');
  await expect(page.getByTestId('home-conflict')).toContainText('Treino C');

  // 12. "Decisões lembradas": a decisão aparece invalidada (nunca como ativa) e é removida.
  await page.goto('./#/planejamento?decisoes=1');
  await expect(page.getByTestId('decision-item')).toHaveAttribute('data-status', 'invalidated');
  await page.getByTestId('decision-remove').click();
  await expect(page.getByTestId('decisions-empty')).toBeVisible();
  expect(await count(page, 'calendarDecisions')).toBe(0);

  // 13. Importar a agenda antiga (só dias vazios).
  await page.goto('./#/planejamento/importar');
  await expect(page.getByTestId('import-overview')).toBeVisible();
  await confirmImport(page);
  await expect(page.getByTestId('import-last')).toHaveAttribute('data-status', 'applied');
  const imported = await count(page, 'planEntries');
  expect(imported).toBeGreaterThan(2);

  // 14. Editar uma entrada importada (amanhã passa a ser Treino A, toda semana).
  await page.goto(`./#/planejamento?data=${tomorrow}&visao=semana`);
  await expect(page.getByTestId('plan-day')).toHaveAttribute('data-date', tomorrow);
  await page.getByTestId('plan-item-edit').first().click();
  await expect(page.getByTestId('plan-form')).toBeVisible();
  const optA = page.getByTestId('plan-workout').locator('option', { hasText: 'Treino A' });
  await page.getByTestId('plan-workout').selectOption((await optA.getAttribute('value'))!);
  await page.getByTestId('plan-save').click();
  await expect(page.getByTestId('plan-form')).toBeHidden();
  await expect(page.getByTestId('plan-activity-title').first()).toContainText('Treino A');

  // 15–16. Prévia do desfazer: itens seguros × alterados depois; "Desfazer tudo" não é oferecido.
  await page.goto('./#/planejamento/importar');
  await page.getByTestId('import-undo').click();
  const undo = page.getByTestId('import-undo-dialog');
  await expect(undo).toHaveAttribute('data-ok', 'false');
  await expect(undo.getByTestId('undo-safe').getByTestId('undo-item').first()).toBeVisible();
  await expect(undo.locator('[data-testid="undo-item"][data-status="modified"], [data-testid="undo-item"][data-status="deleted"]').first()).toBeVisible();
  await expect(undo.getByTestId('import-undo-apply')).toHaveCount(0);
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.screenshot({ path: info.outputPath('desfazer-previa.png'), fullPage: true });

  // 17–18. Desfazer só os seguros: a edição posterior e o planejamento manual ficam intactos.
  await undo.getByTestId('import-undo-partial').click();
  await expect(page.getByTestId('import-last')).toHaveAttribute('data-status', 'partial');
  await expect(page.getByTestId('import-undo')).toContainText('Rever itens pendentes');
  await page.goto(`./#/planejamento?data=${tomorrow}&visao=semana`);
  await expect(page.getByTestId('plan-activity-title').first()).toContainText('Treino A');
  await page.goto(`./#/planejamento?data=${today}&visao=semana`);
  await expect(page.getByTestId('plan-activity-title').first()).toContainText('Treino B');
  expect(await count(page, 'planEntries')).toBeLessThan(imported);
  expect(await count(page, 'overrides')).toBe(2); // agenda antiga intacta
  expect(await count(page, 'sessions')).toBe(sessionsBefore); // nenhuma sessão criada ou alterada

  // 19. Início e Treinos mostram o mesmo dia.
  await page.goto('./#/');
  await expect(page.getByTestId('home-today')).toHaveAttribute('data-origin', 'plan_recurring');
  await expect(page.getByTestId('home-conflict')).toContainText('Treino B');
  await page.goto('./#/treinos');
  await expect(page.getByTestId('agenda-day')).toHaveCount(14);
  await expect(agendaDay(page, today)).toHaveAttribute('data-origin', 'plan_recurring');
  await agendaDay(page, today).click();
  await expect(page.getByTestId('agenda-day-dialog').getByTestId('conflict-notice')).toHaveAttribute('data-warning', 'true');
  await page.keyboard.press('Escape');

  // 20. Lembrar de novo, exportar (v6 com a decisão), apagar tudo e restaurar: a decisão volta valendo.
  await rememberToday(page, today);
  await page.goto('./#/config');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-backup').click()]);
  const file = info.outputPath('backup-decisoes.json');
  await download.saveAs(file);
  const backup = JSON.parse(readFileSync(file, 'utf8'));
  expect(backup.schemaVersion).toBe(6);
  expect(backup.data.calendarDecisions).toHaveLength(1);
  expect(backup.data.calendarDecisions[0]).toMatchObject({ decision: 'keep_plan', date: today, scope: 'conflict_day' });
  expect(JSON.stringify(backup)).not.toMatch(/planImport|calendarPrefs/);
  await page.getByRole('button', { name: 'Apagar todos os dados' }).click();
  await page.getByRole('button', { name: 'Apagar tudo' }).click();
  await expect.poll(() => count(page, 'calendarDecisions')).toBe(0);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Restaurar backup' }).click()]);
  await chooser.setFiles({ name: 'irontrack-backup.json', mimeType: 'application/json', buffer: readFileSync(file) });
  await expect(page.getByTestId('restore-preview')).toContainText('Decisões do calendário');
  await page.getByTestId('backup-replace').click();
  await page.getByRole('button', { name: 'Substituir', exact: true }).click();
  await expect.poll(() => count(page, 'calendarDecisions')).toBe(1);
  await page.getByTestId('check-integrity').click();
  await expect(page.getByTestId('integrity-report')).toContainText(/Nenhum problema encontrado|0 erro\(s\)/);
  await page.keyboard.press('Escape');

  // 21. Offline: a decisão continua valendo e a lista abre sem rede.
  await page.goto('./#/planejamento?decisoes=1');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId('decision-item')).toHaveAttribute('data-status', 'active');
  await expect(warnings(page)).toHaveAttribute('data-warnings', '0');
  await context.setOffline(false);

  // 22. Duas abas: "voltar a mostrar" numa aba faz o aviso voltar na outra, sem recarregar.
  const other = await context.newPage();
  await other.goto(`./#/planejamento?data=${today}&visao=semana`);
  await expect(other.getByTestId('conflict-notice')).toHaveAttribute('data-warning', 'false');
  await page.getByTestId('decision-show-again').click();
  await expect(other.getByTestId('conflict-notice')).toHaveAttribute('data-warning', 'true');
  await expect(page.getByTestId('decision-item')).toHaveAttribute('data-status', 'showing');
  // A outra aba lembra de novo; esta vê a decisão valendo.
  await other.getByTestId('conflict-remember').click();
  await expect(page.getByTestId('decision-item')).toHaveAttribute('data-status', 'active');
  await other.close();
  const aux = await storageOutsideAux(page);
  expect(aux.other).toEqual([]); // nenhuma chave nova no localStorage: decisões ficam no banco
  expect(aux.auxText).not.toMatch(/keep_plan|calendarDecisions/);

  // 23. Sem rolagem horizontal (central + decisões abertas).
  await expect(page.getByTestId('remembered-decisions')).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.screenshot({ path: info.outputPath('decisoes-lembradas.png'), fullPage: true });
});
