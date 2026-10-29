// Demonstrações 3D (P20): cada movimento é conferido pela geometria do esqueleto — nenhum membro esticado além do
// comprimento, nada abaixo do chão, apoios parados onde devem ficar e a amplitude característica de cada exercício.
import { describe, expect, it } from 'vitest';
import { getCatalog } from '@/modules/exercises/catalog';
import {
  ALL_PARTS,
  BODY,
  DEMOS,
  MUSCLE_PARTS,
  NEUTRAL_POSE,
  PART_SHAPES,
  coverage,
  cueAt,
  demoForCatalog,
  dist,
  emphasisFor,
  heelOf,
  lowestPoint,
  pathProgress,
  poseAt,
  solvePose,
  toeOf,
  trunkAngle,
  visualFor,
  type Demo,
  type SolvedPose,
} from '@/modules/exercises/demos';

const PHASES = Array.from({ length: 41 }, (_, i) => i / 40);
const solveAll = (d: Demo) => PHASES.map((p) => solvePose(poseAt(d, p)));
const range = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
const byId = (id: string) => DEMOS.find((d) => d.id === id)!;
const top = (d: Demo) => solvePose(poseAt(d, 0));
const bottom = (d: Demo) => solvePose(poseAt(d, 0.5));
const knee = (s: SolvedPose) => s.legs.L.flexion;
const elbow = (s: SolvedPose) => s.arms.L.flexion;

describe('esqueleto e ciclo', () => {
  it('ciclo: ida, pausa e volta, contínuo e sem saltos', () => {
    expect(pathProgress(0)).toBe(0);
    expect(pathProgress(0.5)).toBe(1);
    expect(pathProgress(0.999)).toBeCloseTo(0, 3);
    for (let i = 1; i < 200; i++) expect(Math.abs(pathProgress(i / 200) - pathProgress((i - 1) / 200))).toBeLessThan(0.05);
  });

  it('postura neutra: em pé, pés no chão, membros dentro do alcance', () => {
    const s = solvePose(NEUTRAL_POSE);
    expect(lowestPoint(s)).toBeGreaterThanOrEqual(-0.005);
    expect(lowestPoint(s)).toBeLessThan(0.03);
    expect(trunkAngle(s)).toBeLessThan(3);
    expect(s.legs.L.reach).toBeLessThanOrEqual(1);
    expect(s.arms.L.reach).toBeLessThanOrEqual(1);
  });
});

describe.each(DEMOS.map((d) => [d.id, d] as const))('%s: geometria válida', (_id, d) => {
  const solved = solveAll(d);

  it('nenhum membro esticado além do comprimento e nada abaixo do chão', () => {
    for (const s of solved) {
      for (const side of ['L', 'R'] as const) {
        expect(s.arms[side].reach).toBeLessThanOrEqual(1.0001);
        expect(s.legs[side].reach).toBeLessThanOrEqual(1.0001);
      }
      expect(lowestPoint(s)).toBeGreaterThan(-0.01);
    }
  });

  it('simetria esquerda/direita (movimentos bilaterais)', () => {
    for (const s of solved) {
      expect(s.arms.L.end[0]).toBeCloseTo(-s.arms.R.end[0], 3);
      expect(s.legs.L.end[1]).toBeCloseTo(s.legs.R.end[1], 3);
    }
  });

  it('textos sincronizados cobrem o ciclo inteiro e apontam para passos existentes do catálogo', () => {
    for (const p of PHASES.slice(0, -1)) expect(cueAt(d, p)).not.toBeNull();
    for (const id of d.catalogIds) {
      const entry = getCatalog().find((c) => c.catalogId === id);
      expect(entry, id).toBeDefined();
      for (const c of d.cues) if (c.instruction !== null) expect(c.instruction).toBeLessThan(entry!.instructions.length);
    }
  });

  it('animado tem trajeto de 2+ poses; estático tem uma', () => {
    if (d.kind === 'animated') expect(d.path.length).toBeGreaterThanOrEqual(2);
    else expect(d.path).toHaveLength(1);
  });
});

