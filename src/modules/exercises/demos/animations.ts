// Demonstrações 3D (P20, docs/ANIMACOES_EXERCICIOS.md). Cada demonstração descreve o movimento REAL do exercício por
// poses-chave do esqueleto (./rig.ts) e o equipamento usado. Nada é genérico: um supino nunca usa a animação de um
// agachamento. Só existem aqui movimentos implementados um a um e conferidos pelos testes de geometria
// (tests/unit/anatomy-demos.test.ts) e por inspeção visual; os demais exercícios do catálogo ficam com o mapa muscular e
// as instruções em texto (manifesto em ./manifest.ts).
import { add, apply, lerp, lerpV, rotX, smoothstep, type Vec3 } from './math';
import { BODY, STANDING_PELVIS_Y, hipOf, shoulderOf, sideSign, type LimbPose, type Pose, type Side, type Target } from './rig';

/** Equipamento desenhado junto com o humanoide. */
export type Prop =
  | { kind: 'barbell'; anchor: 'hands' | 'chest'; length?: number; plates?: boolean }
  | { kind: 'dumbbell'; side: Side; axis: 'x' | 'z' }
  | { kind: 'box'; id: string; center: Vec3; size: Vec3; tiltX?: number; tone?: 'pad' | 'frame' }
  | { kind: 'cable'; from: Vec3; to: 'hands' | 'handL' | 'handR' }
  | { kind: 'handle'; anchor: 'hands'; width: number }
  | { kind: 'platform'; anchor: 'feet'; size: Vec3; tiltX: number }
  | { kind: 'shinPad'; side: 'front' | 'back' };

export type Phase = 'excentrica' | 'concentrica' | 'pausa' | 'sustentacao';

export interface Cue {
  from: number;
  to: number;
  phase: Phase;
  /** Índice do passo em `instructions` do catálogo (texto sincronizado), quando houver correspondência. */
  instruction: number | null;
  text: string;
}

export interface Demo {
  /** Identificador estável da animação (sobe a versão quando o movimento muda). */
  id: string;
  version: number;
  catalogIds: string[];
  kind: 'animated' | 'static';
  /** Duração de um ciclo em segundos (velocidade 1×). */
  cycleSec: number;
  /**
   * Trajeto do movimento, da posição inicial à final, em poses igualmente espaçadas (arcos usam vários pontos para que
   * cotovelo e joelho fiquem parados onde devem). O ciclo é ida em [0, 0.45], pausa curta e volta em [0.55, 1], com
   * aceleração e desaceleração suaves. Posições estáticas têm uma pose só.
   */
  path: Pose[];
  props: Prop[];
  cues: Cue[];
  /** Vistas oferecidas. A lateral é a principal para quase todos os movimentos. */
  views: ('lateral' | 'frontal')[];
  equipment: string;
  /** Centro da cena para a câmera (m). */
  focus: Vec3;
}

// ---------------------------------------------------------------- utilitários de pose

const at = (p: Vec3): Target => ({ at: p });
const mirror = (p: Vec3): Vec3 => [-p[0], p[1], p[2]];
/** Membros simétricos: dá o lado esquerdo (X+) e espelha para o direito. */
function sym(target: (v: Vec3) => Target, left: Vec3, poleLeft: Vec3): Record<Side, LimbPose> {
  return { L: { target: target(left), pole: poleLeft }, R: { target: target(mirror(left)), pole: mirror(poleLeft) } };
}
const symAt = (left: Vec3, poleLeft: Vec3) => sym(at, left, poleLeft);
const symChest = (left: Vec3, poleLeft: Vec3) => sym((v) => ({ chest: v }), left, poleLeft);
const symShoulder = (left: Vec3, poleLeft: Vec3) => sym((v) => ({ fromShoulder: v }), left, poleLeft);

const FLOOR_ANKLE = 0.07;
/** Pés no chão, afastados na largura do quadril, joelhos para a frente. */
const standingFeet = (x = 0.11, z = 0) => symAt([x, FLOOR_ANKLE, z], [0.15, 0, 1]);

const pose = (p: Partial<Pose> & Pick<Pose, 'pelvis' | 'hands' | 'feet'>): Pose => ({ pelvisPitch: 0, spine: 0, chest: 0, neck: 0, ...p });

// ---------------------------------------------------------------- interpolação

function lerpTarget(a: Target, b: Target, t: number): Target {
  if ('at' in a && 'at' in b) return { at: lerpV(a.at, b.at, t) };
  if ('chest' in a && 'chest' in b) return { chest: lerpV(a.chest, b.chest, t) };
  if ('fromShoulder' in a && 'fromShoulder' in b) return { fromShoulder: lerpV(a.fromShoulder, b.fromShoulder, t) };
  return t < 0.5 ? a : b;
}
const lerpLimb = (a: LimbPose, b: LimbPose, t: number): LimbPose => ({ target: lerpTarget(a.target, b.target, t), pole: lerpV(a.pole, b.pole, t) });
const lerpSides = (a: Record<Side, LimbPose>, b: Record<Side, LimbPose>, t: number) => ({ L: lerpLimb(a.L, b.L, t), R: lerpLimb(a.R, b.R, t) });

