// Modelos do domínio de evolução corporal (avaliações e fotos).
// Formato persistido no IndexedDB e nos backups: não altere campos sem migração.

export interface BodyEntry {
  id: string;
  /** Perfil proprietário. */
  profileId?: string;
  date: string;
  weightKg?: number | null;
  bodyFatPct?: number | null;
  waistCm?: number | null;
  abdomenCm?: number | null;
  armCm?: number | null;
  thighCm?: number | null;
  hipCm?: number | null;
  heightM?: number | null;
  bmi?: number | null;
  fatMassKg?: number | null;
  leanMassKg?: number | null;
  leanPct?: number | null;
  waistHipRatio?: number | null;
  bodyDensity?: number | null;
  skinfoldSumMm?: number | null;
  armMuscleArea?: number | null;
  armFatArea?: number | null;
  /** dobras cutâneas (mm), pelo nome do relatório */
  skinfolds?: Record<string, number>;
  /** outras circunferências (cm) sem campo próprio */
  circumferences?: Record<string, number>;
  source?: 'pdf' | 'manual' | 'json';
  notes?: string;
  createdAt: number;
}

export interface ProgressPhoto {
  id: string;
  /** Perfil proprietário, explícito: fotos órfãs legítimas não ficam sem dono. Deve ser o mesmo da avaliação. */
  profileId?: string;
  entryId: string;
  /** data URL (jpeg comprimido) */
  dataUrl: string;
  createdAt: number;
}
