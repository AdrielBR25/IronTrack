// Testes de caracterização (IronTrack 2.0 F01/P03). Registram o comportamento atual de
// funções críticas ANTES da modularização; os valores esperados foram capturados do
// código da linha de base (f564071) e não podem mudar com a refatoração.
// Dados fictícios: nunca use medidas ou registros reais do usuário aqui.
import { describe, expect, it } from 'vitest';
import { parseFicha, routineToFicha } from '@/lib/routineSchema';
import { parseBodyJson } from '@/lib/bodySchema';
import { parseBackup } from '@/lib/backup';
import { exerciseSeries } from '@/lib/stats';
import { estimate1RM } from '@/lib/volume';
import { buildSession, restAfter } from '@/lib/session';
import { suggestProgression } from '@/lib/progression';
import { DEFAULT_SETTINGS } from '@/lib/defaults';
import { routine, session, snapshot } from './fixtures';

const REST = { restCompoundSec: 150, restIsolationSec: 90 };

describe('mensagens de validação (formatZodError) por formato', () => {
  it('ficha: caminhos com "Treino N › Exercício N"', () => {
    const bad = {
      formato: 'irontrack.ficha',
      versao: 1,
      nome: 'X',
      treinos: [{ rotulo: 'A', nome: 'A', exercicios: [{ nome: 'Supino', grupo: 'Peito', series: 0, repeticoes: '12-6' }] }],
    };
    const r = parseFicha(JSON.stringify(bad), REST);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors).toMatchInlineSnapshot(`
      [
        "Treino 1 › Exercício 1 › series: mínimo de 1 série",
        "Treino 1 › Exercício 1 › repeticoes: faixa de repetições inválida ("12-6"). Use, por exemplo, 10, "6-10" ou "8–12", com mínimo ≤ máximo",
      ]
    `);
  });

  it('ficha: JSON malformado', () => {
    const r = parseFicha('{ nope', REST);
    expect(!r.ok && r.errors).toMatchInlineSnapshot(`
      [
        "JSON inválido: Expected property name or '}' in JSON at position 2 (line 1 column 3)",
      ]
    `);
  });

  it('avaliações JSON: caminhos com "Avaliação N"', () => {
    const r = parseBodyJson(JSON.stringify({ formato: 'irontrack.avaliacoes', versao: 1, avaliacoes: [{ data: '2025-1-1', peso: 1000 }] }));
    expect(!r.ok && r.errors).toMatchInlineSnapshot(`
      [
        "Avaliação 1 › data: data no formato AAAA-MM-DD",
        "Avaliação 1 › peso: peso (kg) máximo 400",
      ]
    `);
  });

  it('backup: caminhos técnicos sem rótulos de ficha', () => {
    const data = snapshot({ routines: [{ ...routine('r1'), name: 5 as unknown as string }] });
    const r = parseBackup(JSON.stringify({ app: 'irontrack', kind: 'backup', schemaVersion: 2, exportedAt: 'x', profile: null, data }));
    expect(!r.ok && r.errors).toMatchInlineSnapshot(`
      [
        "data › routines › 0 › name: Expected string, received number",
      ]
    `);
  });
});

describe('cálculos de treino', () => {
  it('1RM do gráfico de progresso (exerciseSeries) difere de estimate1RM em 1 repetição e em 0 repetições (divergência preservada)', () => {
    const s = (id: string, startedAt: number, weight: number, reps: number) => {
      const base = session(id, { startedAt });
      return { ...base, exercises: [{ ...base.exercises[0], sets: [{ ...base.exercises[0].sets[0], weight, reps }] }] };
    };
    const pts = exerciseSeries([s('a', 1, 100, 1), s('b', 2, 100, 10)], 'supino');
    expect(pts.map((p) => p.best1RM)).toEqual([100 * (1 + 1 / 30), 100 * (1 + 10 / 30)]);
    expect(estimate1RM(100, 1)).toBe(100);
    expect(estimate1RM(100, 10)).toBe(pts[1].best1RM);
  });

  it('descanso após a série e progressão aceitam as configurações completas ou só os campos usados', () => {
    const r = routine('r1');
    const built = buildSession(r, r.workouts[0], []);
    const ref = { exerciseId: built.exercises[0].id, setId: built.exercises[0].sets[0].id };
    const next = { exerciseId: built.exercises[0].id, setId: built.exercises[0].sets[1].id };
    expect(restAfter(built, ref, next, DEFAULT_SETTINGS)).toBe(restAfter(built, ref, next, { restWarmupSec: DEFAULT_SETTINGS.restWarmupSec }));
    const sets = [1, 2, 3].map((i) => ({ id: `s${i}`, type: 'normal' as const, status: 'done' as const, weight: 60, reps: 10, rir: 2 }));
    const p = suggestProgression({ repMin: 6, repMax: 10, plannedSets: 3, equipment: 'barbell' }, sets, DEFAULT_SETTINGS.progression);
    expect(p).toMatchInlineSnapshot(`
      {
        "currentWeight": 60,
        "kind": "increase",
        "reason": "Você fez 3 × 10 com 60 kg e margem adequada. Sugestão: +2,5 kg.",
        "suggestedWeight": 62.5,
      }
    `);
  });

  it('ficha: importar com configurações completas ou parciais gera a mesma rotina (exceto IDs e datas)', () => {
    const text = JSON.stringify(routineToFicha(routine('r1')));
    const strip = (x: unknown) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'id' || k === 'createdAt' || k === 'updatedAt' ? undefined : v)));
    const a = parseFicha(text, DEFAULT_SETTINGS);
    const b = parseFicha(text, REST);
    expect(a.ok && b.ok).toBe(true);
    expect(strip(a.ok && a.value)).toEqual(strip(b.ok && b.value));
  });
});
