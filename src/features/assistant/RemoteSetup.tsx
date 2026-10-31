// Escolha do modo (simulado × remoto) e conexão com o gateway de IA (IronTrack 2.0 F01/P06).
// O token de acesso é digitado pelo usuário, fica só na memória da página e não é mostrado de novo.
// Conectar busca apenas o catálogo de provedores (nenhum dado pessoal). Nenhum provedor ou modelo
// remoto é escolhido automaticamente.
// Ajuste do P20: fluxo Provedor → Obter chave / token → Conectar → Modelo → Conversar, sem digitar host. O endereço do
// servidor seguro (gateway) é resolvido sozinho e só aparece nas configurações avançadas, recolhidas.
import { useEffect, useId, useState } from 'react';
import { ClipboardPaste, Cloud, ExternalLink, Eye, EyeOff, FlaskConical, KeyRound, Loader2, Plug, Server, Unplug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, NativeSelect } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { AssistantState } from './useAssistant';
import { STATUS_INFO, providerHealthInfo, testResultText, type AssistantStatus } from './assistantModel';
import { NO_GATEWAY_MESSAGE } from './useAssistant';
import { PROVIDER_PRESETS, isOfficialKeysUrl, presetById, providerKeyKind, type ProviderPreset } from '@/integrations/ai/providerPresets';
import { forgetGatewayOrigin, saveGatewayOrigin } from '@/integrations/ai/gatewayEndpoint';
import { isAccessTokenFormat } from '@/integrations/ai/gatewayValidation';

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
      {a.accountMode
        ? opt('remote', 'IA real pela conta', 'Os dados que você autorizar vão ao servidor do IronTrack (sua conta) e ao provedor escolhido.', Cloud)
        : opt('remote', 'Remoto via gateway', 'Os dados que você autorizar vão ao servidor seguro do IronTrack e ao provedor escolhido.', Cloud)}
    </fieldset>
  );
}

// ---------------------------------------------------------------- P20: estado e passo a passo

const STATUS_TONE: Record<AssistantStatus, string> = {
  local: 'border-primary/30 bg-primary/5',
  connected: 'border-primary/40 bg-primary/10',
  no_gateway: 'border-warn/50 bg-warn/10',
  unavailable: 'border-border',
  auth_failure: 'border-destructive/50 bg-destructive/10',
  gateway_unreachable: 'border-destructive/50 bg-destructive/10',
  provider_unavailable: 'border-warn/50 bg-warn/10',
  email_unverified: 'border-warn/50 bg-warn/10',
};

const HEALTH_TONE = {
  ok: { box: 'border-primary/40 bg-primary/10', dot: 'bg-primary' },
  neutral: { box: 'border-border bg-secondary/40', dot: 'bg-muted-foreground' },
  warn: { box: 'border-warn/50 bg-warn/10', dot: 'bg-warn' },
  bad: { box: 'border-destructive/50 bg-destructive/10', dot: 'bg-destructive' },
} as const;

export function ConnectionStatus({ a }: { a: AssistantState }) {
  // Hotfix 21.2: na IA pela conta, o estado do provedor (confirmado pelo provedor) vale mais que "servidor no ar".
  const health = a.remoteInfo?.status && (a.status === 'connected' || a.status === 'provider_unavailable') ? a.remoteInfo.status : undefined;
  if (health && a.remoteInfo) {
    const h = providerHealthInfo(health, a.remoteInfo.displayName);
    return (
      <div className={cn('flex items-start gap-2 rounded-xl border p-2.5 text-sm', HEALTH_TONE[h.tone].box)} role="status" data-testid="ai-status" data-status={a.status} data-health={health}>
        <span className={cn('mt-1 h-2.5 w-2.5 shrink-0 rounded-full', HEALTH_TONE[h.tone].dot)} aria-hidden />
        <span className="min-w-0">
          <span className="block font-semibold">{h.label}</span>
          <span className="block text-xs text-muted-foreground">{h.text}</span>
        </span>
      </div>
    );
  }
  const info = STATUS_INFO[a.status];
  return (
    <div className={cn('flex items-start gap-2 rounded-xl border p-2.5 text-sm', STATUS_TONE[a.status])} role="status" data-testid="ai-status" data-status={a.status}>
      <span className={cn('mt-1 h-2.5 w-2.5 shrink-0 rounded-full', a.status === 'connected' || a.status === 'local' ? 'bg-primary' : a.status === 'provider_unavailable' || a.status === 'no_gateway' || a.status === 'email_unverified' ? 'bg-warn' : a.status === 'unavailable' ? 'bg-muted-foreground' : 'bg-destructive')} aria-hidden />
      <span className="min-w-0">
        <span className="block font-semibold">{info.label}</span>
        <span className="block text-xs text-muted-foreground">{info.text}</span>
      </span>
    </div>
  );
}


