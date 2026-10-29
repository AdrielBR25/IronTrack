// Esqueleto do humanoide do IronTrack (P20, docs/ANIMACOES_EXERCICIOS.md). Modelo criado para o projeto: proporções de
// um adulto de ~1,75 m, sem malha nem textura de terceiros.
// - Tronco por cinemática direta: posição e orientação da pelve, flexão do abdômen, do peito e do pescoço.
// - Braços e pernas por cinemática inversa de dois segmentos: a pose diz onde ficam as mãos (na barra, no halter, na
//   polia) e os tornozelos (no chão, na plataforma), e para onde apontam cotovelos e joelhos. Assim a pegada não "escorrega"
//   da barra e os pés não deslizam no chão: os testes conferem que cada alvo é alcançável sem esticar o membro.
// Puro e determinístico (sem three.js): os mesmos números alimentam o desenho e os testes.
import { DEG, add, apply, axisOf, cross, dist, fromAxes, mul, norm, perp, rotX, rotY, rotZ, scale, sub, type Mat3, type Vec3 } from './math';

export const BODY = {
  hipHalfWidth: 0.09,
  pelvisToAbdomen: 0.1,
  abdomenLength: 0.22,
  chestLength: 0.3,
  shoulderOffset: [0.19, 0.25, -0.01] as Vec3,
  upperArm: 0.29,
  forearm: 0.26,
  thigh: 0.44,
  shin: 0.43,
  ankleHeight: 0.07,
  footLength: 0.24,
} as const;

/** O quadril fica 2 cm abaixo do centro da pelve. */
export const HIP_DROP = 0.02;
/** Altura da pelve em pé, joelhos quase estendidos (~10°), com os tornozelos a `ankleHeight` do chão. */
export const STANDING_PELVIS_Y = BODY.thigh + BODY.shin + BODY.ankleHeight + HIP_DROP - 0.004;

export type Side = 'L' | 'R';
export const SIDES: readonly Side[] = ['L', 'R'];
/** +1 para o lado esquerdo (X positivo), −1 para o direito. */
export const sideSign = (s: Side) => (s === 'L' ? 1 : -1);

/** Onde fica um alvo de mão ou pé. */
export type Target =
  /** Ponto fixo no mundo (barra, pegador, chão, plataforma). */
  | { at: Vec3 }
  /** Ponto no sistema do peito (ex.: barra apoiada nas costas, mãos cruzadas no peito). */
  | { chest: Vec3 }
  /** Deslocamento no mundo a partir do ombro do mesmo lado (ex.: braços pendurados na vertical). */
  | { fromShoulder: Vec3 };

export interface LimbPose {
  target: Target;
  /** Direção (mundo) para onde aponta o cotovelo ou o joelho. */
  pole: Vec3;
}

export interface Pose {
  /** Centro do quadril, no mundo (m). */
  pelvis: Vec3;
  /** Inclinação da pelve: flexão para a frente (+), rotação vertical, inclinação lateral (graus). */
  pelvisPitch: number;
  pelvisYaw?: number;
  pelvisRoll?: number;
  /** Flexão para a frente (+) do abdômen sobre a pelve, do peito sobre o abdômen e da cabeça sobre o peito (graus). */
  spine: number;
  chest: number;
  neck: number;
  hands: Record<Side, LimbPose>;
  feet: Record<Side, LimbPose>;
  /** Inclinação do pé no mundo (graus; + = calcanhar sobe). Só com `footMode` 'world'. */
  footPitch?: number;
  /** 'world' (padrão): pé apoiado, orientado pelo mundo. 'shin': tornozelo neutro, o pé acompanha a perna (deitado, sentado). */
  footMode?: 'world' | 'shin';
}

export type Segment =
  | 'pelvis'
  | 'abdomen'
  | 'chest'
  | 'head'
  | 'upperArmL'
  | 'upperArmR'
  | 'forearmL'
  | 'forearmR'
  | 'thighL'
  | 'thighR'
  | 'shinL'
  | 'shinR'
  | 'footL'
  | 'footR';

export const SEGMENTS: readonly Segment[] = ['pelvis', 'abdomen', 'chest', 'head', 'upperArmL', 'upperArmR', 'forearmL', 'forearmR', 'thighL', 'thighR', 'shinL', 'shinR', 'footL', 'footR'];

/** Origem do segmento (articulação proximal) e eixos locais no mundo. Membros se estendem pelo −Y local. */
export interface SegmentFrame {
  origin: Vec3;
  rot: Mat3;
}

