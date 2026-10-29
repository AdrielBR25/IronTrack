import { expect, test, type Page } from '@playwright/test';
import { freshStart, setValue } from './helpers';

// Cronômetros de série e registro rápido (P11), em Android 360 px e desktop: exercício por tempo criado no editor,
// cronômetro (iniciar, pausar, continuar, encerrar, recarregar, retomar), cardio com distância em milhas,
// unilateral com alternância, carga adicional × assistência, histórico, Desempenho, offline, duas abas e aviso
// de regravação por app antigo. Sem rolagem horizontal. Dados fictícios apenas.

const FICHA = {
  formato: 'irontrack.ficha',
  versao: 2,
  nome: 'Cronômetros E2E',
  treinos: [
    {
      rotulo: 'A',
      nome: 'Treino Timer',
      exercicios: [
        { nome: 'Corrida', grupo: 'Cardio', series: 1, repeticoes: 1, descanso: 0, modalidade: 'cardio', duracao: 1200, distancia: 3, unidade_distancia: 'km' },
        { nome: 'Afundo', grupo: 'Quadríceps', series: 2, repeticoes: '10', descanso: 0, modalidade: 'musculacao', lateralidade: 'unilateral' },
        { nome: 'Paralelas', grupo: 'Tríceps', series: 1, repeticoes: '8', descanso: 0, modalidade: 'peso_corporal', tipo_carga: 'adicional' },
        { nome: 'Barra assistida', grupo: 'Costas', series: 1, repeticoes: '8', descanso: 0, modalidade: 'peso_corporal', tipo_carga: 'assistida' },
      ],
    },
  ],
};

async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
}

