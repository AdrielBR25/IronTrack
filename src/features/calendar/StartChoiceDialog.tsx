import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { Routine, Workout } from '@/modules/training';

// Escolha explícita entre o treino planejado e o próximo da rotação (P13, reutilizado na Início no P14). Nada é
// alterado até a escolha; ao concluir, a rotação segue a regra de sempre.

export interface StartChoice {
  routine: Routine;
  planned: Workout;
  next: Workout;
}

export function StartChoiceDialog({ choice, onClose, onStart }: { choice: StartChoice | null; onClose: () => void; onStart: (routineId: string, workoutId: string) => void }) {
  return (
    <Dialog open={!!choice} onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="plan-start-choice">
        <DialogHeader>
          <DialogTitle>Qual treino iniciar?</DialogTitle>
          <DialogDescription>
            O planejado para hoje é o Treino {choice?.planned.label}, mas a rotação indica o Treino {choice?.next.label}. Nada é alterado até você escolher. Ao concluir, a
            rotação segue a regra de sempre (continua a partir do treino realizado), igual a iniciar pela tela Treinos.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="sm:flex-col sm:items-stretch">
          <Button
            onClick={() => {
              const c = choice!;
              onClose();
              onStart(c.routine.id, c.planned.id);
            }}
            data-testid="start-planned"
          >
            Iniciar Treino {choice?.planned.label} (planejado)
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              const c = choice!;
              onClose();
              onStart(c.routine.id, c.next.id);
            }}
            data-testid="start-rotation"
          >
            Iniciar Treino {choice?.next.label} (rotação)
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