export interface LimbSolution {
  root: Vec3;
  joint: Vec3;
  end: Vec3;
  /** O alvo pedido; difere de `end` só quando estava fora de alcance. */
  target: Vec3;
  /** Distância raiz→alvo dividida pelo comprimento total do membro (>1 = alvo inalcançável). */
  reach: number;
  /** Flexão do cotovelo/joelho em graus (0 = estendido). */
  flexion: number;
}

export interface SolvedPose {
  frames: Record<Segment, SegmentFrame>;
  arms: Record<Side, LimbSolution>;
  legs: Record<Side, LimbSolution>;
  shoulders: Record<Side, Vec3>;
  hips: Record<Side, Vec3>;
  head: Vec3;
}

/**
 * Dois segmentos (comprimentos a, b) da raiz até o alvo, dobrando na direção do `pole`. Alvo além do alcance: o membro
 * estica na direção dele (e `reach` > 1 denuncia o problema nos testes).
 */
export function solveTwoBone(root: Vec3, target: Vec3, a: number, b: number, pole: Vec3): LimbSolution {
  const toT = sub(target, root);
  const raw = Math.hypot(...toT);
  const u = norm(toT, [0, -1, 0]);
  const d = Math.min(Math.max(raw, Math.abs(a - b) + 1e-4), a + b - 1e-6);
  const cosA = Math.max(-1, Math.min(1, (a * a + d * d - b * b) / (2 * a * d)));
  const sinA = Math.sqrt(1 - cosA * cosA);
  const v = perp(pole, u, Math.abs(u[1]) < 0.9 ? [0, 1, 0] : [0, 0, 1]);
  const joint = add(root, add(scale(u, a * cosA), scale(v, a * sinA)));
  const end = add(root, scale(u, d));
  const cosJ = Math.max(-1, Math.min(1, (a * a + b * b - d * d) / (2 * a * b)));
  return { root, joint, end, target, reach: raw / (a + b), flexion: 180 - Math.acos(cosJ) / DEG };
}