describe('cada movimento faz o que o exercício faz', () => {
  it('supino reto com barra: barra sobe ≥ 25 cm quase na vertical; cotovelos dobram ≥ 90°', () => {
    const d = byId('supino-reto-barra');
    const ys = solveAll(d).map((s) => s.arms.L.end[1]);
    expect(range(ys)).toBeGreaterThan(0.25);
    expect(Math.abs(top(d).arms.L.end[2] - bottom(d).arms.L.end[2])).toBeLessThan(0.15);
    expect(elbow(bottom(d))).toBeGreaterThan(90);
    expect(elbow(top(d))).toBeLessThan(45);
  });

  it('agachamento: quadril desce ≥ 30 cm, joelhos passam de 90°, pés parados no chão', () => {
    const d = byId('agachamento-livre');
    const all = solveAll(d);
    expect(range(all.map((s) => s.frames.pelvis.origin[1]))).toBeGreaterThan(0.3);
    expect(knee(bottom(d))).toBeGreaterThan(90);
    expect(range(all.map((s) => s.legs.L.end[2]))).toBeLessThan(0.001);
    for (const s of all) expect(Math.min(toeOf(s.frames.footL)[1], heelOf(s.frames.footL)[1])).toBeLessThan(0.04);
  });

  it('cadeira extensora: só o joelho trabalha (≈80° → ≈10°), coxa e quadril parados', () => {
    const d = byId('cadeira-extensora');
    const all = solveAll(d);
    expect(knee(top(d))).toBeGreaterThan(75);
    expect(knee(bottom(d))).toBeLessThan(15);
    expect(range(all.map((s) => s.legs.L.joint[1]))).toBeLessThan(0.02);
    expect(range(all.map((s) => s.frames.pelvis.origin[2]))).toBeLessThan(1e-9);
  });

  it('mesa flexora: joelho de quase estendido até ≥ 90°, coxa parada', () => {
    const d = byId('mesa-flexora');
    const all = solveAll(d);
    expect(knee(top(d))).toBeLessThan(15);
    expect(knee(bottom(d))).toBeGreaterThan(90);
    expect(range(all.map((s) => s.legs.L.joint[2]))).toBeLessThan(0.02);
  });

  it('leg press: a plataforma percorre o trilho de 45° e os joelhos dobram ≥ 100°', () => {
    const d = byId('leg-press');
    const a = top(d).legs.L.end;
    const b = bottom(d).legs.L.end;
    expect(Math.abs(a[1] - b[1] - (a[2] - b[2]))).toBeLessThan(0.01);
    expect(knee(bottom(d))).toBeGreaterThan(100);
  });

  it('rosca direta: cotovelo parado (< 6 cm), antebraço sobe ≥ 120°', () => {
    const d = byId('rosca-direta');
    const all = solveAll(d);
    const e0 = all[0].arms.L.joint;
    for (const s of all) expect(dist(s.arms.L.joint, e0)).toBeLessThan(0.06);
    expect(elbow(bottom(d))).toBeGreaterThan(120);
  });

  it('tríceps na polia: cotovelo parado e estende de ≈100° até < 30°', () => {
    const d = byId('triceps-polia');
    const all = solveAll(d);
    const e0 = all[0].arms.L.joint;
    for (const s of all) expect(dist(s.arms.L.joint, e0)).toBeLessThan(0.06);
    expect(elbow(top(d))).toBeGreaterThan(90);
    expect(elbow(bottom(d))).toBeLessThan(30);
  });

  it('elevação lateral: as mãos sobem pelo lado até perto da altura dos ombros', () => {
    const d = byId('elevacao-lateral');
    const b = bottom(d);
    expect(b.arms.L.end[1]).toBeGreaterThan(b.shoulders.L[1] - 0.1);
    expect(b.arms.L.end[0]).toBeGreaterThan(0.6);
    expect(Math.abs(b.arms.L.end[2] - b.shoulders.L[2])).toBeLessThan(0.1);
  });

  it('desenvolvimento: mãos saem da altura das orelhas e terminam acima da cabeça', () => {
    const d = byId('desenvolvimento-halteres');
    expect(top(d).arms.L.end[1]).toBeLessThan(top(d).head[1]);
    expect(bottom(d).arms.L.end[1]).toBeGreaterThan(bottom(d).head[1] + 0.1);
  });

  it('puxada frontal: a barra desce de acima da cabeça até a frente do peito', () => {
    const d = byId('puxada-frontal');
    expect(top(d).arms.L.end[1]).toBeGreaterThan(top(d).head[1]);
    expect(bottom(d).arms.L.end[1]).toBeLessThan(bottom(d).shoulders.L[1] + 0.05);
    expect(elbow(bottom(d))).toBeGreaterThan(80);
  });

  it('remada baixa: mãos vêm à frente até o abdômen, tronco quase parado', () => {
    const d = byId('remada-baixa');
    expect(top(d).arms.L.end[2] - bottom(d).arms.L.end[2]).toBeGreaterThan(0.3);
    expect(range(solveAll(d).map(trunkAngle))).toBeLessThan(16);
  });

  it('stiff: dobradiça do quadril ≥ 60°, joelhos quase estendidos (< 30°), pés parados', () => {
    const d = byId('stiff');
    const all = solveAll(d);
    expect(trunkAngle(bottom(d))).toBeGreaterThan(60);
    for (const s of all) expect(knee(s)).toBeLessThan(30);
    expect(range(all.map((s) => s.legs.L.end[2]))).toBeLessThan(1e-9);
  });

  it('panturrilha: só o tornozelo trabalha — calcanhar sobe ≥ 12 cm e joelho fica estendido', () => {
    const d = byId('panturrilha-em-pe');
    const all = solveAll(d);
    expect(range(all.map((s) => heelOf(s.frames.footL)[1]))).toBeGreaterThan(0.12);
    for (const s of all) expect(knee(s)).toBeLessThan(20);
    expect(range(all.map((s) => toeOf(s.frames.footL)[1]))).toBeLessThan(0.01);
  });

  it('abdominal: o tronco enrola ≥ 25° sem tirar o quadril do chão', () => {
    const d = byId('abdominal-tradicional');
    expect(trunkAngle(top(d)) - trunkAngle(bottom(d))).toBeGreaterThan(25);
    expect(range(solveAll(d).map((s) => s.frames.pelvis.origin[1]))).toBeLessThan(1e-9);
  });

  it('prancha: corpo alinhado (ombro, quadril e tornozelo quase em linha), antebraços no chão', () => {
    const s = solvePose(byId('prancha').path[0]);
    const sh = s.shoulders.L;
    const an = s.legs.L.end;
    const hip = s.hips.L;
    const t = (hip[2] - sh[2]) / (an[2] - sh[2]);
    expect(Math.abs(hip[1] - (sh[1] + (an[1] - sh[1]) * t))).toBeLessThan(0.06);
    expect(s.arms.L.end[1]).toBeLessThan(0.08);
  });

  it('agachamento na parede: joelhos perto de 90°', () => {
    expect(knee(solvePose(byId('wall-sit').path[0]))).toBeGreaterThan(80);
  });

  it('suspensão na barra: braços estendidos e pés fora do chão', () => {
    const s = solvePose(byId('dead-hang').path[0]);
    expect(elbow(s)).toBeLessThan(20);
    expect(lowestPoint(s)).toBeGreaterThan(0.05);
  });
});