export function lerpPose(a: Pose, b: Pose, t: number): Pose {
  return {
    pelvis: lerpV(a.pelvis, b.pelvis, t),
    pelvisPitch: lerp(a.pelvisPitch, b.pelvisPitch, t),
    pelvisYaw: lerp(a.pelvisYaw ?? 0, b.pelvisYaw ?? 0, t),
    pelvisRoll: lerp(a.pelvisRoll ?? 0, b.pelvisRoll ?? 0, t),
    spine: lerp(a.spine, b.spine, t),
    chest: lerp(a.chest, b.chest, t),
    neck: lerp(a.neck, b.neck, t),
    hands: lerpSides(a.hands, b.hands, t),
    feet: lerpSides(a.feet, b.feet, t),
    footPitch: lerp(a.footPitch ?? 0, b.footPitch ?? 0, t),
    ...(a.footMode ? { footMode: a.footMode } : {}),
  };
}

const GO_END = 0.45;
const BACK_START = 0.55;

/** Fração do trajeto (0 = início, 1 = fim) no momento `phase` do ciclo (0–1, cíclico). */
export function pathProgress(phase: number): number {
  const p = ((phase % 1) + 1) % 1;
  if (p < GO_END) return smoothstep(p / GO_END);
  if (p < BACK_START) return 1;
  return smoothstep(1 - (p - BACK_START) / (1 - BACK_START));
}

/** Pose no momento `phase` do ciclo. */
export function poseAt(demo: Pick<Demo, 'path'>, phase: number): Pose {
  const path = demo.path;
  if (path.length === 1) return path[0];
  const u = pathProgress(phase) * (path.length - 1);
  const i = Math.min(path.length - 2, Math.floor(u));
  return lerpPose(path[i], path[i + 1], u - i);
}

export const cueAt = (demo: Pick<Demo, 'cues'>, phase: number): Cue | null => demo.cues.find((c) => phase >= c.from && phase < c.to) ?? null;

/** Ciclo de ida e volta pelo trajeto `path`: ida em [0, 0.45], pausa curta, volta em [0.55, 1]. */
function cycle(id: string, catalogIds: string[], path: Pose[], o: Omit<Demo, 'id' | 'catalogIds' | 'path' | 'kind' | 'cues' | 'version'> & { down: Omit<Cue, 'from' | 'to' | 'phase'> & { phase?: Phase }; up: Omit<Cue, 'from' | 'to' | 'phase'> & { phase?: Phase }; version?: number }): Demo {
  const { down, up, version, ...rest } = o;
  return {
    id,
    version: version ?? 1,
    catalogIds,
    kind: 'animated',
    path,
    cues: [
      { from: 0, to: 0.45, phase: down.phase ?? 'excentrica', instruction: down.instruction, text: down.text },
      { from: 0.45, to: 0.55, phase: 'pausa', instruction: null, text: 'Pausa curta, sem perder a posição.' },
      { from: 0.55, to: 1.0001, phase: up.phase ?? 'concentrica', instruction: up.instruction, text: up.text },
    ],
    ...rest,
  };
}

// ---------------------------------------------------------------- cenários reutilizados

/** `n` + 1 valores igualmente espaçados de `a` a `b` (pontos de um arco). */
const steps = (a: number, b: number, n = 4) => Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);
/** Ponto a `r` m de `c`, no plano YZ, num ângulo (graus) medido a partir de "para baixo" (−Y) girando para a frente (+Z). */
const arcYZ = (c: Vec3, r: number, deg: number): Vec3 => [c[0], c[1] - r * Math.cos((deg * Math.PI) / 180), c[2] + r * Math.sin((deg * Math.PI) / 180)];
const STAND_Y = STANDING_PELVIS_Y;

const BENCH_TOP = 0.45;
/** Deitado de costas num banco reto: centro do quadril e altura do tronco. */
const SUPINE_PELVIS: Vec3 = [0, BENCH_TOP + 0.11, 0.3];
const flatBench = (): Prop => ({ kind: 'box', id: 'banco', center: [0, BENCH_TOP - 0.05, -0.02], size: [0.3, 0.1, 1.2], tone: 'pad' });
const benchLegs = (): Prop => ({ kind: 'box', id: 'banco-base', center: [0, (BENCH_TOP - 0.1) / 2, -0.02], size: [0.08, BENCH_TOP - 0.1, 0.9], tone: 'frame' });
/** Pés apoiados no chão com joelhos dobrados (supino, crucifixo). */
const supineFeet = symAt([0.24, FLOOR_ANKLE, 0.78], [0.25, 1, 0.2]);

const SEAT_TOP = 0.47;
/** Sentado num banco/assento: centro do quadril. */
const seatedPelvis = (z = 0): Vec3 => [0, SEAT_TOP + 0.09, z];
const seatedFeet = (x = 0.16, z = 0.42) => symAt([x, FLOOR_ANKLE, z], [0.15, 0.2, 1]);
const seat = (z = 0, w = 0.36): Prop => ({ kind: 'box', id: 'assento', center: [0, SEAT_TOP - 0.05, z], size: [w, 0.1, 0.4], tone: 'pad' });
const seatBase = (z = 0): Prop => ({ kind: 'box', id: 'assento-base', center: [0, (SEAT_TOP - 0.1) / 2, z], size: [0.08, SEAT_TOP - 0.1, 0.3], tone: 'frame' });

