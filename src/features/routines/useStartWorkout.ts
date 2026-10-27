import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { startSession } from '@/db/repo';
import { requestPersistentStorage } from '@/db/db';
import { unlockAudio } from '@/lib/alerts';

export function useStartWorkout() {
  const navigate = useNavigate();
  return async (routineId: string, workoutId: string) => {
    unlockAudio();
    try {
      await startSession(routineId, workoutId);
      void requestPersistentStorage();
      navigate('/treino');
    } catch (e) {
      toast.error('Não foi possível iniciar o treino', { description: (e as Error).message });
    }
  };
}