// ---------------------------------------------------------------- Ajuste P20: conexão simplificada

/** Validação do token ANTES de qualquer rede. Reconhece chave de provedor colada no lugar errado. */
export function checkAccessToken(raw: string): { ok: true; token: string } | { ok: false; error: string; providerKey?: boolean } {
  const t = typeof raw === 'string' ? raw.trim() : '';
  if (!t) return { ok: false, error: 'Cole o token de acesso ao servidor seguro do IronTrack.' };
  const kind = providerKeyKind(t);
  if (kind)
    return {
      ok: false,
      providerKey: true,
      error: `Isto parece uma chave de API ${kind === 'Google Gemini' ? 'do Google Gemini' : `da ${kind}`}, não o token do servidor. Chaves de provedor não são coladas no app: ficam no servidor seguro do IronTrack. O campo foi limpo.`,
    };
  if (!isAccessTokenFormat(t)) return { ok: false, error: 'Formato inválido: o token do servidor tem 43 ou mais caracteres (letras, números, "-" e "_"), sem espaços.' };
  return { ok: true, token: t };
}

/** Botão "Obter chave de API": link direto e fixo para a página oficial (nova aba, sem referer, sem parâmetros). */
function GetKeyLink({ preset }: { preset: ProviderPreset }) {
  if (!isOfficialKeysUrl(preset.keysUrl)) return null;
  return (
    <a
      href={preset.keysUrl}
      target="_blank"
      rel="noopener noreferrer"
      referrerPolicy="no-referrer"
      className="inline-flex h-10 items-center justify-center gap-1.5 rounded-xl border border-primary/50 bg-primary/10 px-3 text-sm font-semibold hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="get-api-key"
    >
      <KeyRound className="h-4 w-4" aria-hidden /> Obter chave de API <ExternalLink className="h-3.5 w-3.5" aria-hidden />
    </a>
  );
}

