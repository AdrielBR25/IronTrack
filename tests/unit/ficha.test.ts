import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseFicha, parseRepRange, routineToFicha } from '@/lib/routineSchema';
import { parseBodyJson } from '@/lib/bodySchema';

const rest = { restCompoundSec: 150, restIsolationSec: 90 };
const sample = readFileSync(resolve(process.cwd(), 'public/examples/ficha-abc-exemplo.json'), 'utf8');

describe('faixas de repetição', () => {
  it.each([
    [10, { min: 10, max: 10 }],
    ['8', { min: 8, max: 8 }],
    ['6-10', { min: 6, max: 10 }],
    ['6–10', { min: 6, max: 10 }],
    ['8 — 12', { min: 8, max: 12 }],
    ['8 a 12', { min: 8, max: 12 }],
    [{ min: 6, max: 10 }, { min: 6, max: 10 }],
  ])('%s', (input, out) => expect(parseRepRange(input)).toEqual(out));
  it.each(['10-6', 'abc', '0', '', 2.5, '6-'])('rejeita %s', (input) => expect(parseRepRange(input)).toBeNull());
});

describe('importação de ficha JSON', () => {
  it('importa a ficha ABC de exemplo', () => {
    const r = parseFicha(sample, rest);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.workouts.map((w) => w.label)).toEqual(['A', 'B', 'C']);
    const supino = r.value.workouts[0].exercises[0];
    expect(supino).toMatchObject({ name: 'Supino reto com barra', repMin: 6, repMax: 10, sets: 3, restSec: 150, warmupSets: 1, equipment: 'barbell', category: 'compound', targetWeight: 50 });
  });

  it('usa descanso padrão por tipo quando omitido', () => {
    const ficha = { formato: 'irontrack.ficha', versao: 1, nome: 'X', treinos: [{ rotulo: 'a', nome: 'T', exercicios: [
      { nome: 'Agachamento', grupo: 'Quadríceps', tipo: 'composto', series: 3, repeticoes: '6-10' },
      { nome: 'Rosca', grupo: 'Bíceps', tipo: 'isolado', series: 3, repeticoes: 12 },
    ] }] };
    const r = parseFicha(JSON.stringify(ficha), rest);
    expect(r.ok && r.value.workouts[0].exercises.map((e) => e.restSec)).toEqual([150, 90]);
    expect(r.ok && r.value.workouts[0].label).toBe('A');
  });

  it('exportar e importar de novo preserva a ficha', () => {
    const r = parseFicha(sample, rest);
    if (!r.ok) throw new Error();
    const again = parseFicha(JSON.stringify(routineToFicha(r.value)), rest);
    if (!again.ok) throw new Error(again.errors.join());
    const strip = (x: typeof r.value) => x.workouts.map((w) => w.exercises.map(({ id: _id, ...e }) => e));
    expect(strip(again.value)).toEqual(strip(r.value));
  });

  it('JSON malformado gera mensagem clara', () => {
    const r = parseFicha('{ "formato": ', rest);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors[0]).toMatch(/JSON inválido/);
  });

  it('erros apontam treino e exercício', () => {
    const bad = { formato: 'irontrack.ficha', versao: 1, nome: 'X', treinos: [{ rotulo: 'A', nome: 'T', exercicios: [
      { nome: 'Supino', grupo: 'Peito', series: 0, repeticoes: '10-6' },
    ] }] };
    const r = parseFicha(JSON.stringify(bad), rest);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.startsWith('Treino 1 › Exercício 1 › series') && e.includes('mínimo de 1 série'))).toBe(true);
    expect(r.errors.some((e) => e.includes('faixa de repetições inválida'))).toBe(true);
  });

  it('formato errado e rótulos duplicados', () => {
    const r1 = parseFicha(JSON.stringify({ formato: 'outro', versao: 1, nome: 'x', treinos: [] }), rest);
    expect(!r1.ok && r1.errors.join(' ')).toMatch(/formato/);
    const ex = { nome: 'S', grupo: 'Peito', series: 3, repeticoes: 8 };
    const r2 = parseFicha(JSON.stringify({ formato: 'irontrack.ficha', versao: 1, nome: 'x', treinos: [
      { rotulo: 'A', nome: '1', exercicios: [ex] }, { rotulo: 'a', nome: '2', exercicios: [ex] },
    ] }), rest);
    expect(!r2.ok && r2.errors.join(' ')).toMatch(/repetido/);
  });

  it('equipamento inválido', () => {
    const r = parseFicha(JSON.stringify({ formato: 'irontrack.ficha', versao: 1, nome: 'x', treinos: [
      { rotulo: 'A', nome: '1', exercicios: [{ nome: 'S', grupo: 'Peito', series: 3, repeticoes: 8, equipamento: 'kettle' }] },
    ] }), rest);
    expect(!r.ok && r.errors.join(' ')).toMatch(/equipamento deve ser/);
  });
});

describe('importação de avaliações corporais', () => {
  it('aceita e converte', () => {
    const r = parseBodyJson(JSON.stringify({ formato: 'irontrack.avaliacoes', versao: 1, avaliacoes: [{ data: '2026-10-01', peso: 80.5, gordura: 18, cintura: 84 }] }));
    expect(r.ok && r.value[0]).toMatchObject({ date: '2026-10-01', weightKg: 80.5, bodyFatPct: 18, waistCm: 84 });
  });
  it('rejeita data inválida com mensagem', () => {
    const r = parseBodyJson(JSON.stringify({ formato: 'irontrack.avaliacoes', versao: 1, avaliacoes: [{ data: '01/10/2026' }] }));
    expect(!r.ok && r.errors[0]).toMatch(/Avaliação 1 › data/);
  });
});
