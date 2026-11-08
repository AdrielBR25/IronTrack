// Fase 08: catálogo de funções do menu Mais, ações rápidas e padrão enxuto do Início.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ALL_FEATURES, CATEGORIES, DEFAULT_QUICK, QUICK_ACTIONS, frequentFeatures, readQuick, recordUse, saveQuick, searchFeatures } from '@/cloud/life/catalog';
import { DEFAULT_HOME_LAYOUT, normalizeLayout } from '@shared/planner/protocol.ts';

const APP = readFileSync(join(__dirname, '../../src/App.tsx'), 'utf8');
const routeOf = (to: string) => to.split('?')[0];

describe('catálogo do Mais (Fase 08)', () => {
  beforeEach(() => localStorage.clear());

  it('sete categorias com poucos itens, sem caminhos duplicados e só rotas que existem', () => {
    expect(CATEGORIES).toHaveLength(7);
    for (const c of CATEGORIES) expect(c.items.length).toBeLessThanOrEqual(6);
    const tos = ALL_FEATURES.map((f) => f.to);
    expect(new Set(tos).size).toBe(tos.length);
    expect(new Set(ALL_FEATURES.map((f) => f.id)).size).toBe(ALL_FEATURES.length);
    for (const to of [...tos, ...QUICK_ACTIONS.map((a) => a.to)]) expect(APP, to).toContain(`path="${routeOf(to)}"`);
  });

  it('busca sem acento e por sinônimo', () => {
    expect(searchFeatures('recordes').map((f) => f.id)).toContain('desempenho');
    expect(searchFeatures('pomodoro').map((f) => f.id)).toContain('foco');
    expect(searchFeatures('BIBLIA planos').map((f) => f.id)).toEqual(['planos-biblia']);
    expect(searchFeatures('   ')).toEqual([]);
  });

  it('mais usados aprendem com o uso (a partir de 2 aberturas) e completam com o padrão', () => {
    expect(frequentFeatures().map((f) => f.id)).toEqual(['treinar', 'diario', 'missoes', 'foco']);
    recordUse('desempenho');
    expect(frequentFeatures().map((f) => f.id)).not.toContain('desempenho');
    recordUse('desempenho');
    expect(frequentFeatures()[0].id).toBe('desempenho');
  });

  it('ações rápidas: 4 por conta, inválidas ou repetidas voltam ao padrão', () => {
    expect(readQuick('a')).toEqual(DEFAULT_QUICK);
    saveQuick('a', ['biblia', 'treinar', 'foto', 'ia']);
    expect(readQuick('a')).toEqual(['biblia', 'treinar', 'foto', 'ia']);
    expect(readQuick('b')).toEqual(DEFAULT_QUICK);
    saveQuick('a', ['biblia', 'biblia', 'x', 'ia']);
    expect(readQuick('a')).toEqual(DEFAULT_QUICK);
  });
});

describe('padrão do Início (Fase 08)', () => {
  it('mostra só o essencial por padrão e preserva layouts salvos', () => {
    const on = DEFAULT_HOME_LAYOUT.filter((c) => c.visible).map((c) => c.id);
    expect(on).toEqual(['character', 'today', 'next_activities', 'workout', 'bible', 'week_goals', 'ai']);
    const saved = [{ id: 'nutrition', visible: true }, { id: 'today', visible: false }];
    const n = normalizeLayout(saved);
    expect(n.slice(0, 2)).toEqual(saved);
    expect(n).toHaveLength(DEFAULT_HOME_LAYOUT.length);
  });
});
