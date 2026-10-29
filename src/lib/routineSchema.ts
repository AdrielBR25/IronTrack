/** @deprecated Caminho de compatibilidade (IronTrack 2.0 F01/P03). Use '@/modules/training' e '@/lib/validation'. */
export * from '@/modules/training/routineSchema';
// Antes da modularização os auxiliares genéricos de validação moravam aqui. `formatZodError`
// mantém o resultado de antes (rótulos da ficha); o genérico está em '@/lib/validation'.
export { formatFichaErrors as formatZodError } from '@/modules/training/routineSchema';
export { parseJsonText, type ParseResult } from '@/lib/validation';