// ---------------------------------------------------------------- demonstrações

/** Supino reto com barra: a barra desce na vertical até a parte baixa do peito e sobe; a pegada não muda. */
const supinoReto = cycle(
  'supino-reto-barra',
  ['supino-reto-barra'],
  [
    pose({ pelvis: SUPINE_PELVIS, pelvisPitch: -90, neck: -5, hands: symAt([0.4, 1.03, -0.28], [0.6, -0.4, 0.15]), feet: supineFeet }),
    pose({ pelvis: SUPINE_PELVIS, pelvisPitch: -90, neck: -5, hands: symAt([0.4, 0.74, -0.18], [0.6, -0.8, 0.15]), feet: supineFeet }),
  ],
  {
    cycleSec: 3.2,
    props: [flatBench(), benchLegs(), { kind: 'barbell', anchor: 'hands', plates: true }],
    views: ['lateral', 'frontal'],
    equipment: 'Barra e banco reto',
    focus: [0, 0.75, 0],
    down: { instruction: 2, text: 'Desça a barra de forma controlada até perto do peito.' },
    up: { instruction: 3, text: 'Empurre a barra de volta até estender os braços, sem travar os cotovelos com impacto.' },
  },
);

/** Supino reto com halteres: mesmo plano do supino com barra; os halteres se aproximam no alto, sem bater. */
const supinoRetoHalteres = cycle(
  'supino-reto-halteres',
  ['supino-reto-halteres'],
  [
    pose({ pelvis: SUPINE_PELVIS, pelvisPitch: -90, neck: -5, hands: symAt([0.25, 1.05, -0.28], [0.6, -0.4, 0.15]), feet: supineFeet }),
    pose({ pelvis: SUPINE_PELVIS, pelvisPitch: -90, neck: -5, hands: symAt([0.37, 0.78, -0.2], [0.6, -0.8, 0.15]), feet: supineFeet }),
  ],
  {
    cycleSec: 3.2,
    props: [flatBench(), benchLegs(), { kind: 'dumbbell', side: 'L', axis: 'x' }, { kind: 'dumbbell', side: 'R', axis: 'x' }],
    views: ['lateral', 'frontal'],
    equipment: 'Halteres e banco reto',
    focus: [0, 0.75, 0],
    down: { instruction: 2, text: 'Desça os halteres de forma controlada até a altura do peito.' },
    up: { instruction: 1, text: 'Empurre os halteres para cima, aproximando-os sem bater.' },
  },
);

/** Supino inclinado com halteres: encosto a ~35°; os halteres sobem na perpendicular do tronco, sobre a parte alta do peito. */
const INCLINE = 35;
const inclineTorso = { pelvis: [0, SEAT_TOP + 0.09, 0.05] as Vec3, pelvisPitch: -(90 - INCLINE), spine: 0, chest: 0 };
const incSh = shoulderOf(inclineTorso, 'L');
/** Direção "para a frente" do tronco inclinado (perpendicular ao encosto). */
const incFront = apply(rotX(inclineTorso.pelvisPitch), [0, 0, 1]);
const incUp = apply(rotX(inclineTorso.pelvisPitch), [0, 1, 0]);
const incHand = (out: number, front: number, up: number): Vec3 => add(add(add(incSh, [out, 0, 0]), lerpV([0, 0, 0], incFront, front)), lerpV([0, 0, 0], incUp, up));
const incFeet = symAt([0.22, FLOOR_ANKLE, 0.55], [0.2, 0.4, 1]);
const supinoInclinado = cycle(
  'supino-inclinado-halteres',
  ['supino-inclinado-halteres'],
  [
    pose({ ...inclineTorso, neck: -10, hands: symAt(incHand(0.05, 0.5, 0.02), [0.7, -0.5, 0.6]), feet: incFeet }),
    pose({ ...inclineTorso, neck: -10, hands: symAt(incHand(0.19, 0.15, -0.03), [0.7, -0.5, 0.6]), feet: incFeet }),
  ],
  {
    cycleSec: 3.2,
    props: [
      seat(0.08, 0.32),
      seatBase(0.08),
      { kind: 'box', id: 'encosto', center: add(add(inclineTorso.pelvis, lerpV([0, 0, 0], incUp, 0.38)), lerpV([0, 0, 0], incFront, -0.15)), size: [0.3, 0.07, 0.85], tiltX: inclineTorso.pelvisPitch + 90, tone: 'pad' },
      { kind: 'dumbbell', side: 'L', axis: 'x' },
      { kind: 'dumbbell', side: 'R', axis: 'x' },
    ],
    views: ['lateral', 'frontal'],
    equipment: 'Halteres e banco inclinado',
    focus: [0, 0.95, 0],
    down: { instruction: 3, text: 'Desça de forma controlada até uma amplitude confortável.' },
    up: { instruction: 2, text: 'Empurre os halteres para cima, aproximando-os sem bater.' },
  },
);

