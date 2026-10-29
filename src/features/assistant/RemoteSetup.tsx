// Escolha do modo (simulado × remoto) e conexão com o gateway de IA (IronTrack 2.0 F01/P06).
// O token de acesso é digitado pelo usuário, fica só na memória da página e não é mostrado de novo.
// Conectar busca apenas o catálogo de provedores (nenhum dado pessoal). Nenhum provedor ou modelo
// remoto é escolhido automaticamente.
import { useId, useState } from 'react';
import { Cloud, FlaskConical, Loader2, Plug, Unplug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, NativeSelect } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { AssistantState } from './useAssistant';
import { STATUS_INFO, type AssistantStatus } from './assistantModel';

export function ModeSelector({ a }: { a: AssistantState }) {
  const locked = a.phase === 'running' || a.phase === 'preparing';
  const opt = (value: 'simulated' | 'remote', title: string, desc: string, Icon: typeof Cloud) => (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-3 rounded-xl border p-3 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
        a.mode === value ? 'border-primary bg-primary/10' : 'hover:bg-accent/50',
        locked && 'cursor-not-allowed opacity-60',
      )}
    >
      <input type="radio" name="ai-mode" value={value} checked={a.mode === value} onChange={() => a.setMode(value)} disabled={locked} className="mt-1 h-4 w-4 accent-[hsl(var(--primary))]" data-testid={`mode-${value}`} />
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-sm font-semibold">
          <Icon className="h-4 w-4 shrink-0" aria-hidden /> {title}
        </span>
        <span className="block text-xs text-muted-foreground">{desc}</span>
      </span>
    </label>
  );
  return (
    <fieldset className="grid gap-2 sm:grid-cols-2" data-testid="mode-selector">
      <legend className="mb-1.5 text-sm font-semibold">Modo do assistente</legend>
      {opt('simulated', 'Simulado (padrão)', 'Nenhuma chamada externa. Respostas fictícias geradas no aparelho.', FlaskConical)}
      {opt('remote', 'Remoto via gateway', 'Os dados que você autorizar serão enviados ao gateway e ao provedor escolhido.', Cloud)}
    </fieldset>
  );
}

