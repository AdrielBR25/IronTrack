// API pública do domínio de treinamento: rotinas e fichas, exercícios, séries, sessões,
// histórico, rotação ABC, progressão de carga, descanso e métricas de treino.
// Funções puras e determinísticas: sem React, sem IndexedDB, sem rede. A persistência
// fica em src/db (repo.ts) e a interface em src/pages e src/features.
// Fora deste diretório, importe sempre por '@/modules/training'.
export type * from './types';
export * from './equipment';
export * from './exerciseModel';
export * from './routineSchema';
export * from './session';
export * from './rotation';
export * from './progression';
export * from './volume';
export * from './stats';
export * from './restTimer';
export * from './setTimer';
export * from './sessionMerge';
export * from './modelCompat';