/** Eixos de um segmento que vai de `from` a `to` (−Y local), com a frente (+Z local) do lado de `front`. */
function boneFrame(from: Vec3, to: Vec3, front: Vec3): SegmentFrame {
  const y = norm(sub(from, to));
  const z = perp(front, y, Math.abs(y[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0]);
  const x = cross(y, z);
  return { origin: from, rot: fromAxes(x, y, z) };
}

function resolveTarget(t: Target, chest: SegmentFrame, shoulder: Vec3): Vec3 {
  if ('at' in t) return t.at;
  if ('chest' in t) return add(chest.origin, apply(chest.rot, t.chest));
  return add(shoulder, t.fromShoulder);
}

export function solvePose(p: Pose): SolvedPose {
  const pelvisRot = mul(rotY(p.pelvisYaw ?? 0), mul(rotX(p.pelvisPitch), rotZ(p.pelvisRoll ?? 0)));
  const pelvis: SegmentFrame = { origin: p.pelvis, rot: pelvisRot };
  const abdRot = mul(pelvisRot, rotX(p.spine));
  const abdomen: SegmentFrame = { origin: add(p.pelvis, apply(pelvisRot, [0, BODY.pelvisToAbdomen, 0])), rot: abdRot };
  const chestRot = mul(abdRot, rotX(p.chest));
  const chest: SegmentFrame = { origin: add(abdomen.origin, apply(abdRot, [0, BODY.abdomenLength, 0])), rot: chestRot };
  const headRot = mul(chestRot, rotX(p.neck));
  const head: SegmentFrame = { origin: add(chest.origin, apply(chestRot, [0, BODY.chestLength, 0])), rot: headRot };

  const shoulders = {} as Record<Side, Vec3>;
  const hips = {} as Record<Side, Vec3>;
  const arms = {} as Record<Side, LimbSolution>;
  const legs = {} as Record<Side, LimbSolution>;
  const frames = { pelvis, abdomen, chest, head } as Record<Segment, SegmentFrame>;
  const footRot = mul(rotY(p.pelvisYaw ?? 0), rotX(p.footPitch ?? 0));

  for (const s of SIDES) {
    const k = sideSign(s);
    const so = BODY.shoulderOffset;
    shoulders[s] = add(chest.origin, apply(chestRot, [k * so[0], so[1], so[2]]));
    hips[s] = add(p.pelvis, apply(pelvisRot, [k * BODY.hipHalfWidth, -HIP_DROP, 0]));

    const hand = p.hands[s];
    const arm = solveTwoBone(shoulders[s], resolveTarget(hand.target, chest, shoulders[s]), BODY.upperArm, BODY.forearm, hand.pole);
    arms[s] = arm;
    // Braço: o cotovelo aponta para o `pole`; a frente do braço (bíceps) fica do lado oposto, o lado da flexão.
    frames[`upperArm${s}`] = boneFrame(arm.root, arm.joint, scale(hand.pole, -1));
    frames[`forearm${s}`] = boneFrame(arm.joint, arm.end, scale(hand.pole, -1));

    const foot = p.feet[s];
    const leg = solveTwoBone(hips[s], resolveTarget(foot.target, chest, hips[s]), BODY.thigh, BODY.shin, foot.pole);
    legs[s] = leg;
    // Perna: o joelho aponta para o `pole`, que é a frente da coxa (quadríceps); a panturrilha fica atrás.
    frames[`thigh${s}`] = boneFrame(leg.root, leg.joint, foot.pole);
    frames[`shin${s}`] = boneFrame(leg.joint, leg.end, foot.pole);
    frames[`foot${s}`] = { origin: leg.end, rot: p.footMode === 'shin' ? frames[`shin${s}`].rot : footRot };
  }
  return { frames, arms, legs, shoulders, hips, head: add(head.origin, apply(headRot, [0, 0.15, 0])) };
}

/** Posição do quadril de um lado para uma pelve e inclinação dadas (para desenhar arcos com a coxa parada). */
export function hipOf(pelvis: Vec3, pitch: number, side: Side, yaw = 0): Vec3 {
  return add(pelvis, apply(mul(rotY(yaw), rotX(pitch)), [sideSign(side) * BODY.hipHalfWidth, -HIP_DROP, 0]));
}

/** Posição do ombro de um lado para uma pose de tronco (sem resolver os membros). */
export function shoulderOf(p: Pick<Pose, 'pelvis' | 'pelvisPitch' | 'pelvisYaw' | 'pelvisRoll' | 'spine' | 'chest'>, side: Side): Vec3 {
  const pr = mul(rotY(p.pelvisYaw ?? 0), mul(rotX(p.pelvisPitch), rotZ(p.pelvisRoll ?? 0)));
  const ar = mul(pr, rotX(p.spine));
  const cr = mul(ar, rotX(p.chest));
  const chest = add(add(p.pelvis, apply(pr, [0, BODY.pelvisToAbdomen, 0])), apply(ar, [0, BODY.abdomenLength, 0]));
  const so = BODY.shoulderOffset;
  return add(chest, apply(cr, [sideSign(side) * so[0], so[1], so[2]]));
}

/** Ponta do pé (bola do pé) no mundo, para conferir que ela não sai do lugar na panturrilha. */
export function toeOf(frame: SegmentFrame): Vec3 {
  return add(frame.origin, apply(frame.rot, [0, -BODY.ankleHeight + 0.02, BODY.footLength * 0.72]));
}

/** Calcanhar no mundo. */
export function heelOf(frame: SegmentFrame): Vec3 {
  return add(frame.origin, apply(frame.rot, [0, -BODY.ankleHeight + 0.02, -0.05]));
}

/** Flexão do tronco em relação à vertical (graus): ângulo entre o eixo do peito e o +Y do mundo. */
export function trunkAngle(s: SolvedPose): number {
  const y = axisOf(s.frames.chest.rot, 1);
  return Math.acos(Math.max(-1, Math.min(1, y[1]))) / DEG;
}

/** Menor altura de qualquer articulação (para conferir que nada atravessa o chão). */
export function lowestPoint(s: SolvedPose): number {
  const pts: Vec3[] = [s.head, ...SIDES.flatMap((k) => [s.arms[k].joint, s.arms[k].end, s.legs[k].joint, heelOf(s.frames[`foot${k}`]), toeOf(s.frames[`foot${k}`])])];
  return Math.min(...pts.map((p) => p[1]));
}

export const handsMid = (s: SolvedPose): Vec3 => scale(add(s.arms.L.end, s.arms.R.end), 0.5);
export const anklesMid = (s: SolvedPose): Vec3 => scale(add(s.legs.L.end, s.legs.R.end), 0.5);
export const gripWidth = (s: SolvedPose) => dist(s.arms.L.end, s.arms.R.end);
