// API pública da biblioteca de exercícios (IronTrack 2.0 F01/P17). Ver docs/BIBLIOTECA_EXERCICIOS.md.
// Domínio puro e determinístico: sem React, sem Dexie, sem rede, sem IA. Usa só as APIs públicas do treinamento
// (modelo da ficha) e do analytics (normalização muscular do P09). O catálogo padrão tem entrada própria,
// '@/modules/exercises/catalog', para só entrar no pacote de quem o usa (a tela da biblioteca, carregada sob demanda).
// Fora deste diretório, importe sempre por '@/modules/exercises'.
export type * from './types';
export * from './vocab';
export * from './search';
export * from './custom';
export * from './favorites';
export * from './instance';
export * from './workoutOps';
export * from './suggestions';
export * from './references';
