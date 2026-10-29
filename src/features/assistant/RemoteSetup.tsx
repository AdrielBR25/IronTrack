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