/** Agachamento livre: barra no trapézio, pés parados; o quadril desce e vai para trás, o tronco inclina e os joelhos seguem os pés. */
const squatFeet = symAt([0.17, FLOOR_ANKLE, 0], [0.35, 0, 1]);
const squatHands = symChest([0.42, 0.27, -0.13], [0.5, -0.6, -0.6]);
const agachamento = cycle(
  'agachamento-livre',
  ['agachamento-livre'],
  [
    pose({ pelvis: [0, STAND_Y - 0.01, 0], hands: squatHands, feet: squatFeet }),
    pose({ pelvis: [0, 0.74, -0.12], pelvisPitch: 18, spine: 2, neck: -12, hands: squatHands, feet: squatFeet }),
    pose({ pelvis: [0, 0.54, -0.28], pelvisPitch: 38, spine: 4, neck: -25, hands: squatHands, feet: squatFeet }),
  ],
  {
    cycleSec: 3.6,
    props: [{ kind: 'barbell', anchor: 'chest', plates: true }],
    views: ['lateral', 'frontal'],
    equipment: 'Barra (apoiada no trapézio)',
    focus: [0, 0.85, 0],
    down: { instruction: 1, text: 'Desça levando o quadril para trás e para baixo, joelhos na direção dos pés.' },
    up: { instruction: 2, text: 'Suba empurrando o chão, mantendo o tronco firme.' },
  },
);

/** Leg press 45°: costas no encosto, pés na plataforma; a plataforma desce no trilho de 45° e os joelhos dobram. */
const LP_PELVIS: Vec3 = [0, 0.42, 0];
const LP_DIR: Vec3 = [0, Math.SQRT1_2, Math.SQRT1_2];
const lpFeet = (d: number) => symAt([0.15, LP_PELVIS[1] + LP_DIR[1] * d, LP_PELVIS[2] + LP_DIR[2] * d], [0.2, 0.7, 0.2]);
const lpPose = (d: number) => pose({ pelvis: LP_PELVIS, pelvisPitch: -62, neck: 20, hands: symAt([0.3, 0.45, -0.15], [0.6, 0.2, -0.6]), feet: lpFeet(d), footPitch: -135 });
const legPress = cycle('leg-press', ['leg-press'], [lpPose(0.84), lpPose(0.63), lpPose(0.45)], {
  cycleSec: 3.6,
  props: [
    { kind: 'box', id: 'assento', center: [0, 0.3, -0.02], size: [0.42, 0.08, 0.42], tiltX: -10, tone: 'pad' },
    { kind: 'box', id: 'encosto', center: [0, 0.47, -0.39], size: [0.42, 0.72, 0.08], tiltX: -62, tone: 'pad' },
    { kind: 'box', id: 'base', center: [0, 0.13, -0.1], size: [0.5, 0.26, 0.6], tone: 'frame' },
    { kind: 'platform', anchor: 'feet', size: [0.7, 0.04, 0.5], tiltX: 45 },
  ],
  views: ['lateral'],
  equipment: 'Leg press 45°',
  focus: [0, 0.75, 0.35],
  down: { instruction: 1, text: 'Deixe a plataforma descer de forma controlada, dobrando os joelhos sem tirar a lombar do encosto.' },
  up: { instruction: 2, text: 'Empurre a plataforma com os pés inteiros até quase estender os joelhos, sem travá-los.' },
});

/** Cadeira extensora: sentado, coxas apoiadas e paradas; só o joelho estende (o pé descreve um arco em torno do joelho). */
const EXT_TORSO = { pelvis: seatedPelvis(-0.05), pelvisPitch: -12 };
const extKnee = (s: Side): Vec3 => add(hipOf(EXT_TORSO.pelvis, EXT_TORSO.pelvisPitch, s), [0, 0, BODY.thigh]);
const extHands = symAt([0.27, 0.64, -0.02], [0.4, 0, -1]);
const extPose = (deg: number) =>
  pose({
    ...EXT_TORSO,
    spine: 2,
    hands: extHands,
    feet: { L: { target: at(arcYZ(extKnee('L'), BODY.shin, deg)), pole: [0, 1, 0.3] }, R: { target: at(arcYZ(extKnee('R'), BODY.shin, deg)), pole: [0, 1, 0.3] } },
    footMode: 'shin',
  });
const extensora = cycle('cadeira-extensora', ['cadeira-extensora'], steps(8, 82).map(extPose), {
  cycleSec: 3.2,
  props: [seat(-0.02, 0.4), seatBase(-0.02), { kind: 'box', id: 'encosto', center: [0, 0.82, -0.27], size: [0.4, 0.62, 0.08], tiltX: -12, tone: 'pad' }, { kind: 'shinPad', side: 'front' }],
  views: ['lateral'],
  equipment: 'Cadeira extensora',
  focus: [0, 0.6, 0.25],
  down: { phase: 'concentrica', instruction: 1, text: 'Estenda os joelhos levantando o rolo, sem tirar o quadril do assento.' },
  up: { phase: 'excentrica', instruction: 2, text: 'Volte de forma controlada até a posição inicial.' },
});

