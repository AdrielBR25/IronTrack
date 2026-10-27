import { db } from './db';
import type { BodyEntry, ProgressPhoto } from '@/lib/types';
import { evaluationToEntry, newMonthsOnly, type ParsedEvaluation } from '@/modules/body';
import { uid } from '@/lib/utils';

// Persistência do domínio de evolução corporal (avaliações e fotos). As regras de
// interpretação e cálculo ficam em src/modules/body.

export async function saveBodyEntry(e: BodyEntry) {
  await db.bodyEntries.put(e);
}

/** Grava a avaliação e suas fotos juntas: ou tudo é salvo, ou nada (sem fotos órfãs ou faltando). */
export async function saveBodyEntryWithPhotos(e: BodyEntry, photoDataUrls: string[], now = Date.now()) {
  await db.transaction('rw', db.bodyEntries, db.photos, async () => {
    await db.bodyEntries.put(e);
    if (photoDataUrls.length) await db.photos.bulkAdd(photoDataUrls.map((dataUrl) => ({ id: uid(), entryId: e.id, dataUrl, createdAt: now })));
  });
}

export async function deleteBodyEntry(id: string) {
  await db.transaction('rw', db.bodyEntries, db.photos, async () => {
    await db.bodyEntries.delete(id);
    await db.photos.where('entryId').equals(id).delete();
  });
}

export async function addPhoto(p: ProgressPhoto) {
  await db.photos.put(p);
}

export async function deletePhoto(id: string) {
  await db.photos.delete(id);
}

/**
 * Importa as avaliações lidas de um PDF: grava só os meses que ainda não existem.
 * A leitura das avaliações atuais e a gravação acontecem na mesma transação.
 */
export async function importBodyEvaluations(evaluations: ParsedEvaluation[], now = Date.now()): Promise<{ fresh: ParsedEvaluation[]; skipped: ParsedEvaluation[] }> {
  return db.transaction('rw', db.bodyEntries, async () => {
    const { fresh, skipped } = newMonthsOnly(evaluations, await db.bodyEntries.toArray());
    await db.bodyEntries.bulkPut(fresh.map((e) => evaluationToEntry(e, now)));
    return { fresh, skipped };
  });
}
