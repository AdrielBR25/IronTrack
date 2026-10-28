import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { freshStart, loadSample, setValue } from './helpers';

// Reconhecimento assistido de exercícios antigos, biblioteca expandida e construtor avançado (IronTrack 2.0 F01/P18),
// no Android 360 px e no desktop: ficha antiga sem origem → meta e treino → contadores → sugestão forte → associar →
// escolher outro → ignorar → lote com revisão → desfazer e associar de novo pelo editor → "Mais utilizados" só com
// sessões → adicionar vários → reordenar → substituição múltipla com prévia → meta continua no exercício anterior →
// backup v7 com as referências → restaurar → duas abas → offline. Dados fictícios.

const noHorizontalScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
const legacy = (page: Page, name: string) => page.getByTestId('legacy-exercise').filter({ has: page.getByText(name, { exact: true }) });
const libItem = (page: Page, name: string) => page.getByTestId('library-item').filter({ has: page.getByText(name, { exact: true }) });
const counter = (page: Page, id: string) => page.getByTestId(id).locator('p').first();
const editorNames = (page: Page) => page.getByTestId('editor-exercise').locator('.truncate.font-semibold').allTextContents();

async function openWorkoutA(page: Page) {
  await page.goto('./#/treinos');
  await page.getByRole('button', { name: /Peito, ombros e tríceps/ }).first().click();
  await expect(page).toHaveURL(/#\/treinos\/[^/]+\/[^/]+$/);
  await expect(page.getByTestId('add-from-library')).toBeVisible();
}

async function openRecognition(page: Page) {
  await page.goto('./#/exercicios/reconhecer');
  await expect(page.getByTestId('recognition-summary')).toBeVisible();
}

async function pickInPicker(page: Page, query: string, name: string) {
  const picker = page.getByTestId('library-picker');
  await expect(picker).toBeVisible();
  await picker.getByTestId('picker-search').fill(query);
  await picker.getByTestId('picker-item').filter({ has: page.getByText(name, { exact: true }) }).first().click();
}

async function exportBackup(page: Page, path: string) {
  await page.goto('./#/config');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-backup').click()]);
  await download.saveAs(path);
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('reconhecimento: sugerir, associar, lote, desfazer, mais utilizados, adicionar vários, substituir vários, backup, abas e offline', async ({ page, context }, info) => {
  test.setTimeout(240_000);
  // 1. Perfil e ficha de exemplo (16 exercícios antigos, sem origem na biblioteca).
  await freshStart(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await loadSample(page);

  // 2. Meta de carga no supino e um treino concluído com ele (ainda sem origem).
  await page.goto('./#/evolucao');
  await page.getByTestId('open-goals').click();
  await page.getByTestId('new-goal').click();
  await page.getByTestId('goal-type').selectOption('max_load');
  const option = page.getByTestId('goal-exercise').locator('option', { hasText: 'Supino reto com barra' }).first();
  await page.getByTestId('goal-exercise').selectOption((await option.getAttribute('value'))!);
  await setValue(page, 'goal-target', '60');
  await setValue(page, 'goal-title', 'Supino 60 kg');
  await page.getByTestId('goal-save').click();
  await expect(page.getByTestId('goal-form')).toBeHidden();
  await page.goto('./#/');
  await page.getByTestId('start-workout').click();
  await expect(page.getByTestId('set-editor')).toContainText('Supino reto com barra');
  await page.getByTestId('complete-set').click(); // aquecimento
  await page.getByTestId('rest-skip').click();
  await page.getByTestId('complete-set').click(); // série 1
  await page.getByTestId('rest-skip').click();
  await page.getByTestId('open-finish').click();
  await page.getByTestId('confirm-finish').click();
  await expect(page).toHaveURL(/#\/historico\/.+/);

  // 3. Biblioteca expandida (≥ 100), itens novos e atalho com o número de exercícios sem vínculo.
  await page.goto('./#/exercicios');
  await expect(page.getByTestId('library-count')).toHaveText(/^1\d\d exercícios$/);
  await expect(page.getByTestId('open-recognition')).toContainText('16 sem vínculo');
  await page.getByTestId('library-search').fill('face pull');
  await expect(libItem(page, 'Face pull')).toBeVisible();
  await page.getByTestId('library-search').fill('peck deck');
  await expect(libItem(page, 'Voador (peck deck)')).toBeVisible();
  await page.getByTestId('library-search').fill('');

  // 4. "Mais utilizados": a sessão concluída não tinha origem → nada classificado, aviso "Sem vínculo com a biblioteca".
  await page.getByTestId('toggle-most-used').click();
  await expect(page.getByTestId('most-used-empty')).toBeVisible();
  await expect(page.getByTestId('most-used-unlinked')).toContainText('Sem vínculo com a biblioteca');
  await expect(page.getByTestId('most-used')).toContainText('1 sessão considerada');
  await noHorizontalScroll(page);

  // 5. Reconhecimento: contadores e agrupamento por treino.
  await page.getByTestId('open-recognition').click();
  await expect(page).toHaveURL(/#\/exercicios\/reconhecer$/);
  await expect(counter(page, 'count-unlinked')).toHaveText('16');
  await expect(counter(page, 'count-workouts')).toHaveText('3');
  await expect(counter(page, 'count-suggested')).toHaveText('16');
  await expect(counter(page, 'count-manual')).toHaveText('0');
  await expect(counter(page, 'count-linked')).toHaveText('0');
  await expect(page.getByRole('region', { name: /Ficha A — Peito, ombros e tríceps/ })).toBeVisible();
  await noHorizontalScroll(page);

  // 6. Sugestão forte explicada → confirmação com "atual × biblioteca" → associar (só a referência).
  const supino = legacy(page, 'Supino reto com barra');
  await expect(supino.getByTestId('recognition-suggestion')).toContainText('Correspondência forte');
  await expect(supino.getByTestId('recognition-suggestion')).toContainText('Mesmo nome, mesmo grupo muscular');
  await supino.getByTestId('legacy-link').click();
  const confirm = page.getByTestId('link-confirm');
  await expect(confirm.getByTestId('link-comparison')).toContainText('Exercício atual (ficha)');
  await expect(confirm).toContainText('Metas');
  await noHorizontalScroll(page);
  await confirm.getByTestId('link-confirm-button').click();
  await expect(confirm).toBeHidden();
  await expect(counter(page, 'count-unlinked')).toHaveText('15');
  await expect(counter(page, 'count-linked')).toHaveText('1');

  // 7. Escolher outro: busca manual na biblioteca → confirmação → associar.
  await legacy(page, 'Tríceps na polia (corda)').getByTestId('legacy-choose').click();
  await pickInPicker(page, 'triceps corda', 'Tríceps corda');
  await expect(confirm).toContainText('Tríceps corda');
  await confirm.getByTestId('link-confirm-button').click();
  await expect(counter(page, 'count-linked')).toHaveText('2');

  // 8. Ignorar por enquanto: sai da lista, nada é gravado.
  await legacy(page, 'Elevação lateral').getByTestId('legacy-ignore').click();
  await expect(page.getByTestId('legacy-ignore')).toHaveCount(13);
  await expect(page.getByRole('button', { name: /Ignorados por enquanto \(1\)/ })).toBeVisible();
  await expect(counter(page, 'count-unlinked')).toHaveText('14');

  // 9. Lote assistido: sem "selecionar tudo"; revisão item a item; um pulado; resumo; aplicação atômica.
  await page.getByTestId('toggle-batch').click();
  await expect(page.getByRole('checkbox', { name: /tudo|todos/i })).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Selecionar Puxada frontal' }).check();
  await page.getByRole('checkbox', { name: 'Selecionar Remada curvada com barra' }).check();
  await page.getByRole('checkbox', { name: 'Selecionar Rosca martelo' }).check();
  await page.getByTestId('batch-review').click();
  const batch = page.getByTestId('batch-dialog');
  await expect(batch).toContainText('Revisar 1 de 3');
  await expect(batch.getByTestId('link-comparison')).toBeVisible();
  await batch.getByTestId('batch-confirm-one').click();
  await expect(batch).toContainText('Revisar 2 de 3');
  await batch.getByTestId('batch-confirm-one').click();
  await expect(batch).toContainText('Revisar 3 de 3');
  await batch.getByTestId('batch-skip').click();
  await expect(batch.getByTestId('batch-summary')).toContainText('Rosca martelo: pulado');
  await expect(batch.getByTestId('batch-apply')).toHaveText('Aplicar 2 associações');
  await noHorizontalScroll(page);
  await batch.getByTestId('batch-apply').click();
  await expect(batch).toContainText('Associações gravadas');
  await expect(batch.getByTestId('batch-result').locator('li')).toHaveCount(2);
  await batch.getByRole('button', { name: 'Fechar', exact: true }).last().click();
  await expect(counter(page, 'count-linked')).toHaveText('4');
  await expect(counter(page, 'count-unlinked')).toHaveText('12');

  // 10. Fichas não contam como uso: "Mais utilizados" continua vazio.
  await page.goto('./#/exercicios');
  await page.getByTestId('toggle-most-used').click();
  await expect(page.getByTestId('most-used-empty')).toBeVisible();
  // Detalhe: "já está em uma das suas fichas" ≠ "utilizado em uma sessão registrada com esta origem".
  await page.getByTestId('library-search').fill('supino reto com barra');
  await libItem(page, 'Supino reto com barra').locator('button').first().click();
  await expect(page.getByTestId('detail-usage')).toContainText('Já está em uma das suas fichas.');
  await expect(page.getByTestId('detail-usage')).not.toContainText('sessão registrada');
  await page.keyboard.press('Escape');

  // 11. Editor: resumo da ficha, estimativa de séries e exercícios sem vínculo.
  await openWorkoutA(page);
  const summary = page.getByTestId('editor-summary');
  await expect(summary).toContainText('5 exercícios');
  await expect(summary).toContainText('séries planejadas');
  await expect(summary).toContainText('estimativa');
  await expect(page.getByTestId('editor-unlinked')).toHaveText('3 sem vínculo com a biblioteca');
  await noHorizontalScroll(page);

  // 12. Desfazer a associação pelo editor (reversível) e associar de novo pelo atalho filtrado ao treino.
  await page.getByRole('button', { name: 'Mais ações para Supino reto com barra' }).click();
  await page.getByTestId('unlink-origin').click();
  await page.getByRole('button', { name: 'Desfazer associação', exact: true }).click();
  await expect(page.getByTestId('editor-unlinked')).toHaveText('4 sem vínculo com a biblioteca');
  await expect(page.getByTestId('editor-exercise')).toHaveCount(5);
  await page.getByTestId('editor-unlinked').click();
  await expect(page).toHaveURL(/#\/exercicios\/reconhecer\?treino=/);
  await expect(counter(page, 'count-unlinked')).toHaveText('4');
  await legacy(page, 'Supino reto com barra').getByTestId('legacy-link').click();
  await page.getByTestId('link-confirm-button').click();
  await expect(counter(page, 'count-unlinked')).toHaveText('3');
  await page.getByRole('button', { name: 'Voltar' }).click();
  await expect(page.getByTestId('editor-unlinked')).toHaveText('3 sem vínculo com a biblioteca');

  // 13. Ver a origem a partir do editor sem perder a edição.
  await page.getByRole('button', { name: 'Mais ações para Supino reto com barra' }).click();
  await page.getByTestId('open-origin').click();
  await expect(page.getByTestId('exercise-detail')).toContainText('Supino reto com barra');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('editor-summary')).toBeVisible();

  // 14. Adicionar vários: ordem da marcação, "repetido" só por ação explícita, estimativa, sem carga.
  await page.getByTestId('add-many').click();
  await expect(page).toHaveURL(/varios=1/);
  await page.getByTestId('library-search').fill('peck deck');
  await libItem(page, 'Voador (peck deck)').getByTestId('library-pick').click();
  await page.getByTestId('library-search').fill('face pull');
  await libItem(page, 'Face pull').getByTestId('library-pick').click();
  await expect(libItem(page, 'Face pull').getByTestId('library-pick')).toHaveText('2');
  await page.getByTestId('add-many-open').click();
  const many = page.getByTestId('add-many-dialog');
  await expect(many.getByTestId('add-many-list').locator('li')).toHaveCount(2);
  await many.getByRole('button', { name: 'Adicionar Face pull outra vez' }).click();
  await expect(many.getByTestId('add-many-list').locator('li')).toHaveCount(3);
  await expect(many.getByText('repetido')).toHaveCount(2);
  await many.getByRole('button', { name: 'Tirar Face pull da seleção' }).first().click();
  await expect(many.getByTestId('add-many-list').locator('li span.block')).toHaveText(['Voador (peck deck)', 'Face pull']);
  await expect(many.getByTestId('add-many-sets')).toContainText('não é volume executado');
  await noHorizontalScroll(page);
  await many.getByTestId('add-many-confirm').click();
  await expect(page.getByTestId('add-from-library')).toBeVisible();
  expect((await editorNames(page)).slice(-2)).toEqual(['Voador (peck deck)', 'Face pull']);
  await expect(page.getByTestId('editor-summary')).toContainText('7 exercícios');

  // 15. Reordenar sem arrastar.
  await page.getByRole('button', { name: 'Mover Face pull para cima' }).click();
  // A gravação é assíncrona (transação no IndexedDB): espera a lista refletir a nova ordem.
  await expect.poll(async () => (await editorNames(page)).slice(-2)).toEqual(['Face pull', 'Voador (peck deck)']);

  // 16. Substituição múltipla: seleção → escolha → prévia (metas, novas identidades, ordem final) → confirmar.
  await page.getByTestId('bulk-replace').click();
  await expect(page).toHaveURL(/\/substituir$/);
  await page.getByTestId('bulk-select-row').filter({ hasText: 'Supino reto com barra' }).getByTestId('bulk-select').check();
  await page.getByTestId('bulk-select-row').filter({ hasText: 'Desenvolvimento com halteres' }).getByTestId('bulk-select').check();
  await page.getByTestId('bulk-next-choose').click();
  await page.getByTestId('bulk-choose-row').filter({ hasText: 'Supino reto com barra' }).getByTestId('bulk-pick').click();
  await pickInPicker(page, 'supino maquina', 'Supino máquina');
  await page.getByTestId('bulk-choose-row').filter({ hasText: 'Desenvolvimento com halteres' }).getByTestId('bulk-pick').click();
  await pickInPicker(page, 'desenvolvimento maquina', 'Desenvolvimento na máquina');
  await page.getByTestId('bulk-next-preview').click();
  const preview = page.getByTestId('bulk-preview');
  await expect(preview.getByTestId('bulk-goal-note')).toContainText('As metas vinculadas ao exercício anterior continuarão vinculadas a ele.');
  await expect(preview.getByTestId('bulk-goal-note')).toContainText('1 meta ligada');
  await expect(preview.getByTestId('bulk-preview-row')).toHaveCount(2);
  await expect(preview.getByTestId('bulk-new-id')).toHaveCount(2);
  await expect(preview.getByTestId('bulk-final-order').locator('li')).toHaveCount(7);
  await noHorizontalScroll(page);
  await page.getByTestId('bulk-confirm').click();
  await expect(page.getByTestId('add-from-library')).toBeVisible();
  const after = await editorNames(page);
  expect(after).toEqual(expect.arrayContaining(['Supino máquina', 'Desenvolvimento na máquina']));
  expect(after).not.toContain('Supino reto com barra');
  expect(after[0]).toBe('Supino máquina'); // mesma posição do substituído

  // 17. A meta continua no exercício anterior (não é redirecionada) e o histórico fica intacto.
  await page.goto('./#/metas');
  await expect(page.getByTestId('goal-card').filter({ hasText: 'Supino 60 kg' })).toContainText('não está mais em nenhuma ficha');
  await page.goto('./#/historico');
  await expect(page.getByTestId('history-item')).toHaveCount(1);
  await expect(page.getByTestId('history-item')).toContainText(/Peito, ombros e tríceps|Treino A/);

  // 18. Backup v7: as referências gravadas viajam; a sessão antiga continua sem origem.
  const backup = await exportBackup(page, info.outputPath('backup-reconhecimento.json'));
  expect(backup.schemaVersion).toBe(7);
  const exA = backup.data.routines[0].workouts[0].exercises as { name: string; catalogId?: string; catalogVersion?: number }[];
  expect(exA.find((e) => e.name === 'Tríceps na polia (corda)')).toMatchObject({ catalogId: 'triceps-corda', catalogVersion: 1 });
  expect(exA.find((e) => e.name === 'Supino máquina')).toMatchObject({ catalogId: 'supino-maquina' });
  expect(exA.find((e) => e.name === 'Elevação lateral')?.catalogId).toBeUndefined();
  const exB = backup.data.routines[0].workouts[1].exercises as { name: string; catalogId?: string }[];
  expect(exB.find((e) => e.name === 'Puxada frontal')?.catalogId).toBe('puxada-frontal');
  expect(exB.find((e) => e.name === 'Rosca martelo')?.catalogId).toBeUndefined();
  expect(backup.data.sessions).toHaveLength(1);
  expect(backup.data.sessions[0].exercises.every((e: { catalogId?: string }) => e.catalogId === undefined)).toBe(true);
  const newSupinoId = (exA.find((e) => e.name === 'Supino máquina') as unknown as { id: string }).id;
  expect(JSON.stringify(backup.data.goals)).not.toContain(newSupinoId);

  // 19. Restaurar (substituir) o mesmo backup: os contadores voltam iguais.
  await page.goto('./#/config');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Restaurar backup' }).click()]);
  await chooser.setFiles({ name: 'irontrack-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
  await page.getByTestId('backup-replace').click();
  await page.getByRole('button', { name: 'Substituir', exact: true }).click();
  await expect(page.getByText('Backup restaurado')).toBeVisible();
  await openRecognition(page);
  await expect(counter(page, 'count-linked')).toHaveText('7'); // A: supino máquina, desenv. máquina, tríceps corda, voador, face pull · B: puxada, remada
  const unlinkedAfterRestore = (await counter(page, 'count-unlinked').textContent())!.trim();

  // 20. Duas abas: a associação feita na outra aba aparece sozinha.
  const other = await context.newPage();
  await other.goto(page.url());
  await legacy(other, 'Rosca martelo').getByTestId('legacy-link').click();
  await other.getByTestId('link-confirm-button').click();
  await expect(counter(page, 'count-unlinked')).toHaveText(String(Number(unlinkedAfterRestore) - 1));
  await other.close();

  // 21. Offline: o reconhecimento abre sem rede (catálogo local, nada sai do aparelho).
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId('recognition-summary')).toBeVisible();
  await expect(page.getByTestId('legacy-exercise').first()).toBeVisible();
  await noHorizontalScroll(page);
  await context.setOffline(false);
});
