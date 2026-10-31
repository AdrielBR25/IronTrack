// Configuração: exemplos válidos e bloqueados por padrão, sem segredos; erros de configuração travam.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { validateConfig } from '../src/config.ts';
import { sha256Hex, authenticate, bearerToken } from '../src/auth.ts';
import { newToken, testConfig } from './helpers.ts';

const dir = join(import.meta.dirname, '..');
const read = (f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>;

describe('arquivos de exemplo', () => {
  it.each(['config/development.example.json', 'config/remote.example.json'])('%s é válido, vem desligado e sem credenciais', (f) => {
    const raw = read(f);
    const r = validateConfig(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.enabled).toBe(false);
    expect(r.config.clients).toEqual([]);
    expect(Object.values(r.config.providers).every((p) => !p!.enabled)).toBe(true);
  });

  it('nenhum arquivo do gateway contém chave, token ou hash de credencial', () => {
    const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => !f.includes('node_modules') && /\.(ts|json|md|example)$|\.env/.test(f));
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const text = readFileSync(join(dir, f), 'utf8');
      expect(text, f).not.toMatch(/sk-[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9-]{20,}|AIza[0-9A-Za-z_-]{30,}|"tokenSha256"\s*:\s*"[0-9a-f]{64}"/);
      expect(text, f).not.toMatch(/^(OPENAI|ANTHROPIC|GEMINI)_API_KEY=.+$/m);
    }
  });
});

describe('validação', () => {
  const tok = newToken();
  it('aceita a configuração de teste', () => expect(validateConfig(testConfig(tok)).ok).toBe(true));

  it.each([
    ['campo desconhecido', { segredoExtra: 1 }],
    ['origem curinga', { allowedOrigins: ['*'] }],
    ['origem http fora do loopback', { allowedOrigins: ['http://exemplo.com'] }],
    ['host público sem permissão explícita', { host: '0.0.0.0' }],
    ['limite desconhecido', { limits: { semLimite: 1 } }],
    ['limite zero', { limits: { requestsPerMinute: 0 } }],
    ['provedor desconhecido', { providers: { azure: {} } }],
    ['baseUrl http remoto', { providers: { openai: { enabled: true, displayName: 'O', apiKeyEnv: 'OPENAI_API_KEY', baseUrl: 'http://evil.example', models: [{ id: 'm', displayName: 'm', maxInputChars: 1, maxOutputTokens: 1 }] } } }],
    ['chave em VITE_', { providers: { openai: { enabled: true, displayName: 'O', apiKeyEnv: 'VITE_OPENAI_KEY', models: [{ id: 'm', displayName: 'm', maxInputChars: 1, maxOutputTokens: 1 }] } } }],
    ['modelo com barra', { providers: { openai: { enabled: true, displayName: 'O', apiKeyEnv: 'OPENAI_API_KEY', models: [{ id: 'a/b', displayName: 'm', maxInputChars: 1, maxOutputTokens: 1 }] } } }],
    ['Anthropic sem apiVersion', { providers: { anthropic: { enabled: true, displayName: 'A', apiKeyEnv: 'ANTHROPIC_API_KEY', models: [{ id: 'm', displayName: 'm', maxInputChars: 1, maxOutputTokens: 1 }] } } }],
    ['hash de token malformado', { clients: [{ id: 'a', tokenSha256: 'x', enabled: true }] }],
    ['esforço fora da lista', { providers: { anthropic: { enabled: true, displayName: 'A', apiKeyEnv: 'ANTHROPIC_API_KEY', apiVersion: '2026-10-21', models: [{ id: 'claude-haiku-5-5', displayName: 'm', maxInputChars: 1, maxOutputTokens: 1, effort: 'max' }] } } }],
    ['raciocínio em provedor que não é Anthropic', { providers: { openai: { enabled: true, displayName: 'O', apiKeyEnv: 'OPENAI_API_KEY', models: [{ id: 'm', displayName: 'm', maxInputChars: 1, maxOutputTokens: 1, thinking: 'disabled' }] } } }],
    ['Sonnet 5.5 com raciocínio desligado (400 na API)', { providers: { anthropic: { enabled: true, displayName: 'A', apiKeyEnv: 'ANTHROPIC_API_KEY', apiVersion: '2026-10-21', models: [{ id: 'claude-sonnet-5-5', displayName: 'm', maxInputChars: 1, maxOutputTokens: 1, thinking: 'disabled' }] } } }],
    ['Opus 5.5 com raciocínio desligado (400 na API)', { providers: { anthropic: { enabled: true, displayName: 'A', apiKeyEnv: 'ANTHROPIC_API_KEY', apiVersion: '2026-10-21', models: [{ id: 'claude-opus-5-5', displayName: 'm', maxInputChars: 1, maxOutputTokens: 1, thinking: 'disabled' }] } } }],
    ['between_tools fora do Sonnet 5.5', { providers: { anthropic: { enabled: true, displayName: 'A', apiKeyEnv: 'ANTHROPIC_API_KEY', apiVersion: '2026-10-21', models: [{ id: 'claude-haiku-5-5', displayName: 'm', maxInputChars: 1, maxOutputTokens: 1, thinking: 'between_tools' }] } } }],
  ])('recusa: %s', (_n, over) => {
    expect(validateConfig(testConfig(tok, over)).ok).toBe(false);
  });

  it('configuração de IA da API (services/api/config/ai.json) é válida: IDs atuais, esforço e raciocínio aceitos pela API', () => {
    const r = validateConfig(JSON.parse(readFileSync(join(dir, '../api/config/ai.json'), 'utf8')));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.providers.anthropic).toMatchObject({ enabled: true, apiKeyEnv: 'ANTHROPIC_API_KEY', apiVersion: '2026-10-21' });
    expect(r.config.providers.anthropic!.models.map((m) => [m.id, m.thinking, m.effort])).toEqual([
      ['claude-haiku-5-5', 'disabled', 'medium'],
      ['claude-sonnet-5-5', 'between_tools', 'medium'],
    ]);
    expect(r.config.providers.anthropic).not.toHaveProperty('baseUrl');
  });

  it('host fora do loopback só com exposeBeyondLoopback explícito', () => {
    expect(validateConfig(testConfig(tok, { host: '0.0.0.0', exposeBeyondLoopback: true })).ok).toBe(true);
  });
});

describe('credenciais de acesso', () => {
  it('só Bearer com token de alta entropia; compara pelo hash', () => {
    const t = newToken();
    const clients = [{ id: 'a', enabled: true, credentials: [{ keyId: 'k-a', tokenSha256: sha256Hex(t) }] }];
    expect(authenticate(`Bearer ${t}`, clients)?.client.id).toBe('a');
    expect(authenticate(`Bearer ${t}`, clients)?.credential.keyId).toBe('k-a');
    expect(authenticate(`Bearer ${t}x`, clients)).toBeNull();
    expect(authenticate(undefined, clients)).toBeNull();
    expect(authenticate([`Bearer ${t}`], clients)).toBeNull();
    expect(bearerToken('Bearer 123')).toBeNull();
    expect(authenticate(`Bearer ${t}`, [{ ...clients[0], enabled: false }])).toBeNull();
  });
});
