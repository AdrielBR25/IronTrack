import { HashRouter, Route, Routes } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AppLayout } from '@/components/AppLayout';
import { ThemeSync } from '@/components/ThemeSync';
import { UpdatePrompt } from '@/components/UpdatePrompt';
import { RestWatcher } from '@/features/workout/RestWatcher';
import { SetTimerWatcher } from '@/features/workout/SetTimerWatcher';
import { CompatGuard } from '@/features/compat/CompatGuard';
import HomePage from '@/pages/HomePage';
import ActiveWorkoutPage from '@/pages/ActiveWorkoutPage';
import { lazy } from 'react';

const WorkoutsPage = lazy(() => import('@/pages/WorkoutsPage'));
const WorkoutEditorPage = lazy(() => import('@/pages/WorkoutEditorPage'));
const HistoryPage = lazy(() => import('@/pages/HistoryPage'));
const SessionDetailPage = lazy(() => import('@/pages/SessionDetailPage'));
const ProgressPage = lazy(() => import('@/pages/ProgressPage'));
const TrainingAnalyticsPage = lazy(() => import('@/pages/TrainingAnalyticsPage'));
const SettingsPage = lazy(() => import('@/pages/SettingsPage'));
const AIAssistantPage = lazy(() => import('@/pages/AIAssistantPage'));
import { useSettings } from '@/hooks/data';

export default function App() {
  const settings = useSettings();
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  return (
    <HashRouter>
      <ThemeSync />
      <RestWatcher />
      <SetTimerWatcher />
      <Routes>
        <Route path="/treino" element={<ActiveWorkoutPage />} />
        <Route element={<AppLayout />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/treinos" element={<WorkoutsPage />} />
          <Route path="/treinos/:routineId/:workoutId" element={<WorkoutEditorPage />} />
          <Route path="/historico" element={<HistoryPage />} />
          <Route path="/historico/:id" element={<SessionDetailPage />} />
          <Route path="/evolucao" element={<ProgressPage />} />
          <Route path="/evolucao/desempenho" element={<TrainingAnalyticsPage />} />
          <Route path="/assistente" element={<AIAssistantPage />} />
          <Route path="/config" element={<SettingsPage />} />
          <Route path="*" element={<HomePage />} />
        </Route>
      </Routes>
      <UpdatePrompt />
      <CompatGuard />
      <Toaster position="top-center" theme={dark ? 'dark' : 'light'} richColors closeButton toastOptions={{ className: 'rounded-2xl' }} />
    </HashRouter>
  );
}