/** Mesa flexora: deitado de bruços, joelhos logo após a borda do banco; só o joelho flexiona, o rolo vem em direção ao glúteo. */
const PRONE = { pelvis: [0, BENCH_TOP + 0.09, 0.05] as Vec3, pelvisPitch: 90 };
const proneKnee = (s: Side): Vec3 => add(hipOf(PRONE.pelvis, PRONE.pelvisPitch, s), [0, 0, -BODY.thigh]);
/** Arco do tornozelo atrás do joelho: 0° = perna estendida no prolongamento da coxa; sobe para trás do corpo. */
const curlFoot = (s: Side, deg: number): Vec3 => {
  const k = proneKnee(s);
  const r = (deg * Math.PI) / 180;
  return [k[0], k[1] + BODY.shin * Math.sin(r), k[2] - BODY.shin * Math.cos(r)];
};
const curlPose = (deg: number) =>
  pose({
    ...PRONE,
    neck: -20,
    hands: symAt([0.26, 0.4, 0.88], [0.6, 0.5, -0.4]),
    feet: { L: { target: at(curlFoot('L', deg)), pole: [0, -1, 0] }, R: { target: at(curlFoot('R', deg)), pole: [0, -1, 0] } },
    footMode: 'shin',
  });
const flexora = cycle('mesa-flexora', ['mesa-flexora'], steps(8, 95).map(curlPose), {
  cycleSec: 3.2,
  props: [
    { kind: 'box', id: 'banco', center: [0, BENCH_TOP - 0.05, 0.32], size: [0.36, 0.1, 1.26], tone: 'pad' },
    { kind: 'box', id: 'banco-base', center: [0, (BENCH_TOP - 0.1) / 2, 0.32], size: [0.08, BENCH_TOP - 0.1, 1], tone: 'frame' },
    { kind: 'shinPad', side: 'back' },
  ],
  views: ['lateral'],
  equipment: 'Mesa flexora',
  focus: [0, 0.6, -0.1],
  down: { phase: 'concentrica', instruction: 1, text: 'Flexione os joelhos levando o rolo em direção ao glúteo, sem tirar o quadril do banco.' },
  up: { phase: 'excentrica', instruction: 2, text: 'Volte de forma controlada até quase estender os joelhos.' },
});

/** Puxada frontal (puxada alta): sentado, pegada aberta; a barra desce até a parte de cima do peito com os cotovelos para baixo. */
const PD_PELVIS = seatedPelvis(0);
const pdFeet = seatedFeet(0.14, 0.38);
const puxada = cycle(
  'puxada-frontal',
  ['puxada-frontal'],
  [
    pose({ pelvis: PD_PELVIS, pelvisPitch: -8, hands: symAt([0.4, 1.56, 0.1], [1, -0.2, -0.3]), feet: pdFeet }),
    pose({ pelvis: PD_PELVIS, pelvisPitch: -12, neck: 6, hands: symAt([0.4, 1.33, 0.14], [1, -0.7, -0.3]), feet: pdFeet }),
    pose({ pelvis: PD_PELVIS, pelvisPitch: -15, neck: 10, hands: symAt([0.38, 1.13, 0.17], [1, -1, -0.4]), feet: pdFeet }),
  ],
  {
    cycleSec: 3.2,
    props: [
      seat(0, 0.36),
      seatBase(0),
      { kind: 'box', id: 'apoio-coxas', center: [0, SEAT_TOP + 0.24, 0.26], size: [0.4, 0.07, 0.1], tone: 'pad' },
      { kind: 'barbell', anchor: 'hands', length: 1.2, plates: false },
      { kind: 'cable', from: [0, 2.3, 0.12], to: 'hands' },
    ],
    views: ['lateral', 'frontal'],
    equipment: 'Polia alta com barra (puxador)',
    focus: [0, 1.15, 0.1],
    down: { phase: 'concentrica', instruction: 1, text: 'Puxe a barra em direção à parte de cima do peito, levando os cotovelos para baixo.' },
    up: { phase: 'excentrica', instruction: 2, text: 'Volte de forma controlada até estender os braços.' },
  },
);

/** Remada baixa (sentada, polia baixa): tronco firme; as mãos vêm do alcance à frente até o abdômen, cotovelos junto ao corpo. */
const ROW_PELVIS: Vec3 = [0, 0.38, 0];
const rowFeet = symAt([0.13, 0.3, 0.83], [0.2, 1, 0.3]);
const remada = cycle(
  'remada-baixa',
  ['remada-baixa'],
  [
    pose({ pelvis: ROW_PELVIS, pelvisPitch: 10, neck: -6, hands: symAt([0.09, 0.8, 0.6], [0.3, -0.3, -1]), feet: rowFeet, footPitch: -90 }),
    pose({ pelvis: ROW_PELVIS, pelvisPitch: 2, neck: -3, hands: symAt([0.1, 0.72, 0.4], [0.35, -0.3, -1]), feet: rowFeet, footPitch: -90 }),
    pose({ pelvis: ROW_PELVIS, pelvisPitch: -4, hands: symAt([0.1, 0.68, 0.2], [0.35, -0.3, -1]), feet: rowFeet, footPitch: -90 }),
  ],
  {
    cycleSec: 3.2,
    props: [
      { kind: 'box', id: 'banco', center: [0, 0.24, 0.05], size: [0.3, 0.08, 0.9], tone: 'pad' },
      { kind: 'box', id: 'banco-base', center: [0, 0.1, 0.05], size: [0.08, 0.2, 0.7], tone: 'frame' },
      { kind: 'box', id: 'apoio-pes', center: [0, 0.3, 0.94], size: [0.4, 0.3, 0.04], tone: 'frame' },
      { kind: 'handle', anchor: 'hands', width: 0.16 },
      { kind: 'cable', from: [0, 0.42, 1.3], to: 'hands' },
    ],
    views: ['lateral'],
    equipment: 'Polia baixa com pegador em V',
    focus: [0, 0.6, 0.4],
    down: { phase: 'concentrica', instruction: 1, text: 'Puxe o pegador em direção ao abdômen, cotovelos junto ao corpo, sem jogar o tronco para trás.' },
    up: { phase: 'excentrica', instruction: 2, text: 'Volte de forma controlada até estender os braços.' },
  },
);

