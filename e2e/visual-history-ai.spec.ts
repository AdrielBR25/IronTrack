import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { freshStart, loadSample, storageOutsideAux } from './helpers';

// IronTrack 2.0 F01/P20: biblioteca visual (3D e fallback 2D), troca com prévia e adição no treino em andamento, ajuda
// do exercício com atalho para o assistente (resposta local do catálogo), edição do histórico (A/B, remover, reordenar,
// salvar, revisões, conflito entre abas), retomada sem contar o intervalo finalizado e uma só sessão ativa.
// Dados fictícios (ficha de exemplo). Roda nos projetos android (360 px) e desktop.

const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const libItem = (page: Page, name: string) => page.getByTestId('library-item').filter({ has: page.getByText(name, { exact: true }) });

async function searchLibrary(page: Page, q: string) {
  await page.getByTestId('library-search').fill(q);
}

/** Escolhe um exercício no navegador da biblioteca (treino ou edição). */
async function pickFromBrowser(page: Page, name: string) {
  await page.getByTestId('browser-search').fill(name);
  const row = page.getByTestId('browser-item').filter({ has: page.getByText(name, { exact: true }) });
  await row.getByTestId('browser-choose').click();
}

/** Clock "m:ss" ou "h:mm:ss" → segundos. */
const clockSec = (t: string) => t.trim().split(':').map(Number).reduce((a, n) => a * 60 + n, 0);

