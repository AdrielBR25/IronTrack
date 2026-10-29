// Cores do destaque muscular (P20, docs/MAPA_ANATOMICO.md): as mesmas no humanoide 3D e no mapa 2D. Nunca só a cor:
// a legenda em texto lista os músculos, e no mapa 2D o secundário também tem hachura.
export const MUSCLE_COLORS = {
  /** Principal: vermelho (red-600). */
  primary: '#dc2626',
  /** Secundário: laranja mais claro (orange-400). */
  secondary: '#fb923c',
  /** Músculo sem destaque. */
  neutral: '#a3afc0',
  /** Corpo (manequim neutro). */
  body: '#cbd5e1',
} as const;