/** Desenvolvimento com halteres (sentado): os halteres sobem da altura das orelhas até acima da cabeça, sem travar os cotovelos. */
const DEV_PELVIS = seatedPelvis(0);
const devHands = (x: number, y: number) => symAt([x, y, 0.02], [1, -0.9, -0.2]);
const desenvolvimento = cycle(
  'desenvolvimento-halteres',
  ['desenvolvimento-halteres'],
  [
    pose({ pelvis: DEV_PELVIS, pelvisPitch: -4, hands: devHands(0.42, 1.24), feet: seatedFeet() }),
    pose({ pelvis: DEV_PELVIS, pelvisPitch: -4, hands: devHands(0.33, 1.45), feet: seatedFeet() }),
    pose({ pelvis: DEV_PELVIS, pelvisPitch: -4, hands: devHands(0.19, 1.62), feet: seatedFeet() }),
  ],
  {
    cycleSec: 3.2,
    props: [seat(0, 0.34), seatBase(0), { kind: 'box', id: 'encosto', center: [0, 0.88, -0.17], size: [0.32, 0.66, 0.07], tiltX: -4, tone: 'pad' }, { kind: 'dumbbell', side: 'L', axis: 'x' }, { kind: 'dumbbell', side: 'R', axis: 'x' }],
    views: ['frontal', 'lateral'],
    equipment: 'Halteres e banco com encosto',
    focus: [0, 1.15, 0],
    down: { phase: 'concentrica', instruction: 1, text: 'Empurre os halteres para cima até quase estender os braços.' },
    up: { phase: 'excentrica', instruction: 2, text: 'Desça de forma controlada até a altura das orelhas.' },
  },
);

/** Elevação lateral: em pé; os braços sobem pelo lado num arco até a altura dos ombros, cotovelos levemente dobrados. */
const LAT_R = 0.52;
const latHand = (deg: number): Vec3 => {
  const r = (deg * Math.PI) / 180;
  return [0.02 + LAT_R * Math.sin(r), -LAT_R * Math.cos(r), 0.06];
};
const elevacaoLateral = cycle(
  'elevacao-lateral',
  ['elevacao-lateral'],
  steps(10, 86).map((deg) => pose({ pelvis: [0, STAND_Y - 0.01, 0], hands: symShoulder(latHand(deg), [0.3, 0.4, -1]), feet: standingFeet() })),
  {
    cycleSec: 3,
    props: [
      { kind: 'dumbbell', side: 'L', axis: 'z' },
      { kind: 'dumbbell', side: 'R', axis: 'z' },
    ],
    views: ['frontal', 'lateral'],
    equipment: 'Halteres',
    focus: [0, 1.1, 0],
    down: { phase: 'concentrica', instruction: 1, text: 'Eleve os braços pelas laterais até a altura dos ombros, cotovelos levemente dobrados.' },
    up: { phase: 'excentrica', instruction: 2, text: 'Desça de forma controlada, sem balançar o tronco.' },
  },
);

/** Rosca direta com barra: cotovelos parados ao lado do corpo; só o antebraço sobe em arco. */
const curlPelvis: Vec3 = [0, STAND_Y - 0.01, 0];
const curlElbow = (s: Side): Vec3 => add(shoulderOf({ pelvis: curlPelvis, pelvisPitch: 0, spine: 0, chest: 0 }, s), [0, -BODY.upperArm, 0.02]);
const bicepsPose = (deg: number) =>
  pose({ pelvis: curlPelvis, hands: { L: { target: at(arcYZ(curlElbow('L'), BODY.forearm, deg)), pole: [0, 0, -1] }, R: { target: at(arcYZ(curlElbow('R'), BODY.forearm, deg)), pole: [0, 0, -1] } }, feet: standingFeet() });
const rosca = cycle('rosca-direta', ['rosca-direta'], steps(10, 135).map(bicepsPose), {
  cycleSec: 3,
  props: [{ kind: 'barbell', anchor: 'hands', length: 1.3, plates: true }],
  views: ['lateral', 'frontal'],
  equipment: 'Barra',
  focus: [0, 1.1, 0],
  down: { phase: 'concentrica', instruction: 1, text: 'Flexione os cotovelos trazendo a barra até perto dos ombros, sem mover os cotovelos para a frente.' },
  up: { phase: 'excentrica', instruction: 2, text: 'Desça de forma controlada até estender os braços.' },
});

