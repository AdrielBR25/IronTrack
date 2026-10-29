import { ExerciseDetailDialog } from '@/features/library/ExerciseDetailDialog';
import { useLibrary } from '@/hooks/useLibrary';
import type { SessionExercise } from '@/lib/types';
import type { LibraryKey } from '@/modules/exercises';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Link } from 'react-router-dom';
import { MessageCircle } from 'lucide-react';

/**
 * Ajuda do exercício atual durante o treino (P20, docs/IA_ASSISTENTE.md §atalhos): detalhes da biblioteca (músculos,
 * demonstração, instruções) e o atalho para o assistente com a pergunta preenchida. Carregado sob demanda; não grava nada
 * e não interrompe o treino (o cronômetro e o descanso seguem salvos na sessão).
 */
export default function WorkoutHelpSheet({ exercise, onClose }: { exercise: SessionExercise | null; onClose: () => void }) {
  const { data } = useLibrary();
  const key: LibraryKey | null = exercise?.catalogId ? `catalog:${exercise.catalogId}` : exercise?.customExerciseId ? `custom:${exercise.customExerciseId}` : null;
  const item = key ? data?.byKey.get(key) : undefined;
  if (!exercise) return null;
  if (item)
    return <ExerciseDetailDialog item={item} onOpenChange={(o) => !o && onClose()} favorite={data?.favorites.has(item.key) ?? false} onToggleFavorite={() => undefined} hideFavorite askFrom="treino" />;
  // Exercício sem origem na biblioteca (texto livre de fichas antigas) ou biblioteca ainda carregando.
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="workout-help">
        <DialogHeader>
          <DialogTitle className="break-words">{exercise.name}</DialogTitle>
          <DialogDescription>{data ? 'Este exercício não está ligado à biblioteca, então não há demonstração nem instruções do catálogo.' : 'Carregando a biblioteca…'}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Link
            to={`/assistente?exercicio=${encodeURIComponent(exercise.name)}&origem=treino`}
            className="inline-flex h-10 items-center gap-1.5 rounded-xl border px-3 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="detail-ask-assistant"
          >
            <MessageCircle className="h-4 w-4" aria-hidden /> Perguntar ao assistente
          </Link>
          <Button variant="ghost" onClick={onClose}>
            Fechar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