describe('manifesto de cobertura (honesto)', () => {
  const ids = getCatalog().map((c) => c.catalogId);

  it('cobre os 110 exercícios do catálogo e só cita IDs existentes', () => {
    expect(ids).toHaveLength(110);
    for (const d of DEMOS) for (const id of d.catalogIds) expect(ids).toContain(id);
    const c = coverage(ids);
    expect(c.animado + c.posicao + c.anatomia).toBe(110);
    expect(c).toEqual({ animado: 16, posicao: 3, anatomia: 91 });
  });

  it('cada exercício tem no máximo uma demonstração; personalizados e desconhecidos ficam só com o mapa', () => {
    const seen = new Set<string>();
    for (const d of DEMOS) for (const id of d.catalogIds) {
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
    expect(visualFor('cx_abc').status).toBe('anatomia');
    expect(visualFor(null).demoId).toBeNull();
    expect(demoForCatalog('supino-reto-barra')?.id).toBe('supino-reto-barra');
    expect(visualFor('prancha').status).toBe('posicao');
  });
});

describe('músculos: uma taxonomia só', () => {
  it('todo grupo da biblioteca acende regiões existentes; principal vence secundário', () => {
    for (const parts of Object.values(MUSCLE_PARTS)) for (const p of parts) expect(ALL_PARTS).toContain(p);
    const e = emphasisFor(['peitoral'], ['triceps', 'peitoral', 'ombros']);
    expect(e.get('peitoral')).toBe('primary');
    expect(e.get('triceps')).toBe('secondary');
    expect(e.get('quadriceps')).toBeUndefined();
    expect(emphasisFor(['corpo_inteiro'], []).size).toBe(ALL_PARTS.length);
  });

  it('toda região tem forma no humanoide', () => {
    for (const p of ALL_PARTS) expect(PART_SHAPES.some((s) => s.part === p)).toBe(true);
    expect(BODY.thigh).toBeGreaterThan(0);
  });
});