/** Tríceps na polia: cotovelos parados junto ao corpo; os antebraços descem até estender. */
const triTorso = { pelvis: [0, STAND_Y - 0.02, -0.02] as Vec3, pelvisPitch: 8, spine: 0, chest: 0 };
const triElbow = (s: Side): Vec3 => add(shoulderOf(triTorso, s), [-sideSign(s) * 0.03, -BODY.upperArm + 0.01, 0.02]);
const triPose = (deg: number) =>
  pose({ ...triTorso, hands: { L: { target: at(arcYZ(triElbow('L'), BODY.forearm, deg)), pole: [0.1, 0, -1] }, R: { target: at(arcYZ(triElbow('R'), BODY.forearm, deg)), pole: [-0.1, 0, -1] } }, feet: standingFeet(0.13, 0) });
const triceps = cycle('triceps-polia', ['triceps-polia'], steps(100, 8).map(triPose), {
  cycleSec: 2.8,
  props: [
    { kind: 'handle', anchor: 'hands', width: 0.3 },
    { kind: 'cable', from: [0, 2.2, 0.45], to: 'hands' },
    { kind: 'box', id: 'torre', center: [0, 1.15, 0.6], size: [0.25, 2.3, 0.12], tone: 'frame' },
  ],
  views: ['lateral'],
  equipment: 'Polia alta com barra reta',
  focus: [0, 1.1, 0.15],
  down: { phase: 'concentrica', instruction: 1, text: 'Estenda os cotovelos levando a barra para baixo, cotovelos parados junto ao corpo.' },
  up: { phase: 'excentrica', instruction: 2, text: 'Volte de forma controlada até os antebraços passarem da horizontal.' },
});

/** Stiff: joelhos quase estendidos, dobradiça do quadril com coluna neutra; a barra desce rente às pernas. */
const stiffFeet = symAt([0.12, FLOOR_ANKLE, 0], [0.1, 0, 1]);
const stiffHands = symShoulder([0.02, -0.535, 0.0], [0.3, 0, -1]);
const stiff = cycle(
  'stiff',
  ['stiff'],
  [
    pose({ pelvis: [0, STAND_Y - 0.005, 0], hands: stiffHands, feet: stiffFeet }),
    pose({ pelvis: [0, STAND_Y - 0.025, -0.085], pelvisPitch: 36, spine: 1, neck: -15, hands: stiffHands, feet: stiffFeet }),
    pose({ pelvis: [0, STAND_Y - 0.045, -0.16], pelvisPitch: 72, spine: 3, neck: -30, hands: stiffHands, feet: stiffFeet }),
  ],
  {
    cycleSec: 3.6,
    props: [{ kind: 'barbell', anchor: 'hands', plates: true }],
    views: ['lateral'],
    equipment: 'Barra',
    focus: [0, 0.8, 0],
    down: { instruction: 1, text: 'Leve o quadril para trás com os joelhos quase estendidos e a coluna neutra; a barra desce rente às pernas.' },
    up: { instruction: 2, text: 'Volte estendendo o quadril, contraindo glúteos e posteriores da coxa.' },
  },
);

/** Panturrilha em pé: pontas dos pés na borda do degrau; o calcanhar desce abaixo da borda e sobe (só o tornozelo trabalha). */
const STEP_TOP = 0.12;
const CALF_TOE: Vec3 = [0.11, STEP_TOP, 0.12];
/** Tornozelo para uma inclinação do pé (graus; + = calcanhar acima da ponta), girando em torno da bola do pé. */
const calfAnkle = (heelUp: number): Vec3 => {
  const r = (heelUp * Math.PI) / 180;
  const toeFwd = BODY.footLength * 0.72;
  const toeDown = BODY.ankleHeight - 0.02;
  return [CALF_TOE[0], CALF_TOE[1] + toeDown * Math.cos(r) + toeFwd * Math.sin(r), CALF_TOE[2] - toeFwd * Math.cos(r) + toeDown * Math.sin(r)];
};
const calfPose = (heelUp: number) => {
  const a = calfAnkle(heelUp);
  return pose({ pelvis: [0, a[1] + STAND_Y - FLOOR_ANKLE - 0.002, a[2] - 0.02], hands: symAt([0.24, 1.3, 0.22], [0.5, -0.6, -1]), feet: symAt(a, [0.1, 0, 1]), footPitch: heelUp });
};
const panturrilha = cycle('panturrilha-em-pe', ['panturrilha-em-pe'], steps(-18, 32, 2).map(calfPose), {
  cycleSec: 2.6,
  props: [
    { kind: 'box', id: 'degrau', center: [0, STEP_TOP / 2, 0.3], size: [0.6, STEP_TOP, 0.4], tone: 'frame' },
    { kind: 'box', id: 'apoio', center: [0, 1.28, 0.26], size: [0.7, 0.04, 0.04], tone: 'frame' },
  ],
  views: ['lateral'],
  equipment: 'Degrau (apoio para as mãos)',
  focus: [0, 0.8, 0.1],
  down: { phase: 'concentrica', instruction: 1, text: 'Suba na ponta dos pés o máximo que conseguir, com os joelhos estendidos.' },
  up: { phase: 'excentrica', instruction: 2, text: 'Desça os calcanhares de forma controlada abaixo da linha do degrau.' },
});

