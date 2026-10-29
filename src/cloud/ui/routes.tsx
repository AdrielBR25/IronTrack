// Rotas de conta carregadas sob demanda (só existem com VITE_ACCOUNTS=on).
import { lazy } from 'react';

export const AccountPage = lazy(() => import('./AccountPage'));
export const SyncPage = lazy(() => import('./SyncPage'));
export const ImportPage = lazy(() => import('./ImportPage'));
export const LoginRoute = lazy(() => import('./InAppAuth').then((m) => ({ default: m.LoginRoute })));
export const SignupRoute = lazy(() => import('./InAppAuth').then((m) => ({ default: m.SignupRoute })));
export const ForgotRoute = lazy(() => import('./InAppAuth').then((m) => ({ default: m.ForgotRoute })));
export const ResetRoute = lazy(() => import('./InAppAuth').then((m) => ({ default: m.ResetRoute })));
export const VerifyRoute = lazy(() => import('./InAppAuth').then((m) => ({ default: m.VerifyRoute })));
export const TermsRoute = lazy(() => import('./InAppAuth').then((m) => ({ default: m.TermsRoute })));