async function importFicha(page: Page) {
  await page.goto('./#/treinos');
  await page.getByTestId('import-ficha-input').setInputFiles({ name: 'ficha.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(FICHA)) });
  await expect(page.getByText('importada e ativada')).toBeVisible();
}

async function openEditor(page: Page) {
  await page.goto('./#/treinos');
  await expect(async () => {
    await page.getByRole('button', { name: /Treino Timer/ }).first().click({ timeout: 5_000 });
    await expect(page.getByTestId('add-exercise')).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
}

/** Valor exibido do cronômetro em segundos. */
async function shown(page: Page): Promise<number> {
  const t = (await page.getByTestId('set-timer-display').textContent()) ?? '';
  return t.split(':').reduce((acc, p) => acc * 60 + Number(p), 0);
}

/** Banco local lido direto do IndexedDB (sem passar pela interface). */
async function dbSessions(page: Page) {
  return page.evaluate(
    () =>
      new Promise<{ status: string; sets: { status: string; durationSec?: number; side?: string; weight?: number | null }[] }[]>((resolve, reject) => {
        const req = indexedDB.open('irontrack');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const tx = req.result.transaction('sessions', 'readonly');
          const all = tx.objectStore('sessions').getAll();
          all.onsuccess = () => {
            resolve(all.result.map((s: { status: string; exercises: { sets: { status: string; durationSec?: number; side?: string; weight?: number | null }[] }[] }) => ({ status: s.status, sets: s.exercises.flatMap((e) => e.sets) })));
            req.result.close();
          };
        };
      }),
  );
}

test('cronômetro, cardio, unilateral e peso corporal: treino → recarga → histórico → Desempenho → offline', async ({ page, context }, info) => {
  test.setTimeout(180_000);
  await freshStart(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await importFicha(page);

  // 1. Criar exercício por tempo no editor (primeiro da lista para ser executado primeiro).
  await openEditor(page);
  await page.getByTestId('add-exercise').click();
  await page.locator('#ex-name').fill('Prancha');
  await page.locator('#ex-modality').selectOption('timed');
  await page.locator('#ex-sets').fill('2');
  await page.locator('#ex-rest').fill('0');
  await page.locator('#ex-duration').fill('30');
  await page.locator('#ex-loadmode').selectOption('corporal');
  await page.getByRole('button', { name: 'Salvar exercício' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  // A prancha entra no fim da ficha: é executada depois dos exercícios importados.
  const exercises = page.getByTestId('editor-exercise');
  await expect(exercises).toHaveCount(5);
  await noHorizontalScroll(page);

  await page.goto('./#/');
  await page.getByTestId('start-workout').click();
  const editor = page.getByTestId('set-editor');

  // Corrida (primeiro da ficha): cronômetro opcional + distância em milhas.
  await expect(editor).toContainText('Corrida');
  await expect(page.getByTestId('set-timer')).toBeVisible();
  await editor.getByRole('radio', { name: 'mi', exact: true }).click();
  await expect(editor).toContainText('Distância (mi)');
  await setValue(page, 'input-distance', '2');
  await expect(page.getByTestId('distance-equivalents')).toContainText('3,22 km');
  await expect(page.getByTestId('distance-equivalents')).toContainText('ritmo');
  await noHorizontalScroll(page);
  await page.screenshot({ path: info.outputPath('cardio-rapido.png') });
  await page.getByTestId('complete-set').click();

  // Unilateral: lado em destaque, alternância rápida na série seguinte.
  await expect(editor).toContainText('Afundo');
  await expect(page.getByTestId('side-badge')).toHaveText('Lado não informado');
  await editor.getByRole('radio', { name: 'Direito' }).click();
  await expect(page.getByTestId('side-badge')).toHaveText('Lado: Direito');
  await setValue(page, 'input-weight', '16');
  await page.getByTestId('complete-set').click();
  await expect(editor).toContainText('Série 2 de 2');
  await expect(page.getByTestId('side-badge')).toHaveText('Lado não informado');
  await page.getByTestId('toggle-side').click();
  await expect(page.getByTestId('side-badge')).toHaveText('Lado: Esquerdo');
  await page.screenshot({ path: info.outputPath('unilateral.png') });
  await page.getByTestId('complete-set').click();

  // Carga adicional × assistência.
  await expect(editor).toContainText('Paralelas');
  await expect(editor).toContainText('Carga adicional (+kg)');
  await setValue(page, 'input-weight', '10');
  await page.getByTestId('complete-set').click();
  await expect(editor).toContainText('Barra assistida');
  await expect(editor).toContainText('Assistência (−kg)');
  await expect(page.getByTestId('input-weight')).toHaveCount(0);
  await setValue(page, 'input-assistance', '15');
  await page.getByTestId('complete-set').click();

  // 2–5. Prancha: iniciar, pausar, continuar, encerrar (a medida preenche a duração pré-preenchida pela meta).
  await expect(editor).toContainText('Prancha');
  await expect(page.getByTestId('input-duration')).toHaveValue('30');
  await page.getByTestId('set-timer-start').click();
  await page.waitForTimeout(1_000);
  // 10. Navegação interna com o cronômetro rodando: ao voltar ele continua (não recomeça nem pausa).
  await page.goto('./#/historico');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.goto('./#/treino');
  await expect(page.getByTestId('set-timer')).toHaveAttribute('data-status', 'running');
  await page.waitForTimeout(1_300);
  await page.getByTestId('set-timer-pause').click();
  await expect(page.getByTestId('set-timer-status')).toHaveText('PAUSADO');
  const paused = await shown(page);
  expect(paused).toBeGreaterThanOrEqual(2);
  await page.waitForTimeout(1_500);
  expect(await shown(page)).toBe(paused);
  await page.screenshot({ path: info.outputPath('cronometro-pausado.png') });
  await page.getByTestId('set-timer-resume').click();
  await page.waitForTimeout(1_200);
  await page.getByTestId('set-timer-stop').click();
  // O campo de duração reflete a medida um render depois do clique: ler logo após o clique às vezes ainda
  // pegava a meta (30) no CI, embora a série já estivesse gravada com a medida.
  await expect(page.getByTestId('set-timer-status')).toHaveText('Registrado na série');
  await expect(page.getByTestId('input-duration')).not.toHaveValue('30');
  const measured = Number(await page.getByTestId('input-duration').inputValue());
  expect(measured).toBeGreaterThanOrEqual(paused + 1);
  expect(measured).toBeLessThan(paused + 4);
  await noHorizontalScroll(page);
  await page.getByTestId('complete-set').click();

  // 6–7. Série 2 com o cronômetro rodando; recarregar: volta pausado, a série 1 mantém a duração.
  await expect(editor).toContainText('Série 2 de 2');
  await page.getByTestId('set-timer-start').click();
  await page.waitForTimeout(1_500);
  await page.reload();
  await expect(editor).toContainText('Série 2 de 2');
  await expect(page.getByTestId('set-timer')).toHaveAttribute('data-status', 'paused');
  await expect(page.getByTestId('set-timer-recovered')).toBeVisible();
  expect(await shown(page)).toBeGreaterThanOrEqual(1);
  await page.screenshot({ path: info.outputPath('cronometro-recuperado.png') });
  const before = await dbSessions(page);
  expect(before[0].sets.filter((s) => s.status === 'done')).toHaveLength(6); // nada concluído sozinho
  expect(before[0].sets.find((s) => s.durationSec === measured)).toBeTruthy();
  await page.getByTestId('set-timer-resume').click();
  await page.waitForTimeout(1_100);
  await page.getByTestId('complete-set').click();
  await page.getByTestId('finish-with-timer').click();
  await page.getByTestId('confirm-finish').click();

  // 11. Histórico.
  await expect(page).toHaveURL(/#\/historico\/.+/);
  const detail = page.locator('main');
  for (const t of [`${measured} s`, '3,22 km', 'Direito', 'Esquerdo', 'Assist.', '15 kg']) await expect(detail).toContainText(t);
  await noHorizontalScroll(page);
  const after = await dbSessions(page);
  expect(after).toHaveLength(1);
  expect(after[0].status).toBe('completed');

  // 12. Desempenho.
  await page.goto('./#/evolucao/desempenho');
  const select = page.getByTestId('exercise-select');
  await select.selectOption({ label: 'Prancha (1)' });
  await expect(page.getByTestId('timed-metrics')).toContainText('Maior duração');
  await select.selectOption({ label: 'Corrida (1)' });
  await expect(page.getByTestId('cardio-metrics')).toContainText('3,22 km');
  await select.selectOption({ label: 'Afundo (1)' });
  await expect(page.getByTestId('side-metrics')).toContainText('Esquerdo');
  await noHorizontalScroll(page);

  // 13. Offline: o cronômetro funciona sem rede.
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await page.goto('./#/');
  await page.getByTestId('start-workout').click();
  await expect(editor).toContainText('Corrida');
  await page.getByTestId('set-timer-start').click();
  await page.waitForTimeout(1_100);
  await page.getByTestId('set-timer-stop').click();
  await expect(page.getByTestId('set-timer-status')).toHaveText(/Registrado|Encerrado/);
  await noHorizontalScroll(page);
  await context.setOffline(false);
});

test('duas abas: um cronômetro só, sem conclusão duplicada e sem ressuscitar treino finalizado', async ({ page, context }) => {
  test.setTimeout(120_000);
  await freshStart(page);
  await importFicha(page);
  await page.goto('./#/');
  await page.getByTestId('start-workout').click();
  await expect(page.getByTestId('set-editor')).toContainText('Corrida');

  const tab2 = await context.newPage();
  await tab2.goto('./#/treino');
  await expect(tab2.getByTestId('set-editor')).toContainText('Corrida');

  // Cronômetro iniciado na aba 1 aparece rodando na aba 2 (mesmo cronômetro, não um segundo).
  await page.getByTestId('set-timer-start').click();
  await expect(tab2.getByTestId('set-timer')).toHaveAttribute('data-status', 'running');
  // Abrir uma terceira aba não pausa o cronômetro (há páginas vivas mantendo a contagem).
  const tab3 = await context.newPage();
  await tab3.goto('./#/treino');
  await expect(tab3.getByTestId('set-timer')).toHaveAttribute('data-status', 'running');
  await tab3.close();
  // Pausar na aba 2 pausa para as duas.
  await page.waitForTimeout(1_200);
  await tab2.getByTestId('set-timer-pause').click();
  await expect(page.getByTestId('set-timer')).toHaveAttribute('data-status', 'paused');

  // Concluir na aba 1; a aba 2 acompanha e não consegue concluir a mesma série de novo.
  await page.getByTestId('complete-set').click();
  await page.getByTestId('finish-with-timer').click();
  await expect(page.getByTestId('set-editor')).toContainText('Afundo');
  await expect(tab2.getByTestId('set-editor')).toContainText('Afundo');
  let sessions = await dbSessions(page);
  expect(sessions[0].sets.filter((s) => s.status === 'done')).toHaveLength(1);

  // As duas abas mudam campos diferentes da mesma série quase ao mesmo tempo: as duas alterações ficam.
  await page.getByTestId('set-editor').getByRole('radio', { name: 'Direito' }).click();
  await setValue(tab2, 'input-weight', '18');
  await expect.poll(async () => (await dbSessions(page))[0].sets.some((s) => s.status === 'pending' && s.side === 'direito' && s.weight === 18)).toBe(true);

  // Finalizar na aba 2: a aba 1 sai do treino e não regrava nada.
  await tab2.getByTestId('open-finish').click();
  await tab2.getByTestId('confirm-finish').click();
  await expect(tab2).toHaveURL(/#\/historico\/.+/);
  await expect(page).toHaveURL(/#\/$/);
  sessions = await dbSessions(page);
  expect(sessions).toHaveLength(1);
  expect(sessions[0].status).toBe('completed');
  await noHorizontalScroll(page);
});

test('app antigo regravou a rotina: aviso e restauração confirmada', async ({ page }) => {
  await freshStart(page);
  await importFicha(page);
  await page.goto('./#/');
  await expect(page.getByTestId('compat-guard')).toHaveCount(0);
  // Simula o editor de uma versão antiga: regrava a rotina sem os campos de modalidade, direto no IndexedDB.
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('irontrack');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const tx = req.result.transaction('routines', 'readwrite');
          const store = tx.objectStore('routines');
          const all = store.getAll();
          all.onsuccess = () => {
            for (const r of all.result) {
              for (const w of r.workouts) for (const e of w.exercises) for (const k of ['modality', 'laterality', 'loadMode', 'distanceUnit', 'targetDurationSec', 'targetDistance']) delete e[k];
              r.updatedAt += 1000;
              store.put(r);
            }
          };
          tx.oncomplete = () => {
            req.result.close();
            resolve();
          };
        };
      }),
  );
  await page.reload();
  const guard = page.getByTestId('compat-guard');
  await expect(guard).toContainText('versão antiga');
  await expect(guard).toContainText('Corrida');
  await noHorizontalScroll(page);
  await page.getByTestId('compat-restore').click();
  await expect(page.getByText('Classificação restaurada')).toBeVisible();
  await expect(guard).toHaveCount(0);
  await page.goto('./#/');
  await page.getByTestId('start-workout').click();
  await expect(page.getByTestId('set-editor')).toContainText('Corrida');
  await expect(page.getByTestId('input-distance')).toBeVisible(); // a corrida voltou a ser cardio
});
