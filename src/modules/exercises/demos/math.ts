// Álgebra mínima do esqueleto (P20). Vetores [x, y, z] e matrizes 3×3 em ordem de linha. Sem dependências: a mesma
// conta alimenta o desenho 3D e os testes de validação dos movimentos.
// Eixos do mundo: Y para cima, Z para a frente do corpo em pé, X para o lado ESQUERDO da pessoa.
export type Vec3 = readonly [number, number, number];
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

export const DEG = Math.PI / 180;
export const ZERO: Vec3 = [0, 0, 0];
export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const dist = (a: Vec3, b: Vec3) => len(sub(a, b));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const lerpV = (a: Vec3, b: Vec3, t: number): Vec3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
export const mid = (a: Vec3, b: Vec3): Vec3 => lerpV(a, b, 0.5);

export function norm(a: Vec3, fallback: Vec3 = [0, 1, 0]): Vec3 {
  const l = len(a);
  return l > 1e-9 ? scale(a, 1 / l) : fallback;
}

/** Componente de `v` perpendicular ao eixo unitário `axis`, normalizada. */
export const perp = (v: Vec3, axis: Vec3, fallback: Vec3): Vec3 => norm(sub(v, scale(axis, dot(v, axis))), fallback);

export function rotX(deg: number): Mat3 {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}
export function rotY(deg: number): Mat3 {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}
export function rotZ(deg: number): Mat3 {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

export function mul(a: Mat3, b: Mat3): Mat3 {
  const o = new Array<number>(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o as unknown as Mat3;
}

export const apply = (m: Mat3, v: Vec3): Vec3 => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];

/** Matriz cujas colunas são os eixos locais X, Y e Z expressos no mundo. */
export const fromAxes = (x: Vec3, y: Vec3, z: Vec3): Mat3 => [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
export const axisOf = (m: Mat3, i: 0 | 1 | 2): Vec3 => [m[i], m[3 + i], m[6 + i]];

/** Ângulo (graus) entre dois vetores. */
export function angleBetween(a: Vec3, b: Vec3): number {
  const c = dot(norm(a), norm(b));
  return Math.acos(Math.max(-1, Math.min(1, c))) / DEG;
}

/** Suavização das transições entre poses-chave (começa e termina devagar). */
export const smoothstep = (t: number) => t * t * (3 - 2 * t);