export function GatewayPanel({ a }: { a: AssistantState }) {
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const id = useId();
  const g = a.gateway;
  const busy = g.status === 'connecting';
  const locked = a.phase === 'running' || a.phase === 'preparing';
  const remote = a.remoteInfo;

  return (
    <Card className="space-y-3 p-3.5" data-testid="gateway-panel">
      {g.status !== 'connected' ? (
        <form
          className="space-y-2"
          aria-label="Conectar gateway de IA"
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await a.connectGateway(url, token);
            // O token só existe na conexão (memória); o campo é limpo.
            if (ok) setToken('');
          }}
        >
          <p className="text-sm font-semibold">Conectar gateway de IA</p>
          <p className="text-xs text-muted-foreground">
            O gateway é um servidor autorizado que guarda as chaves dos provedores. Você recebe o endereço e um token de acesso de quem o administra. O token fica só nesta
            página: some ao sair ou recarregar.
          </p>
          <div className="space-y-1">
            <label htmlFor={`${id}-url`} className="text-xs font-medium text-muted-foreground">
              Endereço do gateway
            </label>
            <Input id={`${id}-url`} inputMode="url" autoComplete="off" spellCheck={false} placeholder="Endereço HTTPS do gateway" value={url} onChange={(e) => setUrl(e.target.value)} disabled={busy || locked} data-testid="gateway-url" />
          </div>
          <div className="space-y-1">
            <label htmlFor={`${id}-token`} className="text-xs font-medium text-muted-foreground">
              Token de acesso
            </label>
            <Input id={`${id}-token`} type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} disabled={busy || locked} data-testid="gateway-token" />
          </div>
          <Button type="submit" className="w-full" disabled={busy || locked || !url.trim() || !token.trim()} data-testid="gateway-connect">
            {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Plug aria-hidden />} {busy ? 'Conectando…' : 'Conectar'}
          </Button>
          <p role="alert" className="text-xs text-destructive" data-testid="gateway-error">
            {g.status === 'error' ? g.error : ''}
          </p>
        </form>
      ) : (
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 text-sm">
              <p className="font-semibold">Gateway conectado</p>
              <p className="break-all text-xs text-muted-foreground" data-testid="gateway-origin">
                {g.origin}
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={a.disconnectGateway} disabled={locked} data-testid="gateway-disconnect">
              <Unplug aria-hidden /> Desconectar
            </Button>
          </div>
          {g.providers.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="gateway-empty">
              Este gateway não oferece nenhum provedor permitido.
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <label htmlFor={`${id}-provider`} className="text-xs font-medium text-muted-foreground">
                  Provedor remoto
                </label>
                <NativeSelect id={`${id}-provider`} value={a.providerId} onChange={(e) => a.setProvider(e.target.value)} disabled={locked} data-testid="ai-provider">
                  <option value="">Escolha um provedor</option>
                  {g.providers.map((p) => (
                    <option key={p.id} value={p.id} disabled={!p.available}>
                      {p.displayName}
                      {p.available ? '' : ' (indisponível: sem chave no gateway)'}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="space-y-1">
                <label htmlFor={`${id}-model`} className="text-xs font-medium text-muted-foreground">
                  Modelo
                </label>
                <NativeSelect id={`${id}-model`} value={a.modelId} onChange={(e) => a.setModel(e.target.value)} disabled={locked || !remote} data-testid="ai-remote-model">
                  <option value="">{remote ? 'Escolha um modelo' : 'Escolha o provedor primeiro'}</option>
                  {a.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            </div>
          )}
          {remote && (
            <p className="text-xs text-muted-foreground" data-testid="remote-destination">
              Destino: {remote.destination}. Escolher um modelo não envia nada: cada pergunta ainda passa pela prévia e pela sua autorização.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- P20: estado e passo a passo

/** Provedores que o gateway do IronTrack sabe chamar (services/ai-gateway, PROVIDER_IDS). Nenhum outro é oferecido. */
export const SUPPORTED_PROVIDERS = [
  { id: 'openai', label: 'OpenAI', api: 'Responses API' },
  { id: 'anthropic', label: 'Anthropic Claude', api: 'Messages API' },
  { id: 'gemini', label: 'Google Gemini', api: 'generateContent' },
] as const;

const STATUS_TONE: Record<AssistantStatus, string> = {
  local: 'border-primary/30 bg-primary/5',
  connected: 'border-primary/40 bg-primary/10',
  unavailable: 'border-border',
  auth_failure: 'border-destructive/50 bg-destructive/10',
  gateway_unreachable: 'border-destructive/50 bg-destructive/10',
  provider_unavailable: 'border-warn/50 bg-warn/10',
};

export function ConnectionStatus({ a }: { a: AssistantState }) {
  const info = STATUS_INFO[a.status];
  return (
    <div className={cn('flex items-start gap-2 rounded-xl border p-2.5 text-sm', STATUS_TONE[a.status])} role="status" data-testid="ai-status" data-status={a.status}>
      <span className={cn('mt-1 h-2.5 w-2.5 shrink-0 rounded-full', a.status === 'connected' || a.status === 'local' ? 'bg-primary' : a.status === 'provider_unavailable' ? 'bg-warn' : a.status === 'unavailable' ? 'bg-muted-foreground' : 'bg-destructive')} aria-hidden />
      <span className="min-w-0">
        <span className="block font-semibold">{info.label}</span>
        <span className="block text-xs text-muted-foreground">{info.text}</span>
      </span>
    </div>
  );
}

/**
 * Passo a passo do modo remoto (P20): modo → provedor → endereço → token → testar → modelo → confirmar → conversar.
 * O provedor é escolhido antes (entre os três que o gateway sabe chamar) e confirmado depois de conectar, quando o
 * gateway diz se ele está configurado lá. Nada é enviado antes da prévia de cada pergunta.
 */
export function SetupSteps({ a, onStart }: { a: AssistantState; onStart: () => void }) {
  const g = a.gateway;
  const connected = g.status === 'connected';
  const steps: { label: string; done: boolean }[] = [
    { label: 'Modo remoto', done: a.mode === 'remote' },
    { label: 'Provedor', done: !!a.providerId || !!a.wantedProvider },
    { label: 'Endereço do gateway', done: connected },
    { label: 'Token de acesso', done: connected },
    { label: 'Testar conexão', done: connected && a.testing !== 'fail' },
    { label: 'Modelo', done: !!a.modelId && !!a.remoteInfo },
    { label: 'Confirmar', done: !!a.modelId && !!a.remoteInfo?.available },
  ];
  const ready = steps.every((s) => s.done);
  const wanted = SUPPORTED_PROVIDERS.find((p) => p.id === a.wantedProvider);
  return (
    <Card className="space-y-3 p-3.5" data-testid="setup-steps">
      <ol className="flex flex-wrap gap-1.5 text-xs" aria-label="Passos da configuração">
        {steps.map((s, i) => (
          <li key={s.label} className={cn('rounded-full border px-2 py-0.5', s.done ? 'border-primary/50 bg-primary/10 text-foreground' : 'text-muted-foreground')} data-done={s.done}>
            {s.done ? '✓' : i + 1} {s.label}
          </li>
        ))}
      </ol>
      {!connected && (
        <fieldset className="space-y-1.5">
          <legend className="text-sm font-semibold">Qual provedor você vai usar?</legend>
          <p className="text-xs text-muted-foreground">Só os provedores que o gateway do IronTrack sabe chamar. A chave do provedor fica no gateway, nunca no app.</p>
          <div className="grid gap-1.5 sm:grid-cols-3">
            {SUPPORTED_PROVIDERS.map((p) => (
              <label key={p.id} className={cn('flex cursor-pointer items-center gap-2 rounded-xl border p-2 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring', a.wantedProvider === p.id && 'border-primary bg-primary/10')}>
                <input type="radio" name="wanted-provider" value={p.id} checked={a.wantedProvider === p.id} onChange={() => a.setWantedProvider(p.id)} className="accent-[hsl(var(--primary))]" data-testid={`wanted-${p.id}`} />
                <span>
                  {p.label} <span className="block text-[11px] text-muted-foreground">{p.api}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {connected && wanted && !g.providers.some((p) => p.id === wanted.id) && (
        <p className="text-xs text-warn" data-testid="wanted-missing">
          Este gateway não oferece {wanted.label}. Escolha um dos provedores que ele oferece abaixo.
        </p>
      )}
      {connected && (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void a.testConnection()} disabled={a.testing === 'testing'} data-testid="gateway-test">
            {a.testing === 'testing' ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Plug aria-hidden />} Testar conexão
          </Button>
          <span className="text-xs text-muted-foreground" role="status" data-testid="gateway-test-result">
            {a.testing === 'ok' ? 'Conexão ok: o gateway respondeu e a lista de provedores foi atualizada.' : a.testing === 'fail' ? 'O teste falhou. Veja o estado acima.' : ''}
          </span>
        </div>
      )}
      {ready && (
        <div className="space-y-2 rounded-xl bg-secondary/60 p-2.5 text-sm" data-testid="setup-confirm">
          <p>
            Pronto: perguntas vão a <strong>{a.remoteInfo?.displayName}</strong> ({a.modelId}) pelo gateway <span className="break-all">{g.origin}</span>, sempre depois da prévia e da sua autorização.
          </p>
          <Button size="sm" onClick={onStart} data-testid="setup-start-chat">
            Começar a conversar
          </Button>
        </div>
      )}
    </Card>
  );
}
