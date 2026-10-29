// API pública do domínio de evolução corporal: avaliações e medidas antropométricas,
// importação de JSON e de PDF, regiões do mapa corporal e cálculos de evolução.
// Sem React e sem IndexedDB (a leitura do PDF carrega o pdf.js sob demanda).
// A persistência fica em src/db/body.ts e a interface em src/features/body.
// Fora deste diretório, importe sempre por '@/modules/body'.
export type * from './types';
export * from './bodySchema';
export * from './bodyPdf';
export * from './bodyEvolution';
export * from './bodyRegions';
