import { toast } from 'sonner';
import { addRoutine } from '@/db/repo';
import { getSettings, saveSettings } from '@/db/db';
import { parseFicha } from '@/lib/routineSchema';
import type { Routine } from '@/lib/types';
import { readFileText } from '@/lib/utils';

export async function importFichaText(text: string, makeActive = true): Promise<{ ok: true; routine: Routine } | { ok: false; errors: string[] }> {
  const settings = await getSettings();
  const res = parseFicha(text, settings);
  if (!res.ok) return res;
  await addRoutine(res.value, makeActive);
  // Garante que os grupos musculares da ficha existam na lista do usuário.
  const groups = new Set(settings.muscleGroups);
  const missing = res.value.workouts.flatMap((w) => w.exercises.map((e) => e.muscleGroup)).filter((g) => !groups.has(g));
  if (missing.length) {
    await saveSettings({ muscleGroups: [...settings.muscleGroups, ...new Set(missing)] });
  }
  return { ok: true, routine: res.value };
}

export async function importFichaFile(file: File) {
  const text = await readFileText(file);
  return importFichaText(text);
}

export async function loadSampleFicha() {
  const res = await fetch(`${import.meta.env.BASE_URL}examples/ficha-abc-exemplo.json`);
  if (!res.ok) throw new Error('Não foi possível carregar a ficha de exemplo.');
  const out = await importFichaText(await res.text());
  if (out.ok) toast.success(`Ficha "${out.routine.name}" importada e ativada`);
  else toast.error('Ficha de exemplo inválida', { description: out.errors.join('\n') });
  return out;
}
