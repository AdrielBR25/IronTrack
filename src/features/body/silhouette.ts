// Silhueta 2D do corpo (metade esquerda, espelhada), compartilhada pelo mapa de medidas (BodyMap) e pelo mapa muscular
// dos exercícios (P20, features/anatomy/MuscleMap2D). Coordenadas no viewBox 200×405, eixo central em x=100.

export const ARM = 'M50 98 Q43 114 43 133 Q49 141 57 137 Q61 119 59 104 Z';
export const THIGH = 'M67 209 Q60 250 66 290 Q76 298 88 290 Q96 250 98 206 Q89 200 81 202 Z';
export const CALF = 'M68 312 Q62 342 68 380 L82 382 Q90 344 88 312 Z';

// Contorno do corpo (metade esquerda), suavizado com Catmull-Rom.
const OUTLINE: [number, number][] = [
  [100, 49], [92, 50], [90, 62], [80, 66], [66, 69], [54, 74], [47, 88], [43, 108], [41, 132], [37, 152], [33, 176], [31, 190], [30, 201],
  [34, 209], [41, 210], [45, 202], [46, 190], [50, 168], [56, 146], [59, 124], [63, 106], [65, 124], [68, 142], [70, 158], [67, 178],
  [64, 200], [61, 236], [62, 270], [65, 296], [66, 316], [63, 344], [66, 372], [67, 386], [61, 396], [74, 400], [87, 398], [86, 384],
  [89, 354], [90, 322], [90, 304], [93, 280], [97, 246], [99, 214], [100, 212],
];

function smooth(pts: [number, number][]) {
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const [p1, p2] = [pts[i], pts[i + 1]];
    const p3 = pts[i + 2] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0]} ${p2[1]}`;
  }
  return d + ' Z';
}
export const SILHOUETTE = smooth(OUTLINE);
export const MIRROR = 'translate(200 0) scale(-1 1)';
