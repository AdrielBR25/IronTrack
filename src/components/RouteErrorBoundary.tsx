// Fase 07: uma tela que falha ao abrir (erro de renderização ou arquivo de uma versão antiga) não derruba o app
// inteiro: mostra o aviso no lugar da tela, com o menu ainda disponível. Nenhum dado é tocado.
import { Component, type ReactNode } from 'react';
import { AlertTriangle, Home, RefreshCw } from 'lucide-react';
import { isChunkLoadError } from '@/lib/staleChunks';
import { Button } from './ui/button';

interface Props {
  children: ReactNode;
  /** Muda a cada rota: ao navegar para outra tela, o erro anterior é esquecido. */
  resetKey: string;
}
interface State {
  error: unknown;
  key: string;
}

export class RouteErrorBoundary extends Component<Props, State> {
  state: State = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  componentDidCatch(error: unknown) {
    console.error('[IronTrack] falha ao abrir a tela', error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const stale = isChunkLoadError(error);
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    return (
      <div role="alert" className="space-y-4 rounded-2xl border border-border bg-card p-5" data-testid="route-error">
        <div className="flex items-center gap-2 font-semibold">
          <AlertTriangle className="h-5 w-5 text-primary" aria-hidden /> Não foi possível abrir esta tela
        </div>
        <p className="text-sm text-muted-foreground">
          {stale && offline
            ? 'Esta tela ainda não foi baixada para uso offline. Conecte-se à internet e tente de novo.'
            : stale
              ? 'Uma nova versão do IronTrack foi publicada. Recarregue para continuar; seus dados ficam guardados no aparelho.'
              : 'Algo deu errado ao mostrar esta tela. Seus dados não foram alterados. Recarregue ou volte ao Início.'}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => window.location.reload()}>
            <RefreshCw aria-hidden /> Recarregar
          </Button>
          <Button variant="secondary" onClick={() => window.location.assign(`${window.location.pathname}#/`)}>
            <Home aria-hidden /> Ir para o Início
          </Button>
        </div>
      </div>
    );
  }
}
