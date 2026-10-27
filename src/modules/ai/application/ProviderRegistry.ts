// Registro de provedores de IA em memória. A seleção é sempre explícita (provedor + modelo):
// não existe provedor padrão nem troca automática quando um falha.
import type { AIProvider, AIProviderDescriptor } from '../domain/contracts';
import { AIError } from '../domain/errors';
import type { AICapabilityFlag, AIModelInfo } from '../domain/types';

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
const KINDS = ['remote', 'local', 'simulated'];
const FLAGS: readonly AICapabilityFlag[] = ['textGeneration', 'systemMessages', 'structuredOutput', 'imageInput', 'streaming'];
const posInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v > 0;

function validModel(m: AIModelInfo | undefined): boolean {
  if (!m || typeof m.id !== 'string' || !m.id.trim() || typeof m.displayName !== 'string' || !m.capabilities) return false;
  const c = m.capabilities;
  return FLAGS.every((f) => typeof c[f] === 'boolean') && posInt(c.maxInputChars) && posInt(c.maxOutputTokens);
}

function validProvider(p: AIProvider): boolean {
  if (!p || typeof p.id !== 'string' || !PROVIDER_ID.test(p.id)) return false;
  if (typeof p.displayName !== 'string' || !p.displayName.trim() || !KINDS.includes(p.kind) || typeof p.generate !== 'function') return false;
  if (!Array.isArray(p.models) || p.models.length === 0 || !p.models.every(validModel)) return false;
  return new Set(p.models.map((m) => m.id)).size === p.models.length;
}

const describe = (p: AIProvider): AIProviderDescriptor => ({
  id: p.id,
  displayName: p.displayName,
  kind: p.kind,
  models: p.models.map((m) => ({ id: m.id, displayName: m.displayName, capabilities: { ...m.capabilities } })),
});

export class ProviderRegistry {
  private readonly providers = new Map<string, AIProvider>();

  /** Registra um provedor. Rejeita configuração inválida e identificador repetido. */
  register(provider: AIProvider): void {
    if (!validProvider(provider)) throw new AIError('provider_invalid');
    if (this.providers.has(provider.id)) throw new AIError('provider_duplicate', provider.id);
    this.providers.set(provider.id, provider);
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  /** Provedores registrados, como a interface pode exibi-los (cópias, sem o adaptador). */
  list(): AIProviderDescriptor[] {
    return [...this.providers.values()].map(describe);
  }

  /** Provedor e modelo escolhidos, conferindo as capacidades exigidas. */
  resolve(providerId: string, modelId: string, required: readonly AICapabilityFlag[] = []): { provider: AIProvider; model: AIModelInfo } {
    const provider = this.providers.get(providerId);
    if (!provider) throw new AIError('provider_not_found');
    const model = provider.models.find((m) => m.id === modelId);
    if (!model) throw new AIError('model_unsupported', provider.id);
    if (!required.every((f) => model.capabilities[f])) throw new AIError('capability_unsupported', provider.id);
    return { provider, model };
  }
}