function ProviderPicker({ a, locked }: { a: AssistantState; locked: boolean }) {
  return (
    <fieldset className="space-y-1.5" disabled={locked}>
      <legend className="text-sm font-semibold">1. Provedor</legend>
      <div className="grid gap-1.5 sm:grid-cols-3">
        {PROVIDER_PRESETS.map((p) => (
          <label
            key={p.id}
            className={cn(
              'flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border p-2.5 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
              a.wantedProvider === p.id ? 'border-primary bg-primary/10 font-semibold' : 'hover:bg-accent/50',
            )}
          >
            <input type="radio" name="ai-provider-preset" value={p.id} checked={a.wantedProvider === p.id} onChange={() => a.chooseProvider(p.id)} className="h-4 w-4 accent-[hsl(var(--primary))]" data-testid={`provider-${p.id}`} />
            {p.name}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Situação do provedor escolhido no servidor conectado. */
function providerOnServer(a: AssistantState, id: string): 'not_connected' | 'missing' | 'no_key' | 'ready' {
  if (a.gateway.status !== 'connected') return 'not_connected';
  const p = a.gateway.providers.find((x) => x.id === id);
  if (!p) return 'missing';
  return p.available ? 'ready' : 'no_key';
}

function SelectedProvider({ a, preset }: { a: AssistantState; preset: ProviderPreset }) {
  const where = providerOnServer(a, preset.id);
  return (
    <div className="space-y-2 rounded-xl border bg-secondary/40 p-3" data-testid="selected-provider" data-provider={preset.id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold">{preset.name}</p>
        <GetKeyLink preset={preset} />
      </div>
      <details className="text-xs text-muted-foreground" data-testid="key-instructions">
        <summary className="cursor-pointer select-none font-medium text-foreground">Como gerar e onde colocar a chave</summary>
        <ol className="mt-1.5 list-decimal space-y-0.5 pl-5">
          {preset.steps.map((t) => (
            <li key={t}>{t}</li>
          ))}
          <li>
            Entregue a chave a quem administra o servidor seguro do IronTrack (ou configure-a você, se for o seu servidor) na variável{' '}
            <code className="break-all">{preset.gatewayKeyEnv}</code>.
          </li>
        </ol>
        <p className="mt-1.5">
          <strong className="text-foreground">Não cole a chave do provedor neste app.</strong> O IronTrack não recebe nem guarda chaves de provedor: elas ficam só no
          servidor. Aqui você informa apenas o token de acesso ao servidor.
        </p>
      </details>
      {where === 'missing' && (
        <p className="text-xs text-warn" data-testid="provider-missing">
          O servidor conectado não oferece {preset.name}. Escolha outro provedor ou peça para habilitá-lo no servidor.
        </p>
      )}
      {where === 'no_key' && (
        <p className="text-xs text-warn" data-testid="provider-no-key">
          {preset.name} ainda não tem chave no servidor. Gere a chave em “Obter chave de API” e configure-a no servidor ({preset.gatewayKeyEnv}); depois toque em Testar conexão.
        </p>
      )}
    </div>
  );
}

function TokenField({ a, disabled }: { a: AssistantState; disabled: boolean }) {
  const id = useId();
  const [token, setToken] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const busy = a.gateway.status === 'connecting';
  const noProvider = !a.wantedProvider;
  const submit = async () => {
    const c = checkAccessToken(token);
    if (!c.ok) {
      setError(c.error);
      if (c.providerKey) setToken('');
      return;
    }
    setError('');
    const ok = await a.connectGateway(c.token);
    // O token só existe na conexão (memória); o campo é limpo.
    if (ok) {
      setToken('');
      setShow(false);
    }
  };
  const paste = async () => {
    try {
      const t = await navigator.clipboard.readText();
      setToken(t.trim());
      setError('');
    } catch {
      setError('Não foi possível ler a área de transferência. Toque no campo e cole manualmente.');
    }
  };
  const shownError = error || (a.gateway.status === 'error' ? (a.gateway.error ?? '') : '');
  return (
    <form
      className="space-y-2"
      aria-label="Conectar ao servidor seguro"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="space-y-1">
        <label htmlFor={`${id}-token`} className="text-sm font-semibold">
          2. Token de acesso ao servidor do IronTrack
        </label>
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          É o token que o servidor seguro emitiu para você (43+ caracteres). <strong className="text-foreground">Não é a chave de API do provedor</strong>: as duas não são
          intercambiáveis. Fica só na memória desta sessão e some ao recarregar.
        </p>
        <div className="flex gap-1.5">
          <Input
            id={`${id}-token`}
            type={show ? 'text' : 'password'}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              setError('');
            }}
            disabled={busy || disabled}
            aria-invalid={!!shownError}
            aria-describedby={`${id}-hint ${id}-err`}
            className="min-w-0 flex-1"
            data-testid="gateway-token"
          />
          <Button type="button" variant="outline" size="icon" className="h-11 w-11 shrink-0" onClick={() => setShow((v) => !v)} disabled={busy || disabled} aria-label={show ? 'Ocultar token' : 'Mostrar token'} aria-pressed={show} data-testid="gateway-token-toggle">
            {show ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
          </Button>
          <Button type="button" variant="outline" size="icon" className="h-11 w-11 shrink-0" onClick={() => void paste()} disabled={busy || disabled} aria-label="Colar token" data-testid="gateway-token-paste">
            <ClipboardPaste aria-hidden />
          </Button>
        </div>
      </div>
      {busy ? (
        <div className="flex gap-2">
          <Button type="button" className="flex-1" disabled>
            <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> Conectando…
          </Button>
          <Button type="button" variant="outline" onClick={a.cancelConnect} data-testid="gateway-cancel">
            Cancelar
          </Button>
        </div>
      ) : (
        <Button type="submit" className="w-full" disabled={disabled || noProvider} data-testid="gateway-connect">
          <Plug aria-hidden /> {noProvider ? 'Escolha o provedor primeiro' : 'Conectar'}
        </Button>
      )}
      <p id={`${id}-err`} role="alert" className="text-xs text-destructive" data-testid="gateway-error">
        {shownError}
      </p>
    </form>
  );
}

function ConnectedPanel({ a, preset, onStart, locked }: { a: AssistantState; preset: ProviderPreset | undefined; onStart: () => void; locked: boolean }) {
  const id = useId();
  const info = a.remoteInfo;
  // Na IA pela conta o provedor vem do catálogo do servidor (não dos atalhos do gateway P20).
  const where = a.accountMode ? (info ? (info.available ? 'ready' : 'no_key') : 'missing') : preset ? providerOnServer(a, preset.id) : 'missing';
  const modelUnavailable = info?.modelStatus?.[a.modelId] === 'unavailable';
  const ready = !!info?.available && !!a.modelId && !modelUnavailable;
  const health = a.accountMode && info?.status ? providerHealthInfo(info.status, info.displayName) : null;
  const modelName = (id: string) => a.models.find((m) => m.id === id)?.displayName ?? id;
  const testText = a.testing === 'testing' ? '' : a.testResult && info ? testResultText(a.testResult, info.displayName, modelName(a.testResult.modelId)) : a.testError ? a.testError : a.testing === 'ok' ? 'Conexão ok: o servidor respondeu e a lista de modelos foi atualizada.' : a.testing === 'fail' ? 'O teste falhou. Veja o estado acima.' : '';
  return (
    <div className="space-y-3" data-testid="gateway-connected">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-semibold">
          <span className="h-2 w-2 rounded-full bg-primary" aria-hidden /> {a.accountMode ? 'Conectado ao servidor do IronTrack' : 'Conectado ao servidor seguro'}
        </p>
        <div className="flex gap-1.5">
          <Button variant="outline" size="sm" onClick={() => void a.testConnection()} disabled={a.testing === 'testing' || locked} data-testid="gateway-test">
            {a.testing === 'testing' ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Plug aria-hidden />} Testar
          </Button>
          <Button variant="outline" size="sm" onClick={a.disconnectGateway} disabled={locked} data-testid="gateway-disconnect">
            <Unplug aria-hidden /> Desconectar
          </Button>
        </div>
      </div>
      {health && info && (
        <p className="text-xs" data-testid="provider-health" data-health={info.status}>
          <span className="font-semibold">{health.label}.</span>{' '}
          {info.checkedAt && info.status !== 'unverified' && <span className="text-muted-foreground">Última confirmação do provedor: {new Date(info.checkedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}.</span>}
        </p>
      )}
      <p className={cn('text-xs', a.testing === 'fail' ? 'text-warn' : 'text-muted-foreground')} role="status" data-testid="gateway-test-result" data-result={a.testResult?.result ?? ''}>
        {testText}
      </p>
      <div className="space-y-1">
        <label htmlFor={`${id}-model`} className="text-sm font-semibold">
          3. Modelo
        </label>
        <NativeSelect id={`${id}-model`} value={a.modelId} onChange={(e) => a.setModel(e.target.value)} disabled={locked || where !== 'ready'} data-testid="ai-remote-model">
          <option value="">{where === 'ready' ? 'Escolha um modelo' : where === 'no_key' ? (health ? `Indisponível: ${health.label}` : 'Indisponível: sem chave no servidor') : 'Nenhum modelo disponível'}</option>
          {where === 'ready' &&
            a.models.map((m) => {
              const off = info?.modelStatus?.[m.id] === 'unavailable';
              return (
                <option key={m.id} value={m.id} disabled={off}>
                  {m.displayName}
                  {off ? ' (indisponível para a chave do servidor)' : ''}
                </option>
              );
            })}
        </NativeSelect>
        <p className="text-xs text-muted-foreground">Só aparecem os modelos que o servidor libera para este provedor.</p>
        {modelUnavailable && (
          <p className="text-xs text-warn" data-testid="model-unavailable">
            Este modelo não existe ou não está liberado para a chave do servidor. Escolha outro modelo.
          </p>
        )}
      </div>
      {ready && info && (
        <div className="space-y-2 rounded-xl bg-secondary/60 p-2.5 text-sm" data-testid="setup-confirm">
          <p>
            Pronto: perguntas vão a <strong>{info.displayName}</strong> pelo servidor seguro, sempre depois da prévia e da sua autorização.
          </p>
          <Button size="sm" onClick={onStart} data-testid="setup-start-chat">
            Começar a conversar
          </Button>
        </div>
      )}
    </div>
  );
}

/** Configurações avançadas (recolhidas): endereço do servidor seguro deste aparelho. */
function AdvancedGateway({ a, open, onToggle, locked }: { a: AssistantState; open: boolean; onToggle: (v: boolean) => void; locked: boolean }) {
  const id = useId();
  const ep = a.endpoint;
  const [url, setUrl] = useState(ep?.source === 'device' ? ep.origin : '');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (ep?.source === 'device') setUrl(ep.origin);
  }, [ep?.source, ep?.origin]);
  const preset = presetById(a.wantedProvider);
  return (
    <details className="rounded-xl border" open={open} onToggle={(e) => onToggle(e.currentTarget.open)} data-testid="gateway-advanced">
      <summary className="flex min-h-11 cursor-pointer select-none items-center gap-2 px-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
        <Server className="h-4 w-4 shrink-0" aria-hidden /> Configurações avançadas
      </summary>
      <div className="space-y-2 border-t p-3 text-xs">
        <p className="text-muted-foreground">
          Servidor em uso:{' '}
          <span className="break-all font-medium text-foreground" data-testid="gateway-origin">
            {ep ? ep.origin : 'nenhum'}
          </span>
          {ep && <> ({ep.source === 'device' ? 'definido neste aparelho' : 'configuração do app'})</>}
        </p>
        <form
          className="space-y-1.5"
          aria-label="Endereço do servidor seguro"
          onSubmit={(e) => {
            e.preventDefault();
            const c = saveGatewayOrigin(url);
            if (!c.ok) return setMsg({ ok: false, text: c.error });
            setUrl(c.origin);
            if (a.gateway.status !== 'disconnected' && a.gateway.origin !== c.origin) a.disconnectGateway();
            setMsg({ ok: true, text: 'Endereço salvo neste aparelho. Agora conecte com o token.' });
          }}
        >
          <label htmlFor={`${id}-url`} className="font-medium">
            Endereço do servidor seguro do IronTrack (gateway)
          </label>
          <p className="text-muted-foreground">
            Endereço completo em HTTPS, só a origem (sem caminho). Não é o endereço da OpenAI, Anthropic ou Google: o app nunca chama o provedor diretamente. Só o endereço
            fica salvo neste aparelho; token e chaves nunca.
          </p>
          <Input id={`${id}-url`} inputMode="url" autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder="Endereço HTTPS do servidor" value={url} onChange={(e) => setUrl(e.target.value)} disabled={locked} data-testid="gateway-url" />
          <div className="flex flex-wrap gap-1.5">
            <Button type="submit" size="sm" disabled={locked || !url.trim()} data-testid="gateway-url-save">
              Salvar endereço
            </Button>
            {ep?.source === 'device' && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={locked}
                onClick={() => {
                  forgetGatewayOrigin();
                  setUrl('');
                  if (a.gateway.status !== 'disconnected') a.disconnectGateway();
                  setMsg({ ok: true, text: 'Endereço esquecido neste aparelho.' });
                }}
                data-testid="gateway-url-forget"
              >
                Esquecer endereço
              </Button>
            )}
          </div>
          <p role="status" className={msg?.ok ? 'text-muted-foreground' : 'text-destructive'} data-testid="gateway-url-message">
            {msg?.text ?? ''}
          </p>
        </form>
        {a.remoteInfo && (
          <p className="text-muted-foreground" data-testid="remote-destination">
            Destino das perguntas: <span className="break-all">{a.remoteInfo.destination}</span>
          </p>
        )}
        {preset && (
          <p className="text-muted-foreground" data-testid="provider-api">
            API oficial de {preset.name} (chamada só pelo servidor): <span className="break-all">{preset.apiBase}</span>
          </p>
        )}
      </div>
    </details>
  );
}

/** P21: provedores que o servidor da conta habilitou (só esses aparecem). */
function AccountProviderPicker({ a, locked }: { a: AssistantState; locked: boolean }) {
  const offered = a.gateway.providers;
  if (!offered.length) return <p className="text-sm text-warn" data-testid="account-no-providers">Nenhum provedor de IA está habilitado no servidor no momento.</p>;
  return (
    <fieldset className="space-y-1.5" disabled={locked}>
      <legend className="text-sm font-semibold">Provedor</legend>
      <div className="grid gap-1.5 sm:grid-cols-3">
        {offered.map((p) => (
          <label
            key={p.id}
            className={cn(
              'flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border p-2.5 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
              a.wantedProvider === p.id ? 'border-primary bg-primary/10 font-semibold' : 'hover:bg-accent/50',
              !p.available && 'opacity-60',
            )}
          >
            <input type="radio" name="ai-provider-account" value={p.id} checked={a.wantedProvider === p.id} onChange={() => a.chooseProvider(p.id)} className="h-4 w-4 accent-[hsl(var(--primary))]" data-testid={`provider-${p.id}`} />
            <span>
              {p.displayName}
              {p.status ? (
                <span className="block text-xs font-normal text-muted-foreground" data-testid={`provider-health-${p.id}`}>
                  {PROVIDER_SHORT[p.status]}
                </span>
              ) : (
                !p.available && <span className="block text-xs font-normal text-muted-foreground">indisponível no momento</span>
              )}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Hotfix 21.2: estado curto do provedor na lista (o texto completo fica no quadro de estado). */
const PROVIDER_SHORT: Record<NonNullable<AssistantState['gateway']['providers'][number]['status']>, string> = {
  ok: 'disponível',
  unverified: 'chave configurada, ainda não testada',
  missing_key: 'indisponível: sem chave no servidor',
  invalid_key_format: 'indisponível: chave com formato inválido',
  auth_failed: 'indisponível: chave recusada',
  forbidden: 'chave sem permissão',
  billing: 'créditos ou faturamento',
  rate_limited: 'limite de uso atingido',
  network: 'falha de rede ao contatar',
};

/** P21: ajuda para quem administra o servidor: links oficiais das chaves e onde elas ficam (variáveis da Railway). */
function AdminKeysHelp() {
  return (
    <details className="rounded-xl border text-xs" data-testid="admin-keys-help">
      <summary className="flex min-h-11 cursor-pointer select-none items-center gap-2 px-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
        <Server className="h-4 w-4 shrink-0" aria-hidden /> Administração: chaves dos provedores
      </summary>
      <div className="space-y-2 border-t p-3">
        <p className="text-muted-foreground">
          As chaves ficam só no servidor (variáveis de ambiente da Railway), nunca neste app. Quem administra o servidor gera a chave na página oficial e a configura na variável
          indicada. Usuários comuns não precisam de chave.
        </p>
        <ul className="space-y-2">
          {PROVIDER_PRESETS.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {p.name}: <code className="break-all">{ADMIN_KEY_ENV[p.id] ?? p.gatewayKeyEnv}</code>
              </span>
              <GetKeyLink preset={p} />
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

/** Variáveis das chaves na API da conta (Railway). */
const ADMIN_KEY_ENV: Record<string, string> = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY' };

/** P21: modo conta — Conectar com sua conta → Provedor → Modelo → Conversar. Sem token, sem endereço. */
function AccountConnect({ a, onStart }: { a: AssistantState; onStart: () => void }) {
  const locked = a.phase === 'running' || a.phase === 'preparing';
  const connected = a.gateway.status === 'connected';
  const preset = presetById(a.wantedProvider);
  const busy = a.gateway.status === 'connecting';
  return (
    <Card className="space-y-3 p-3.5" data-testid="account-ai-panel">
      {!connected && (
        <div className="space-y-2">
          <p className="text-sm">
            Use a IA pela sua conta do IronTrack: as chaves dos provedores ficam no servidor e o consumo é controlado por conta. Nada é enviado sem a prévia e a sua autorização.
          </p>
          <Button className="w-full" onClick={() => void a.connectAccount()} disabled={busy || locked} data-testid="connect-account">
            {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Plug aria-hidden />} Conectar com sua conta
          </Button>
          <p role="alert" className="text-xs text-destructive" data-testid="gateway-error">
            {a.gateway.status === 'error' ? (a.gateway.error ?? '') : ''}
          </p>
        </div>
      )}
      {connected && (
        <>
          <AccountProviderPicker a={a} locked={locked} />
          <ConnectedPanel a={a} preset={preset} onStart={onStart} locked={locked} />
        </>
      )}
      <AdminKeysHelp />
    </Card>
  );
}

/** Modo remoto, ajuste do P20: Provedor → Obter chave ou autenticar → Conectar → Modelo → Conversar. */
export function RemoteConnect({ a, onStart }: { a: AssistantState; onStart: () => void }) {
  if (a.accountMode) return <AccountConnect a={a} onStart={onStart} />;
  return <GatewayConnect a={a} onStart={onStart} />;
}

function GatewayConnect({ a, onStart }: { a: AssistantState; onStart: () => void }) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const locked = a.phase === 'running' || a.phase === 'preparing';
  const preset = presetById(a.wantedProvider);
  const connected = a.gateway.status === 'connected';
  return (
    <Card className="space-y-3 p-3.5" data-testid="gateway-panel">
      <ProviderPicker a={a} locked={locked || a.gateway.status === 'connecting'} />
      {preset && <SelectedProvider a={a} preset={preset} />}
      {!a.endpoint && !connected && (
        <div className="space-y-2 rounded-xl border border-warn/50 bg-warn/10 p-3 text-sm" role="note" data-testid="no-gateway">
          <p className="font-semibold">{NO_GATEWAY_MESSAGE}</p>
          <p className="text-xs text-muted-foreground">
            O servidor seguro guarda as chaves dos provedores e repassa as perguntas autorizadas. Ainda não há um servidor publicado para este app; se você tem um,
            informe o endereço nas configurações avançadas. Enquanto isso, o modo local continua funcionando.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => setAdvancedOpen(true)} data-testid="open-advanced">
            Configurar servidor
          </Button>
        </div>
      )}
      {connected ? <ConnectedPanel a={a} preset={preset} onStart={onStart} locked={locked} /> : <TokenField a={a} disabled={locked || !a.endpoint} />}
      <AdvancedGateway a={a} open={advancedOpen} onToggle={setAdvancedOpen} locked={locked} />
    </Card>
  );
}
