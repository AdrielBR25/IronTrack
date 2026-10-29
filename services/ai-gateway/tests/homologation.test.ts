// Roteiro de homologação externa (P07): travado por padrão e, no ensaio contra um servidor simulado
// LOCAL, registra só metadados (provedor, modelo, sucesso, código, duração, uso). Nenhuma chamada paga:
// todo destino aqui é 127.0.0.1.
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeKey } from './helpers.ts';

const script = join(import.meta.dirname, '..', 'scripts', 'homologate.ts');
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

function run(args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // Ambiente mínimo: nada herdado (nenhuma chave real do ambiente de quem roda os testes).
    const p = spawn(process.execPath, [script, ...args], { env: { PATH: process.env.PATH ?? '', ...env } });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (c) => (stdout += c));
    p.stderr.on('data', (c) => (stderr += c));
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function mock(handler: (body: string, headers: Record<string, unknown>) => { status: number; body: unknown }) {
  const seen: { body: string; url?: string }[] = [];
  const srv = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      seen.push({ body: b, url: req.url });
      const r = handler(b, req.headers);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.body));
    });
  });
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, seen };
}

const ARGS = ['--provider', 'anthropic', '--model', 'modelo-de-teste', '--confirm-paid-call'];

describe('homologação externa: travas', () => {
  it('desativada por padrão: sem AI_GATEWAY_HOMOLOGATION=1 recusa antes de qualquer rede', async () => {
    const m = await mock(() => ({ status: 200, body: {} }));
    const r = await run([...ARGS, '--base-url', m.url], { ANTHROPIC_API_KEY: fakeKey('sk-ant-') });
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('Homologação desativada');
    expect(m.seen).toHaveLength(0);
  });

  it.each([
    ['sem --confirm-paid-call', ['--provider', 'anthropic', '--model', 'm1'], 'confirm-paid-call'],
    ['sem modelo (não há padrão)', ['--provider', 'anthropic', '--confirm-paid-call'], '--model'],
    ['provedor desconhecido', ['--provider', 'azure', '--model', 'm1', '--confirm-paid-call'], '--provider'],
    ['endereço não local', [...ARGS, '--base-url', 'https://evil.example'], 'servidor simulado'],
    ['saída grande demais', [...ARGS, '--max-output-tokens', '4000'], '--max-output-tokens'],
  ])('recusa %s', async (_n, args, msg) => {
    const r = await run(args, { AI_GATEWAY_HOMOLOGATION: '1', ANTHROPIC_API_KEY: fakeKey('sk-ant-') });
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain(msg);
  });

  it('credencial ausente: não faz a chamada e diz qual variável falta (sem valor)', async () => {
    const r = await run(ARGS, { AI_GATEWAY_HOMOLOGATION: '1' });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('ANTHROPIC_API_KEY');
  });

  it('a suíte automática nunca chama provedores reais: nenhum teste usa o roteiro sem --base-url local', () => {
    const src = readFileSync(import.meta.filename, 'utf8');
    expect(src).not.toMatch(/api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com/);
  });
});

describe('homologação externa: ensaio sem custo contra servidor simulado local', () => {
  it('uma solicitação, pergunta fictícia, saída pequena; registra só metadados', async () => {
    const key = fakeKey('sk-ant-');
    const m = await mock(() => ({ status: 200, body: { type: 'message', content: [{ type: 'text', text: 'OK RESPOSTA-MARCADOR' }], stop_reason: 'end_turn', usage: { input_tokens: 25, output_tokens: 2 } } }));
    const r = await run([...ARGS, '--base-url', m.url], { AI_GATEWAY_HOMOLOGATION: '1', ANTHROPIC_API_KEY: key });
    expect(r.code).toBe(0);
    expect(m.seen).toHaveLength(1);
    const sent = JSON.parse(m.seen[0].body) as { max_tokens: number; messages: { content: string }[] };
    expect(sent.max_tokens).toBe(32);
    expect(sent.messages[0].content).toContain('Teste de conectividade');
    const lines = r.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(Object.keys(rec).sort()).toEqual(['durationMs', 'model', 'ok', 'provider', 'ts', 'usage']);
    expect(rec).toMatchObject({ provider: 'anthropic', model: 'modelo-de-teste', ok: true, usage: { inputTokens: 25, outputTokens: 2 } });
    const out = r.stdout + r.stderr;
    for (const bad of ['RESPOSTA-MARCADOR', 'conectividade', key]) expect(out).not.toContain(bad);
  });

  it('falha registrada com código normalizado (chave recusada → provider_unavailable), sem nova tentativa', async () => {
    const m = await mock(() => ({ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } }));
    const r = await run([...ARGS, '--base-url', m.url], { AI_GATEWAY_HOMOLOGATION: '1', ANTHROPIC_API_KEY: fakeKey('sk-ant-') });
    expect(r.code).toBe(1);
    expect(m.seen).toHaveLength(1);
    const rec = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(rec).toMatchObject({ provider: 'anthropic', ok: false, code: 'provider_unavailable' });
    expect(r.stdout).not.toContain('invalid x-api-key');
  });

  it('OpenAI e Gemini também passam pelo gateway completo no ensaio', async () => {
    const o = await mock(() => ({ status: 200, body: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }], usage: { input_tokens: 20, output_tokens: 1 } } }));
    const ro = await run(['--provider', 'openai', '--model', 'modelo-o', '--confirm-paid-call', '--base-url', o.url], { AI_GATEWAY_HOMOLOGATION: '1', OPENAI_API_KEY: fakeKey('sk-') });
    expect(JSON.parse(ro.stdout)).toMatchObject({ provider: 'openai', ok: true });
    expect(o.seen[0].url).toBe('/v1/responses');
    const g = await mock(() => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 1, thoughtsTokenCount: 10 } } }));
    const rg = await run(['--provider', 'gemini', '--model', 'modelo-g', '--confirm-paid-call', '--base-url', g.url], { AI_GATEWAY_HOMOLOGATION: '1', GEMINI_API_KEY: fakeKey('AIza') });
    expect(JSON.parse(rg.stdout)).toMatchObject({ provider: 'gemini', ok: true, usage: { inputTokens: 20, outputTokens: 11 } });
  });
});
