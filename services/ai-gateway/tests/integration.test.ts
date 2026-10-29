// Integração ponta a ponta com servidores simulados LOCAIS (sockets reais, sem internet): cliente →
// gateway → "provedor" simulado em 127.0.0.1 (baseUrl definido pelo operador na configuração).
// Valida o caminho HTTP real (cabeçalhos, corpo, limites e cancelamento) sem credencial paga.
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createGateway } from '../src/gateway.ts';
import { fakeKey, genBody, newToken, post, testConfig } from './helpers.ts';

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

async function listen(s: Server): Promise<string> {
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

const readJson = (req: IncomingMessage) =>
  new Promise<Record<string, unknown>>((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => resolve(JSON.parse(d)));
  });

describe('integração com provedores simulados locais', () => {
  it('Anthropic simulado: cabeçalhos, corpo e resposta pelo caminho HTTP real', async () => {
    const seen: { headers: IncomingMessage['headers']; body: Record<string, unknown>; url?: string }[] = [];
    const upstream = await listen(
      createServer(async (req, res) => {
        seen.push({ headers: req.headers, body: await readJson(req), url: req.url });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'Resposta simulada local.' }], stop_reason: 'end_turn', usage: { input_tokens: 9, output_tokens: 4 } }));
      }),
    );
    const token = newToken();
    const key = fakeKey('sk-ant-');
    const cfg = testConfig(token);
    (cfg.providers.anthropic as Record<string, unknown>).baseUrl = upstream;
    const gw = createGateway({ config: cfg, env: { ANTHROPIC_API_KEY: key } });
    const base = await listen(gw.server);

    const r = await post(base, token, genBody({ provider: 'anthropic' }));
    expect(r.status).toBe(200);
    expect(((await r.json()) as { output: { text: string } }).output.text).toBe('Resposta simulada local.');
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('/v1/messages');
    expect(seen[0].headers['x-api-key']).toBe(key);
    expect(seen[0].headers['anthropic-version']).toBe('2026-10-21');
    // O token do IronTrack nunca é repassado ao provedor.
    expect(JSON.stringify(seen[0].headers)).not.toContain(token);
    expect(seen[0].body).toEqual({ model: 'test-model-1', max_tokens: 256, system: 'Instrução fixa do app.', messages: [{ role: 'user', content: 'Pergunta de teste.' }] });
  });

  it('cancelamento do cliente fecha a conexão com o provedor simulado', async () => {
    let upstreamClosed = false;
    let arrived!: () => void;
    const got = new Promise<void>((r) => (arrived = r));
    const upstream = await listen(
      createServer((req, res) => {
        arrived();
        res.on('close', () => (upstreamClosed = true));
        req.resume();
      }),
    );
    const token = newToken();
    const cfg = testConfig(token, { limits: { upstreamTimeoutMs: 10_000, requestsPerMinute: 100 } });
    (cfg.providers.openai as Record<string, unknown>).baseUrl = upstream;
    const gw = createGateway({ config: cfg, env: { OPENAI_API_KEY: fakeKey('sk-') } });
    const base = await listen(gw.server);
    const ctrl = new AbortController();
    const p = post(base, token, genBody(), { signal: ctrl.signal });
    await got;
    ctrl.abort();
    await expect(p).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 200));
    expect(upstreamClosed).toBe(true);
  });
});