async function startAndFinishShortWorkout(page: Page) {
  await page.getByTestId('start-workout').click();
  await expect(page).toHaveURL(/#\/treino$/);
  // Aquecimento + série 1 do primeiro exercício.
  await page.getByTestId('complete-set').click();
  await page.getByTestId('rest-skip').click();
  await page.getByTestId('complete-set').click();
  await page.getByTestId('rest-skip').click();
}

test('biblioteca visual: miniaturas, selo 3D, filtro por movimento, humanoide 3D com controles e mapa 2D', async ({ page }, info) => {
  await freshStart(page);
  await page.goto('./#/exercicios');
  await expect(page.getByTestId('library-item').first()).toBeVisible();
  await expect(page.getByTestId('exercise-thumb').first()).toBeVisible();

  // Filtro por padrão de movimento.
  const panel = page.getByTestId('library-filters');
  if (!(await panel.isVisible())) await page.getByTestId('toggle-filters').click();
  await panel.getByRole('button', { name: /^(✓ )?Agachar$/ }).click();
  await expect(libItem(page, 'Agachamento livre com barra')).toBeVisible();
  await expect(libItem(page, 'Supino reto com barra')).toHaveCount(0);
  await panel.getByRole('button', { name: /^(✓ )?Agachar$/ }).click();

  // Exercício com demonstração animada.
  await searchLibrary(page, 'Agachamento livre com barra');
  const squat = libItem(page, 'Agachamento livre com barra');
  await expect(squat.getByTestId('badge-3d')).toHaveText('3D');
  await squat.getByText('Agachamento livre com barra', { exact: true }).click();
  const visual = page.getByTestId('exercise-visual');
  await expect(visual).toHaveAttribute('data-status', 'animado');
  await expect(page.getByTestId('humanoid-canvas')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('visual-cue')).not.toBeEmpty();
  await expect(page.getByTestId('muscle-legend')).toContainText('Quadríceps');
  // Pausar e retomar; vista de costas.
  const play = page.getByTestId('visual-play');
  const pressed = await play.getAttribute('aria-pressed');
  await play.click();
  await expect(play).toHaveAttribute('aria-pressed', pressed === 'true' ? 'false' : 'true');
  await visual.getByRole('radio', { name: 'Costas' }).click();
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.screenshot({ path: info.outputPath('visual-3d.png') });
  // Alternar para o mapa 2D (mesma legenda).
  await page.getByTestId('visual-mode').click();
  await expect(visual.getByTestId('muscle-map-2d')).toBeVisible();
  await expect(page.getByTestId('humanoid-canvas')).toHaveCount(0);
  await expect(page.getByTestId('muscle-legend')).toContainText('Quadríceps');
  // Atalho para o assistente com a pergunta preenchida (nada enviado).
  await page.getByTestId('detail-ask-assistant').click();
  await expect(page).toHaveURL(/#\/assistente\?exercicio=/);
  await expect(page.getByLabel('Sua pergunta')).toHaveValue('Como executar Agachamento livre com barra corretamente?');

  // Exercício sem demonstração: só o mapa, com aviso honesto.
  await page.goto('./#/exercicios');
  await searchLibrary(page, 'Crucifixo com halteres');
  await libItem(page, 'Crucifixo com halteres').getByText('Crucifixo com halteres', { exact: true }).click();
  await expect(page.getByTestId('exercise-visual')).toHaveAttribute('data-status', 'anatomia');
  await expect(page.getByTestId('visual-no-demo')).toBeVisible();
});

test('biblioteca visual: sem WebGL, cai no mapa 2D com aviso', async ({ page }) => {
  await page.addInitScript(() => {
    const orig = HTMLCanvasElement.prototype.getContext;
    // @ts-expect-error substituição só para o teste: sem WebGL.
    HTMLCanvasElement.prototype.getContext = function (type: string, ...rest: unknown[]) {
      if (/webgl/i.test(type)) return null;
      return (orig as (this: HTMLCanvasElement, ...a: unknown[]) => unknown).call(this, type, ...rest);
    };
  });
  await freshStart(page);
  await page.goto('./#/exercicios');
  await searchLibrary(page, 'Leg press');
  await libItem(page, 'Leg press').getByText('Leg press', { exact: true }).click();
  await expect(page.getByTestId('exercise-visual').getByTestId('muscle-map-2d')).toBeVisible();
  await expect(page.getByTestId('visual-fallback')).toBeVisible();
  await expect(page.getByTestId('humanoid-canvas')).toHaveCount(0);
  expect(await noHorizontalScroll(page)).toBe(true);
});

test('treino: trocar com prévia (séries feitas ficam), adicionar exercício, ajuda e resposta local do assistente', async ({ page }, info) => {
  await freshStart(page);
  await loadSample(page);
  await startAndFinishShortWorkout(page);

  // Trocar o primeiro exercício (com séries feitas): prévia mostra o que fica.
  const first = page.getByTestId('exercise-card').first();
  const firstName = 'Supino reto com barra';
  await expect(first).toContainText(firstName);
  await first.getByRole('button', { name: /^Opções de / }).click();
  await page.getByRole('button', { name: 'Substituir exercício' }).click();
  await expect(page.getByRole('dialog').getByTestId('browser-search')).toBeVisible();
  await pickFromBrowser(page, 'Supino inclinado com halteres');
  const preview = page.getByTestId('swap-preview');
  await expect(preview).toBeVisible();
  await expect(page.getByTestId('swap-done')).toContainText('1 de');
  await expect(page.getByTestId('swap-policy')).toContainText('não passam para o novo exercício');
  await expect(page.getByTestId('swap-policy')).toContainText('A ficha não muda');
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.screenshot({ path: info.outputPath('troca-previa.png') });
  await page.getByTestId('swap-confirm').click();
  await expect(preview).toBeHidden();
  // O atual continua (com a série feita) e o novo entra logo depois.
  const cards = page.getByTestId('exercise-card');
  await expect(cards.nth(0)).toContainText(firstName);
  await expect(cards.nth(1)).toContainText('Supino inclinado com halteres');
  await expect(page.getByTestId('set-editor')).toContainText('Supino inclinado com halteres');

  // Adicionar exercício no fim.
  const before = await cards.count();
  await page.getByTestId('add-exercise').click();
  await pickFromBrowser(page, 'Prancha');
  await expect(cards).toHaveCount(before + 1);
  await expect(cards.last()).toContainText('Prancha');

  // Ajuda do exercício atual → assistente com a pergunta preenchida → resposta local, sem envio.
  await page.getByTestId('workout-help-open').click();
  await page.getByTestId('detail-ask-assistant').click();
  await expect(page).toHaveURL(/origem=treino/);
  await expect(page.getByTestId('ai-back-workout')).toBeVisible();
  await page.getByTestId('ai-send').click();
  const local = page.getByTestId('chat-assistant').last();
  await expect(local.getByTestId('chat-local-badge')).toBeVisible();
  await expect(local).toContainText('nada foi enviado');
  await expect(page.getByTestId('share-preview')).toHaveCount(0);
  await expect(page.getByTestId('chat-ask-ai')).toBeVisible();
  await page.getByTestId('ai-clear').click();
  await expect(page.getByTestId('chat-empty')).toBeVisible();
  await page.getByTestId('ai-back-workout').click();
  await expect(page).toHaveURL(/#\/treino$/);
  await expect(page.getByTestId('set-editor')).toContainText('Supino inclinado com halteres');
});

test('histórico: editar finalizado (relógio parado, A/B, remover, reordenar, salvar, revisão), conflito entre abas e retomada', async ({ page, context }, info) => {
  await freshStart(page);
  await loadSample(page);
  await startAndFinishShortWorkout(page);
  await page.getByTestId('open-finish').click();
  await page.getByTestId('confirm-finish').click();
  await expect(page).toHaveURL(/#\/historico\/.+/);
  await page.goto('./#/historico');
  await expect(page.getByTestId('history-item')).toHaveCount(1);

  // Editar.
  await page.getByTestId('history-edit').click();
  await expect(page.getByTestId('editing-banner')).toContainText('Editando treino finalizado');
  const frozen = (await page.getByTestId('frozen-clock').textContent())!;
  const exercises = page.getByTestId('edit-exercise');
  const n0 = await exercises.count();
  const name0 = (await exercises.nth(0).locator('.font-semibold').first().textContent())!.trim();
  const name1 = (await exercises.nth(1).locator('.font-semibold').first().textContent())!.trim();
  // Carga de uma série feita.
  const weight = exercises.nth(0).getByTestId('input-weight').last();
  await weight.fill('47,5');
  await weight.blur();
  const reps = exercises.nth(0).getByTestId('input-reps').last();
  await reps.fill('7');
  await reps.blur();
  // Série nova (pendente) no primeiro exercício.
  const sets0 = await exercises.nth(0).getByTestId('edit-set').count();
  await exercises.nth(0).getByTestId('edit-add-set').click();
  await expect(exercises.nth(0).getByTestId('edit-set')).toHaveCount(sets0 + 1);
  // Reordenar: o segundo sobe.
  await page.getByRole('button', { name: `Mover ${name1} para cima` }).click();
  await expect(exercises.nth(0)).toContainText(name1);
  // Remover o último (com confirmação).
  await exercises.last().getByTestId('edit-remove-exercise').click();
  await page.getByRole('dialog').getByRole('button', { name: /Remover/ }).click();
  await expect(exercises).toHaveCount(n0 - 1);
  // Cenário B: exercício esquecido.
  await page.getByTestId('edit-add-exercise').click();
  await pickFromBrowser(page, 'Elevação lateral');
  await expect(exercises.last()).toContainText('Elevação lateral');
  // Cenário A: corrigir a identidade de um exercício (mesmo registro).
  await exercises.filter({ hasText: name0 }).getByTestId('edit-correct').click();
  await pickFromBrowser(page, 'Supino reto com halteres');
  await expect(exercises.filter({ hasText: 'Supino reto com halteres' })).toHaveCount(1);
  await page.getByTestId('edit-notes').fill('Corrigido depois do treino.');
  // O relógio não andou durante a edição.
  await expect(page.getByTestId('frozen-clock')).toHaveText(frozen);
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.screenshot({ path: info.outputPath('edicao-historico.png'), fullPage: true });

  // Conflito: outra aba abre a mesma edição antes do salvamento desta.
  const other = await context.newPage();
  await other.goto(page.url());
  await expect(other.getByTestId('editing-banner')).toBeVisible();
  await page.getByTestId('edit-save').click();
  await expect(page).toHaveURL(/#\/historico\/[^/]+$/);
  await expect(page.getByTestId('session-revisions')).toBeVisible();
  await expect(page.getByTestId('session-revision')).toHaveCount(1);
  // A outra aba percebe a gravação e avisa; nada dela é gravado por cima.
  await expect(other.getByTestId('edit-conflict')).toBeVisible();
  await expect(other.getByTestId('edit-reload')).toBeVisible();
  await other.close();

  // Restaurar a revisão: vira uma nova revisão.
  await page.getByTestId('revision-restore').first().click();
  await page.getByRole('dialog').getByRole('button', { name: /Restaurar/ }).click();
  await expect(page.getByTestId('session-revision')).toHaveCount(2);

  // Retomar: o tempo acumulado aparece e o relógio recomeça dele, sem contar o intervalo finalizado.
  await page.goto('./#/historico');
  await expect(page.getByTestId('history-edited')).toBeVisible();
  await page.getByTestId('history-resume').click();
  const accumulated = clockSec((await page.getByTestId('resume-accumulated').textContent())!.match(/[\d:]+/)![0]);
  await page.getByTestId('resume-confirm').click();
  await expect(page).toHaveURL(/#\/treino$/);
  const clock = clockSec((await page.getByTestId('workout-clock').textContent())!);
  expect(clock).toBeGreaterThanOrEqual(accumulated);
  expect(clock).toBeLessThan(accumulated + 30);
  // Registrar uma série nova no treino retomado.
  await page.getByTestId('complete-set').click();
  await expect(page.getByTestId('rest-panel')).toBeVisible();
  await page.getByTestId('rest-skip').click();

  // Finalizar de novo: a rotação não avança outra vez.
  await page.getByTestId('open-finish').click();
  await expect(page.getByRole('dialog')).toContainText('a rotação não avança de novo');
  await page.getByTestId('confirm-finish').click();
  await expect(page).toHaveURL(/#\/historico\/.+/);
  await page.goto('./#/historico');
  await expect(page.getByTestId('history-item')).toHaveCount(1);
  expect((await storageOutsideAux(page)).other).toEqual([]);

  // Desempenho e recordes leem a sessão corrigida (sem duplicar o treino).
  await page.goto('./#/desempenho');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  // A restauração desfez a correção: o desempenho volta a mostrar o exercício original.
  await expect(page.locator('main')).toContainText(name0);

  // Backup v8: exporta tempo com pausas e revisões; substituir restaura tudo.
  const path = info.outputPath('backup-p20.json');
  await page.goto('./#/config');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-backup').click()]);
  await download.saveAs(path);
  const backup = JSON.parse(readFileSync(path, 'utf8'));
  expect(backup.schemaVersion).toBe(8);
  const saved = backup.data.sessions.find((x: { status: string }) => x.status === 'completed');
  expect(saved.timing.resumes).toHaveLength(1);
  expect(saved.revisions.map((r: { kind: string }) => r.kind)).toEqual(['edit', 'restore', 'resume']);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Restaurar backup' }).click()]);
  await chooser.setFiles({ name: 'irontrack-backup.json', mimeType: 'application/json', buffer: readFileSync(path) });
  await page.getByTestId('backup-replace').click();
  await page.getByRole('button', { name: 'Substituir', exact: true }).click();
  await expect(page.getByText('Backup restaurado')).toBeVisible();

  // Offline: histórico, revisões e edição continuam disponíveis.
  await context.setOffline(true);
  await page.goto('./#/historico');
  await expect(page.getByTestId('history-edited')).toBeVisible();
  await page.getByTestId('history-item').click();
  await expect(page.getByTestId('session-revision')).toHaveCount(3);
  // Segue o link pelo endereço: o aviso "Backup restaurado" (aberto enquanto o ponteiro está sobre ele) cobre o botão.
  await page.goto(page.url().split('#')[0] + (await page.getByTestId('detail-edit-session').getAttribute('href'))!);
  await expect(page.getByTestId('editing-banner')).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  await context.setOffline(false);
});
