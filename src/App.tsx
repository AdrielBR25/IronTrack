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
import { Suspense, lazy } from 'react';

const WorkoutsPage = lazy(() => import('@/pages/WorkoutsPage'));
const WorkoutEditorPage = lazy(() => import('@/pages/WorkoutEditorPage'));
const HistoryPage = lazy(() => import('@/pages/HistoryPage'));
const SessionDetailPage = lazy(() => import('@/pages/SessionDetailPage'));
// P20: edição de treino finalizado (relógio parado), fora do layout com navegação, como a tela do treino.
const SessionEditPage = lazy(() => import('@/pages/SessionEditPage'));
const ProgressPage = lazy(() => import('@/pages/ProgressPage'));
const TrainingAnalyticsPage = lazy(() => import('@/pages/TrainingAnalyticsPage'));
const TrainingGoalsPage = lazy(() => import('@/pages/TrainingGoalsPage'));
const WeeklyPlannerPage = lazy(() => import('@/pages/WeeklyPlannerPage'));
const LegacyImportPage = lazy(() => import('@/pages/LegacyImportPage'));
const SettingsPage = lazy(() => import('@/pages/SettingsPage'));
const AIAssistantPage = lazy(() => import('@/pages/AIAssistantPage'));
// P17: biblioteca de exercícios sob demanda (o catálogo só é baixado com esta tela; depois fica no cache do PWA).
const ExerciseLibraryPage = lazy(() => import('@/pages/ExerciseLibraryPage'));
const ExerciseRecognitionPage = lazy(() => import('@/pages/ExerciseRecognitionPage'));
const BulkReplacePage = lazy(() => import('@/pages/BulkReplacePage'));
// P19: desempenho por exercício (recordes, gráficos e comparações), carregado sob demanda.
const PerformancePage = lazy(() => import('@/pages/PerformancePage'));
const ExercisePerformancePage = lazy(() => import('@/pages/ExercisePerformancePage'));
import { useSettings } from '@/hooks/data';
// P21: contas e sincronização (só com VITE_ACCOUNTS=on; sem isso as rotas nem existem).
import { ACCOUNTS_ENABLED, accountModeActive } from '@/cloud/config';
import * as Cloud from '@/cloud/ui/routes';
// Fase 01: RPG de desenvolvimento pessoal (modo conta).
const LifeHomePage = lazy(() => import('@/cloud/life/LifeHomePage'));
const MissionsPage = lazy(() => import('@/cloud/life/MissionsPage'));
const JourneyPage = lazy(() => import('@/cloud/life/JourneyPage'));
const MorePage = lazy(() => import('@/cloud/life/MorePage'));

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
        <Route
          path="/historico/:id/editar"
          element={
            <Suspense fallback={null}>
              <SessionEditPage />
            </Suspense>
          }
        />
        <Route element={<AppLayout />}>
          {/* Fase 01: no modo conta o Início é o painel do RPG; o painel de treino de antes fica em #/treinar. */}
          <Route path="/" element={accountModeActive() ? <LifeHomePage /> : <HomePage />} />
          <Route path="/treinar" element={<HomePage />} />
          <Route path="/treinos" element={<WorkoutsPage />} />
          <Route path="/treinos/:routineId/:workoutId" element={<WorkoutEditorPage />} />
          <Route path="/treinos/:routineId/:workoutId/substituir" element={<BulkReplacePage />} />
          <Route path="/exercicios" element={<ExerciseLibraryPage />} />
          <Route path="/exercicios/reconhecer" element={<ExerciseRecognitionPage />} />
          <Route path="/historico" element={<HistoryPage />} />
          <Route path="/historico/:id" element={<SessionDetailPage />} />
          <Route path="/evolucao" element={<ProgressPage />} />
          <Route path="/evolucao/desempenho" element={<TrainingAnalyticsPage />} />
          <Route path="/desempenho" element={<PerformancePage />} />
          <Route path="/desempenho/exercicio/:identidade" element={<ExercisePerformancePage />} />
          <Route path="/metas" element={<TrainingGoalsPage />} />
          <Route path="/planejamento" element={<WeeklyPlannerPage />} />
          <Route path="/planejamento/importar" element={<LegacyImportPage />} />
          {/* Fase 00: no modo conta, o assistente é o chat central da conta (OpenAI pelo servidor); sem conta, o de antes. */}
          <Route path="/assistente" element={accountModeActive() ? <Cloud.AssistantChatPage /> : <AIAssistantPage />} />
          <Route path="/config" element={<SettingsPage />} />
          {ACCOUNTS_ENABLED && (
            <>
              <Route path="/conta" element={<Cloud.AccountPage />} />
              <Route path="/conta/sincronizacao" element={<Cloud.SyncPage />} />
              <Route path="/conta/importar" element={<Cloud.ImportPage />} />
              <Route path="/conta/entrar" element={<Cloud.LoginRoute />} />
              <Route path="/conta/criar" element={<Cloud.SignupRoute />} />
              <Route path="/conta/esqueci" element={<Cloud.ForgotRoute />} />
              <Route path="/conta/redefinir-senha" element={<Cloud.ResetRoute />} />
              <Route path="/conta/verificar-email" element={<Cloud.VerifyRoute />} />
              <Route path="/conta/termos" element={<Cloud.TermsRoute />} />
              <Route path="/assistente/privacidade" element={<Cloud.AssistantPrivacyPage />} />
              <Route path="/assistente/classico" element={<AIAssistantPage />} />
              <Route path="/missoes" element={<MissionsPage />} />
              <Route path="/jornada" element={<JourneyPage />} />
              <Route path="/mais" element={<MorePage />} />
            </>
          )}
          <Route path="*" element={<HomePage />} />
        </Route>
      </Routes>
      <UpdatePrompt />
      <CompatGuard />
      <Toaster position="top-center" theme={dark ? 'dark' : 'light'} richColors closeButton toastOptions={{ className: 'rounded-2xl' }} />
    </HashRouter>
  );
}
