import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Download } from 'lucide-react';
import { toast } from 'sonner';
import { useRoutines } from '@/hooks/data';
import { baselineRoutineModels, checkModelCapability, readModelSnapshot } from '@/db/modelGuard';
import { acceptRoutineModel, restoreRoutineModel } from '@/db/repo';
import { exportBackup } from '@/lib/backup';
import { detectModelLoss } from '@/modules/training';
import { Button } from '@/components/ui/button';
import { downloadJson } from '@/lib/utils';

// Proteção de compatibilidade visível (P11, docs/CRONOMETROS_E_CONCORRENCIA.md §7–8).
// 1. Detecta rotinas regravadas por um app que não conhece os campos de modalidade (versão antiga em outra aba ou
//    depois de voltar a versão) e oferece devolver os campos perdidos. Nada é restaurado sem confirmação.
// 2. Avisa quando estes dados já foram abertos por um app mais novo (este está desatualizado); a edição de fichas
//    fica bloqueada no editor (useModelCapability).

let capabilityCache: { newer: boolean } | null = null;

/** Este app está desatualizado em relação a quem já usou estes dados? (lido uma vez por carregamento). */
export function useModelCapability(): { newer: boolean } {
  const [cap] = useState(() => (capabilityCache ??= { newer: checkModelCapability().newer }));
  return cap;
}

/** Só para testes: relê a marca de capacidade. */
export function resetModelCapabilityCache() {
  capabilityCache = null;
}

export function CompatGuard() {
  const routines = useRoutines();
  const { newer } = useModelCapability();
  const [busy, setBusy] = useState(false);
  const [rev, setRev] = useState(0);

  useEffect(() => {
    if (routines) baselineRoutineModels(routines);
  }, [routines]);

  const losses = useMemo(() => (routines ? detectModelLoss(readModelSnapshot(), routines) : []), [routines, rev]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!newer && !losses.length) return null;

  const exportNow = async () => {
    const b = await exportBackup();
    downloadJson(`irontrack-backup-${new Date().toISOString().slice(0, 10)}.json`, b);
  };

  return (
    <div className="fixed inset-x-0 top-0 z-50 px-3 pt-safe" role="alert" data-testid="compat-guard">
      <div className="mx-auto mt-2 max-w-3xl space-y-2 rounded-2xl border border-warn bg-card p-3 text-sm shadow-2xl">
        {newer && (
          <p className="flex gap-2" data-testid="compat-newer">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
            <span>
              Estes dados já foram usados por uma versão <strong>mais nova</strong> do IronTrack. Atualize o app (recarregue a página) antes de editar fichas: nesta versão a edição
              de exercícios está bloqueada para não apagar informações que ela não conhece.
            </span>
          </p>
        )}
        {losses.map((l) => (
          <div key={l.routineId} className="space-y-2" data-testid="compat-loss">
            <p className="flex gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
              <span>
                A rotina <strong>{l.routineName}</strong> foi regravada por uma versão antiga do IronTrack, que removeu a classificação (modalidade, lado, tipo de carga ou metas) de{' '}
                {l.exercises.length === 1 ? '1 exercício' : `${l.exercises.length} exercícios`}: {l.exercises.map((e) => e.name).join(', ')}. As séries registradas não foram afetadas.
              </span>
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={busy}
                data-testid="compat-restore"
                onClick={async () => {
                  setBusy(true);
                  try {
                    const ok = await restoreRoutineModel(l);
                    if (ok) toast.success('Classificação restaurada');
                    else toast.warning('A rotina mudou de novo; confira e tente outra vez.');
                  } catch {
                    toast.error('Não foi possível restaurar. Nada foi alterado.');
                  } finally {
                    setBusy(false);
                    setRev((r) => r + 1);
                  }
                }}
              >
                Restaurar classificação
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                data-testid="compat-accept"
                onClick={async () => {
                  await acceptRoutineModel(l.routineId);
                  setRev((r) => r + 1);
                }}
              >
                Manter como está
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void exportNow()}>
                <Download /> Backup
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
