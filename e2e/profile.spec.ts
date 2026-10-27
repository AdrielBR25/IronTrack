import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { freshStart, loadSample } from './helpers';

// Perfil local (F01/P02): criação, persistência, migração v1 → v2, backup e offline. Dados fictícios.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function profileId(page: Page) {
  await page.goto('./#/config');
  const el = page.getByTestId('profile-id');
  await expect(el).toBeVisible();
  return (await el.textContent())!.trim();
}

async function chooseBackup(page: Page, content: unknown) {
  await page.goto('./#/config');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Restaurar backup' }).click()]);
  await chooser.setFiles({ name: 'irontrack-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(content)) });
}

test('perfil: criado na primeira abertura, estável ao recarregar e ao renomear', async ({ page }) => {
  await freshStart(page);
  const id = await profileId(page);
  expect(id).toMatch(UUID);
  await expect(page.getByTestId('profile-name')).toHaveValue('Meu perfil');
  await expect(page.getByText('Seus dados ficam armazenados apenas neste navegador')).toBeVisible();

  await page.reload();
  expect(await profileId(page)).toBe(id);

  const name = page.getByTestId('profile-name');
  await name.fill('Perfil de teste');
  await name.blur();
  await expect(page.getByText('Nome do perfil atualizado')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('profile-name')).toHaveValue('Perfil de teste');
  expect(await profileId(page)).toBe(id);

  // Apagar todos os dados mantém a identidade local
  await page.getByRole('button', { name: 'Apagar todos os dados' }).click();
  await page.getByRole('button', { name: 'Apagar tudo' }).click();
  await expect(page.getByText('Dados apagados')).toBeVisible();
  await page.reload();
  expect(await profileId(page)).toBe(id);

  // Sem rolagem horizontal na seção (360 px no Android)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test('migração: banco v1 existente é atualizado sem perder histórico, rotação e avaliações', async ({ page }) => {
  // Página estática da mesma origem (não abre o app) para criar o banco legado v1.
  await page.goto('./examples/ficha-abc-exemplo.json');
  await page.evaluate(async () => {
    const ex = { id: 'e1', name: 'Supino reto', muscleGroup: 'Peito', category: 'compound', equipment: 'barbell', sets: 3, repMin: 6, repMax: 10, restSec: 120, warmupSets: 0 };
    const routine = {
      id: 'r-legado',
      name: 'Rotina legada',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      workouts: ['A', 'B', 'C'].map((l) => ({ id: `w${l}`, label: l, name: `Treino ${l}`, exercises: [{ ...ex, id: `e${l}` }] })),
    };
    const sx = (id: string) => ({
      id: `${id}-x`,
      exerciseKey: 'supino-reto',
      name: 'Supino reto',
      muscleGroup: 'Peito',
      category: 'compound',
      equipment: 'barbell',
      repMin: 6,
      repMax: 10,
      restSec: 120,
      plannedSets: 1,
      sets: [{ id: `${id}-s1`, type: 'normal', status: 'done', weight: 60, reps: 8, completedAt: 1_700_000_100_000 }],
    });
    const sess = (id: string, routineId: string, startedAt: number) => ({
      id,
      routineId,
      workoutId: 'wA',
      workoutLabel: 'A',
      workoutName: 'Treino A',
      status: 'completed',
      startedAt,
      finishedAt: startedAt + 3_600_000,
      durationSec: 3600,
      exercises: [sx(id)],
      updatedAt: startedAt + 3_600_000,
    });
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('irontrack', 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore('settings', { keyPath: 'id' });
        d.createObjectStore('routines', { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt');
        const s = d.createObjectStore('sessions', { keyPath: 'id' });
        for (const i of ['status', 'startedAt', 'workoutId', 'routineId']) s.createIndex(i, i);
        d.createObjectStore('rotations', { keyPath: 'routineId' });
        const o = d.createObjectStore('overrides', { keyPath: ['routineId', 'date'] });
        o.createIndex('routineId', 'routineId');
        o.createIndex('date', 'date');
        d.createObjectStore('bodyEntries', { keyPath: 'id' }).createIndex('date', 'date');
        d.createObjectStore('photos', { keyPath: 'id' }).createIndex('entryId', 'entryId');
        const tx = req.transaction!;
        tx.objectStore('routines').put(routine);
        tx.objectStore('sessions').put(sess('sessao-legada', 'r-legado', Date.now() - 2 * 86_400_000));
        tx.objectStore('sessions').put(sess('sessao-rotina-excluida', 'rotina-apagada', Date.now() - 9 * 86_400_000));
        tx.objectStore('rotations').put({ routineId: 'r-legado', nextIndex: 1, updatedAt: 1 });
        tx.objectStore('bodyEntries').put({ id: 'aval-legada', date: '2026-01-10', weightKg: 80, createdAt: 1 });
        tx.objectStore('photos').put({ id: 'foto-legada', entryId: 'aval-legada', dataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP8=', createdAt: 1 });
        tx.objectStore('settings').put({ id: 'settings', activeRoutineId: 'r-legado', userName: 'Pessoa Teste' });
      };
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
  });

  await page.goto('./#/historico');
  await expect(page.getByTestId('history-item')).toHaveCount(2);
  await page.goto('./#/');
  await expect(page.locator('main')).toContainText(/Treino\s*B/);
  const id = await profileId(page);
  expect(id).toMatch(UUID);
  const state = await page.evaluate(
    () =>
      new Promise<{ version: number; owners: string[]; profiles: number }>((resolve, reject) => {
        const req = indexedDB.open('irontrack');
        req.onsuccess = () => {
          const d = req.result;
          const tx = d.transaction(['sessions', 'photos', 'bodyEntries', 'routines', 'profiles']);
          const owners: string[] = [];
          let pending = 4;
          let profiles = 0;
          for (const t of ['sessions', 'photos', 'bodyEntries', 'routines']) {
            const r = tx.objectStore(t).getAll();
            r.onsuccess = () => {
              owners.push(...r.result.map((x: { profileId: string }) => x.profileId));
              if (--pending === 0) {
                const c = tx.objectStore('profiles').count();
                c.onsuccess = () => {
                  profiles = c.result;
                  resolve({ version: d.version, owners, profiles });
                  d.close();
                };
              }
            };
          }
        };
        req.onerror = () => reject(req.error);
      }),
  );
  expect(state.profiles).toBe(1);
  expect(new Set(state.owners)).toEqual(new Set([id]));
  expect(state.owners).toHaveLength(5);

  await page.getByTestId('check-integrity').click();
  await expect(page.getByTestId('integrity-report')).toContainText('0 erro(s)');
});

test('backup: legado, mesmo perfil e outro perfil (mesclar bloqueado, substituir com confirmação)', async ({ page }, info) => {
  await freshStart(page);
  await loadSample(page);
  const id = await profileId(page);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-backup').click()]);
  const path = info.outputPath('backup.json');
  await download.saveAs(path);
  const backup = JSON.parse(readFileSync(path, 'utf8'));
  expect(backup.profile.id).toBe(id);

  // Mesmo perfil
  await chooseBackup(page, backup);
  await expect(page.getByTestId('restore-identity')).toHaveAttribute('data-relation', 'same');
  await page.getByTestId('backup-cancel').click();

  // Legado (v1, sem perfil): aceito e atribuído ao perfil local
  const legacy = structuredClone(backup);
  legacy.schemaVersion = 1;
  delete legacy.profile;
  for (const c of ['routines', 'sessions', 'bodyEntries', 'photos']) for (const r of legacy.data[c]) delete r.profileId;
  await chooseBackup(page, legacy);
  await expect(page.getByTestId('restore-identity')).toHaveAttribute('data-relation', 'legacy');
  await expect(page.getByTestId('restore-identity')).toContainText('sem identificação de perfil');
  await expect(page.getByTestId('backup-merge')).toBeEnabled();
  await page.getByTestId('backup-cancel').click();

  // Outro perfil
  const otherId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const other = structuredClone(backup);
  other.profile = { id: otherId, displayName: 'Outro perfil' };
  for (const c of ['routines', 'sessions', 'bodyEntries', 'photos']) for (const r of other.data[c]) r.profileId = otherId;
  other.data.routines[0].name = 'Rotina do outro perfil';
  await chooseBackup(page, other);
  await expect(page.getByTestId('restore-identity')).toHaveAttribute('data-relation', 'different');
  await expect(page.getByTestId('merge-profile-blocked')).toBeVisible();
  await expect(page.getByTestId('backup-merge')).toBeDisabled();
  await expect(page.getByTestId('backup-replace')).toBeDisabled();
  const dlg = page.getByTestId('restore-preview');
  expect(await dlg.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('outro-perfil.png') });
  await page.getByTestId('accept-profile-transfer').check();
  await page.getByTestId('backup-replace').click();
  await page.getByRole('button', { name: 'Substituir', exact: true }).click();
  await expect(page.getByText('Backup restaurado')).toBeVisible();
  await page.reload();
  expect(await profileId(page)).toBe(id);
  await page.goto('./#/treinos');
  await expect(page.locator('main')).toContainText('Rotina do outro perfil');
});

test('perfil: disponível e estável offline', async ({ page, context }) => {
  await freshStart(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  const id = await profileId(page);
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await page.reload();
  expect(await profileId(page)).toBe(id);
  await context.setOffline(false);
});