/** Abdominal tradicional (crunch): deitado, joelhos dobrados; só a parte de cima do tronco enrola, a lombar fica no chão. */
const MAT_Y = 0.02;
const CR_PELVIS: Vec3 = [0, MAT_Y + 0.1, 0];
const crFeet = symAt([0.14, MAT_Y + 0.07, 0.62], [0.2, 1, 0.1]);
const crHands = symChest([0.12, 0.2, 0.16], [0.6, 0, -0.5]);
const abdominal = cycle(
  'abdominal-tradicional',
  ['abdominal-tradicional'],
  [
    pose({ pelvis: CR_PELVIS, pelvisPitch: -90, neck: 10, hands: crHands, feet: crFeet }),
    pose({ pelvis: CR_PELVIS, pelvisPitch: -90, spine: 16, chest: 16, neck: 18, hands: crHands, feet: crFeet }),
  ],
  {
    cycleSec: 2.8,
    props: [{ kind: 'box', id: 'colchonete', center: [0, MAT_Y / 2, 0.1], size: [0.6, MAT_Y, 1.8], tone: 'pad' }],
    views: ['lateral'],
    equipment: 'Colchonete',
    focus: [0, 0.3, 0],
    down: { phase: 'concentrica', instruction: 1, text: 'Contraia o abdômen e tire as escápulas do chão, aproximando as costelas do quadril.' },
    up: { phase: 'excentrica', instruction: 2, text: 'Volte devagar, sem soltar o corpo e sem puxar o pescoço.' },
  },
);

// ---------------------------------------------------------------- posições estáticas (isometria)

function hold(id: string, catalogIds: string[], p: Pose, o: Pick<Demo, 'props' | 'views' | 'equipment' | 'focus'> & { text: string; instruction: number | null }): Demo {
  return { id, version: 1, catalogIds, kind: 'static', cycleSec: 1, path: [p], cues: [{ from: 0, to: 1.0001, phase: 'sustentacao', instruction: o.instruction, text: o.text }], props: o.props, views: o.views, equipment: o.equipment, focus: o.focus };
}

/** Prancha: apoio nos antebraços (cotovelos sob os ombros) e nas pontas dos pés, corpo alinhado. */
const PLANK = { pelvis: [0, 0.33, 0] as Vec3, pelvisPitch: 81, spine: 0, chest: 0 };
const plankSh = shoulderOf(PLANK, 'L');
const prancha = hold(
  'prancha',
  ['prancha'],
  pose({
    ...PLANK,
    neck: -8,
    hands: symAt([0.12, 0.05, plankSh[2] + 0.25], [0.2, -1, -0.4]),
    feet: symAt([0.1, 0.175, -0.865], [0.1, -1, 0.1]),
    footPitch: 90,
  }),
  { props: [{ kind: 'box', id: 'colchonete', center: [0, 0.01, 0], size: [0.6, 0.02, 1.9], tone: 'pad' }], views: ['lateral'], equipment: 'Colchonete', focus: [0, 0.3, 0], text: 'Mantenha o corpo alinhado da cabeça aos calcanhares, abdômen firme.', instruction: 1 },
);

/** Agachamento isométrico na parede: costas na parede, joelhos a ~90°. */
const wallSit = hold(
  'wall-sit',
  ['wall-sit'],
  pose({ pelvis: [0, 0.5, -0.12], pelvisPitch: -2, hands: symShoulder([0.06, -0.5, 0.12], [0.6, 0, -0.5]), feet: symAt([0.14, FLOOR_ANKLE, 0.32], [0.2, 0.3, 1]) }),
  { props: [{ kind: 'box', id: 'parede', center: [0, 1.0, -0.27], size: [1.2, 2.0, 0.06], tone: 'frame' }], views: ['lateral'], equipment: 'Parede', focus: [0, 0.75, 0], text: 'Costas apoiadas na parede, joelhos dobrados perto de 90°, peso nos pés inteiros.', instruction: 1 },
);

/** Suspensão na barra: braços estendidos, corpo pendurado. */
const deadHang = hold(
  'dead-hang',
  ['dead-hang'],
  pose({ pelvis: [0, 1.12, 0], hands: symAt([0.3, 2.225, 0], [1, 0, -0.3]), feet: symAt([0.1, 0.24, 0.02], [0, 0, 1]), footPitch: 30 }),
  { props: [{ kind: 'barbell', anchor: 'hands', length: 1.4, plates: false }], views: ['frontal', 'lateral'], equipment: 'Barra fixa', focus: [0, 1.4, 0], text: 'Pendure-se com os braços estendidos e os ombros ativos (sem afundar).', instruction: 1 },
);

export const DEMOS: readonly Demo[] = [
  supinoReto,
  supinoRetoHalteres,
  supinoInclinado,
  agachamento,
  legPress,
  extensora,
  flexora,
  puxada,
  remada,
  desenvolvimento,
  elevacaoLateral,
  rosca,
  triceps,
  stiff,
  panturrilha,
  abdominal,
  prancha,
  wallSit,
  deadHang,
];

/** Demonstração de um exercício do catálogo (null = só mapa muscular e instruções). */
export function demoFor(catalogId: string): Demo | null {
  return DEMOS.find((d) => d.catalogIds.includes(catalogId)) ?? null;
}

/** Postura neutra (em pé, braços ao lado do corpo) para os exercícios sem demonstração: só o mapa muscular no humanoide. */
export const NEUTRAL_POSE: Pose = pose({ pelvis: [0, STAND_Y - 0.008, 0], hands: symShoulder([0.06, -0.53, 0.03], [0.3, 0, -1]), feet: standingFeet() });
