// Endurecimento do gateway (P07): credenciais (válida, inválida, revogada, expirada, rotação,
// configuração recarregada), limites sob concorrência, acerto de reservas em falhas e cancelamentos,
// liberação de recursos, titulares independentes, redirecionamentos e SSRF, encerramento gracioso,
// métricas e logs sem dados pessoais. Toda chamada ao provedor é simulada (sem rede externa e sem custo).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sha256Hex } from '../src/auth.ts';
import { validateConfig } from '../src/config.ts';
import { createGateway } from '../src/gateway.ts';
import { MemoryUsageStore } from '../src/limits.ts';
import type { FetchLike } from '../src/providers/types.ts';
import { fakeKey, genBody, hang, json, newToken, openaiOk, post, start, testConfig, type Started } from './helpers.ts';

let s: Started | undefined;
const servers: Server[] = [];
afterEach(async () => {
  await s?.close();
  s = undefined;
  for (const x of servers.splice(0)) {
    x.closeAllConnections();
    await new Promise((r) => x.close(r));
  }
});

const env = { OPENAI_API_KEY: fakeKey('sk-test-'), ANTHROPIC_API_KEY: fakeKey('sk-ant-'), GEMINI_API_KEY: fakeKey('AIza') };
const err = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;
const day = () => new Date().toISOString().slice(0, 10);
const iso = (ms: number) => new Date(ms).toISOString();

/** Configuração com titulares no formato novo (`credentials`). */
function credConfig(clients: { id: string; enabled?: boolean; dailyTokenBudget?: number; creds: { keyId: string; token: string; expiresAt?: string; revokedAt?: string }[] }[], over: Record<string, unknown> = {}) {
  const base = testConfig(newToken(), over);
  return {
    ...base,
    clients: clients.map((c) => ({
      id: c.id,
      enabled: c.enabled ?? true,
      ...(c.dailyTokenBudget ? { dailyTokenBudget: c.dailyTokenBudget } : {}),
      credentials: c.creds.map((k) => ({ keyId: k.keyId, tokenSha256: sha256Hex(k.token), ...(k.expiresAt ? { expiresAt: k.expiresAt } : {}), ...(k.revokedAt ? { revokedAt: k.revokedAt } : {}) })),
    })),
  };
}

async function listen(srv: Server): Promise<string> {
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
}

describe('credenciais: validade, revogação, expiração e rotação', () => {
  it('token válido aceito; inválido, revogado e expirado recusados com a mesma resposta 401', async () => {
    let t = Date.parse('2026-11-01T12:00:00Z');
    const [ok, revoked, expired, future] = [newToken(), newToken(), newToken(), newToken()];
    s = await start({
      now: () => t,
      env,
      config: credConfig([
        {
          id: 'titular-a',
          creds: [
            { keyId: 'k-ok', token: ok },
            { keyId: 'k-rev', token: revoked, revokedAt: '2026-10-30T00:00:00Z' },
            { keyId: 'k-exp', token: expired, expiresAt: '2026-11-01T11:59:59Z' },
            { keyId: 'k-fut', token: future, expiresAt: '2026-11-01T12:00:05Z' },
          ],
        },
      ]),
    });
    expect((await post(s.base, ok, genBody())).status).toBe(200);
    expect((await post(s.base, future, genBody())).status).toBe(200);
    const bodies = new Set<string>();
    for (const tok of [newToken(), revoked, expired]) {
      const r = await post(s.base, tok, genBody());
      expect(r.status).toBe(401);
      bodies.add(await r.text());
    }
    // Não revela se o token existe, foi revogado ou expirou.
    expect(bodies.size).toBe(1);
    // Expiração no instante exato.
    t = Date.parse('2026-11-01T12:00:05Z');
    expect((await post(s.base, future, genBody())).status).toBe(401);
    expect(s.calls).toHaveLength(2);
    expect(s.logs.filter((l) => l.status === 200).map((l) => l.keyId)).toEqual(['k-ok', 'k-fut']);
  });

  it('titular desligado recusa todas as credenciais dele; outro titular segue funcionando', async () => {
    const [a, b] = [newToken(), newToken()];
    s = await start({ env, config: credConfig([{ id: 'off', enabled: false, creds: [{ keyId: 'k-a', token: a }] }, { id: 'on', creds: [{ keyId: 'k-b', token: b }] }]) });
    expect((await post(s.base, a, genBody())).status).toBe(401);
    expect((await post(s.base, b, genBody())).status).toBe(200);
  });

  it('formato do P06 (tokenSha256 no titular) continua aceito, com keyId derivado não secreto', async () => {
    const tok = newToken();
    s = await start({ env, config: testConfig(tok) });
    expect((await post(s.base, tok, genBody())).status).toBe(200);
    expect(s.logs[0].keyId).toBe(`legacy-${sha256Hex(tok).slice(0, 12)}`);
    expect(s.gw.config!.clients[0].credentials).toHaveLength(1);
  });

  it('rotação com período de transição: antigo e novo valem até o fim do prazo; depois só o novo', async () => {
    let t = Date.parse('2026-11-01T12:00:00Z');
    const [old, neu] = [newToken(), newToken()];
    s = await start({ now: () => t, env, config: credConfig([{ id: 'cel', creds: [{ keyId: 'k-old', token: old, expiresAt: '2026-11-01T12:30:00Z' }, { keyId: 'k-new', token: neu }] }]) });
    expect((await post(s.base, old, genBody())).status).toBe(200);
    expect((await post(s.base, neu, genBody())).status).toBe(200);
    t = Date.parse('2026-11-01T12:30:00Z');
    expect((await post(s.base, old, genBody())).status).toBe(401);
    expect((await post(s.base, neu, genBody())).status).toBe(200);
  });

  it('recarregar a configuração revoga na hora: a credencial revogada é recusada sem reiniciar', async () => {
    const tok = newToken();
    const cfg = credConfig([{ id: 'cel', creds: [{ keyId: 'k-1', token: tok }] }]);
    s = await start({ env, config: cfg });
    expect((await post(s.base, tok, genBody())).status).toBe(200);
    const revoked = structuredClone(cfg);
    (revoked.clients[0].credentials[0] as Record<string, unknown>).revokedAt = iso(Date.now());
    expect(s.gw.reload(revoked).ok).toBe(true);
    const r = await post(s.base, tok, genBody());
    expect(r.status).toBe(401);
    expect(await err(r)).toBe('unauthorized');
    expect(s.calls).toHaveLength(1);
  });

  it('requisição em andamento com credencial revogada é interrompida (401) e libera os recursos', async () => {
    const store = new MemoryUsageStore();
    const [tok, other] = [newToken(), newToken()];
    const cfg = credConfig([{ id: 'cel', creds: [{ keyId: 'k-1', token: tok }] }, { id: 'pc', creds: [{ keyId: 'k-2', token: other }] }], { limits: { upstreamTimeoutMs: 5_000, requestsPerMinute: 100 } });
    s = await start({ env, store, upstream: hang, config: cfg });
    const pending = post(s.base, tok, genBody());
    const pendingOther = post(s.base, other, genBody());
    await vi.waitFor(() => expect(s!.calls).toHaveLength(2));
    const revoked = structuredClone(cfg);
    (revoked.clients[0].credentials[0] as Record<string, unknown>).revokedAt = iso(Date.now());
    s.gw.reload(revoked);
    const r = await pending;
    expect(r.status).toBe(401);
    expect(s.calls[0].init.signal.aborted).toBe(true);
    await vi.waitFor(() => expect(store.inFlightOf('cel')).toBe(0));
    // A outra credencial não foi afetada e continua em andamento.
    expect(s.gw.inFlight()).toBe(1);
    expect(s.calls[1].init.signal.aborted).toBe(false);
    s.gw.reload(structuredClone(revoked)); // reload idempotente não derruba o outro titular
    expect(s.calls[1].init.signal.aborted).toBe(false);
    void pendingOther.catch(() => {});
  });

  it('configuração recarregada inválida BLOQUEIA (não mantém a antiga) e em andamento é interrompido', async () => {
    const tok = newToken();
    const cfg = credConfig([{ id: 'cel', creds: [{ keyId: 'k-1', token: tok }] }], { limits: { upstreamTimeoutMs: 5_000, requestsPerMinute: 100 } });
    s = await start({ env, upstream: hang, config: cfg });
    const pending = post(s.base, tok, genBody());
    await vi.waitFor(() => expect(s!.calls).toHaveLength(1));
    const r1 = s.gw.reload({ ...cfg, campoDesconhecido: true });
    expect(r1.ok).toBe(false);
    expect(s.gw.config).toBeNull();
    expect((await pending).status).toBe(503);
    expect(await err(await post(s.base, tok, genBody()))).toBe('gateway_disabled');
    // Corrigido: volta a funcionar sem reiniciar.
    s.gw.reload(cfg);
    expect(s.gw.config).not.toBeNull();
  });

  it('recarregar mantém os contadores: a cota diária não zera com reload', async () => {
    const store = new MemoryUsageStore();
    const tok = newToken();
    const cfg = credConfig([{ id: 'cel', creds: [{ keyId: 'k-1', token: tok }] }]);
    s = await start({ env, store, config: cfg });
    await post(s.base, tok, genBody());
    const used = store.usage('cel', day());
    expect(used).toBe(48);
    s.gw.reload(structuredClone(cfg));
    expect(store.usage('cel', day())).toBe(used);
  });

  it('credencial ausente: titular sem credenciais é configuração inválida', () => {
    expect(validateConfig({ ...testConfig(newToken()), clients: [{ id: 'x', enabled: true }] }).ok).toBe(false);
    expect(validateConfig({ ...testConfig(newToken()), clients: [{ id: 'x', enabled: true, credentials: [] }] }).ok).toBe(false);
  });

  it('validação: keyId, datas ISO, campos extras e duplicados', () => {
    const h = sha256Hex(newToken());
    const v = (credentials: unknown[]) => validateConfig({ ...testConfig(newToken()), clients: [{ id: 'x', enabled: true, credentials }] }).ok;
    expect(v([{ keyId: 'k-1', tokenSha256: h, expiresAt: '2026-12-01T00:00:00Z', createdAt: '2026-11-01T00:00:00.123Z' }])).toBe(true);
    expect(v([{ keyId: 'K 1', tokenSha256: h }])).toBe(false);
    expect(v([{ keyId: 'k-1', tokenSha256: h, expiresAt: 'amanhã' }])).toBe(false);
    expect(v([{ keyId: 'k-1', tokenSha256: h, expiresAt: '2026-12-01' }])).toBe(false);
    expect(v([{ keyId: 'k-1', tokenSha256: h, token: 'texto-puro' }])).toBe(false);
    expect(v([{ keyId: 'k-1', tokenSha256: h }, { keyId: 'k-1', tokenSha256: sha256Hex(newToken()) }])).toBe(false);
    expect(v([{ keyId: 'k-1', tokenSha256: h }, { keyId: 'k-2', tokenSha256: h }])).toBe(false);
  });
});

describe('limites e concorrência', () => {
  it('rajada concorrente não ultrapassa a cota diária (sem corrida entre reservas)', async () => {
    const store = new MemoryUsageStore();
    const tok = newToken();
    // Cada solicitação reserva ~10 + 256 = 266 tokens; cota 1.000 → no máximo 3 cabem ao mesmo tempo.
    s = await start({
      env,
      store,
      upstream: async () => {
        await new Promise((r) => setTimeout(r, 80));
        return json(200, { ...openaiOk(), usage: { input_tokens: 10, output_tokens: 256 } });
      },
      config: credConfig([{ id: 'cel', creds: [{ keyId: 'k-1', token: tok }] }], { limits: { dailyTokenBudget: 1_000, maxConcurrentPerClient: 20, maxConcurrentTotal: 20, requestsPerMinute: 100 } }),
    });
    const rs = await Promise.all(Array.from({ length: 12 }, () => post(s!.base, tok, genBody())));
    const codes = rs.map((r) => r.status);
    expect(codes.filter((c) => c === 200)).toHaveLength(3);
    expect(codes.filter((c) => c === 429)).toHaveLength(9);
    expect(s.calls).toHaveLength(3);
    expect(store.usage('cel', day())).toBeLessThanOrEqual(1_000);
    expect(store.inFlightOf('cel')).toBe(0);
  });

  it('rajada concorrente respeita maxConcurrentPerClient e libera todos os contadores', async () => {
    const store = new MemoryUsageStore();
    const tok = newToken();
    let peak = 0;
    let active = 0;
    s = await start({
      env,
      store,
      upstream: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 60));
        active--;
        return json(200, openaiOk());
      },
      config: credConfig([{ id: 'cel', creds: [{ keyId: 'k-1', token: tok }] }], { limits: { maxConcurrentPerClient: 2, requestsPerMinute: 100 } }),
    });
    const rs = await Promise.all(Array.from({ length: 8 }, () => post(s!.base, tok, genBody())));
    expect(peak).toBeLessThanOrEqual(2);
    expect(rs.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(2);
    expect(rs.every((r) => r.status === 200 || r.status === 429)).toBe(true);
    expect(store.inFlightOf('cel')).toBe(0);
    expect(s.logs.filter((l) => l.limit === 'concurrency_client').length).toBe(rs.filter((r) => r.status === 429).length);
  });

  it('limite total de simultaneidade vale somando titulares diferentes', async () => {
    const [a, b] = [newToken(), newToken()];
    s = await start({ env, upstream: hang, config: credConfig([{ id: 'a', creds: [{ keyId: 'k-a', token: a }] }, { id: 'b', creds: [{ keyId: 'k-b', token: b }] }], { limits: { maxConcurrentTotal: 1, upstreamTimeoutMs: 400, requestsPerMinute: 100 } }) });
    const first = post(s.base, a, genBody());
    await vi.waitFor(() => expect(s!.calls).toHaveLength(1));
    const r = await post(s.base, b, genBody());
    expect(r.status).toBe(429);
    expect(s.logs.at(-1)?.limit).toBe('concurrency_total');
    expect((await first).status).toBe(504);
  });

  it('titulares independentes: cota, limite por minuto e simultaneidade não se misturam', async () => {
    const store = new MemoryUsageStore();
    const [a, b] = [newToken(), newToken()];
    s = await start({ env, store, config: credConfig([{ id: 'a', dailyTokenBudget: 300, creds: [{ keyId: 'k-a', token: a }] }, { id: 'b', creds: [{ keyId: 'k-b', token: b }] }], { limits: { requestsPerMinute: 2 } }) });
    expect((await post(s.base, a, genBody())).status).toBe(200);
    expect((await post(s.base, a, genBody())).status).toBe(429); // cota de a: 48 + 266 > 300
    expect((await post(s.base, a, genBody())).status).toBe(429); // e agora também por minuto
    expect((await post(s.base, b, genBody())).status).toBe(200);
    expect((await post(s.base, b, genBody())).status).toBe(200);
    expect(store.usage('a', day())).toBe(48);
    expect(store.usage('b', day())).toBe(96);
  });

  it('janela deslizante: sem rajada dupla na virada do minuto', async () => {
    let t = 1_000_000;
    const tok = newToken();
    s = await start({ now: () => t, env, config: credConfig([{ id: 'a', creds: [{ keyId: 'k-a', token: tok }] }], { limits: { requestsPerMinute: 2 } }) });
    t += 50_000;
    expect((await post(s.base, tok, genBody())).status).toBe(200);
    expect((await post(s.base, tok, genBody())).status).toBe(200);
    t += 15_000; // nova "janela fixa" começaria aqui, mas as duas anteriores ainda estão no último minuto
    expect((await post(s.base, tok, genBody())).status).toBe(429);
    t += 46_000;
    expect((await post(s.base, tok, genBody())).status).toBe(200);
  });

  it('falha ANTES do envio (adaptador recusa) devolve a reserva e libera a vaga', async () => {
    const store = new MemoryUsageStore();
    const tok = newToken();
    s = await start({
      env,
      store,
      adapters: { openai: { id: 'openai', defaultBaseUrl: 'https://api.openai.com', generate: async () => Promise.reject(new (await import('../src/errors.ts')).GatewayError('request_invalid')) } },
      config: credConfig([{ id: 'a', creds: [{ keyId: 'k-a', token: tok }] }]),
    });
    expect((await post(s.base, tok, genBody())).status).toBe(400);
    expect(store.usage('a', day())).toBe(0);
    expect(store.inFlightOf('a')).toBe(0);
  });

  it('cancelamento do cliente antes do envio ao provedor não cobra nem prende contadores', async () => {
    const store = new MemoryUsageStore();
    const tok = newToken();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reached = false;
    // Adaptador que espera antes de chamar o fetch (simula preparação lenta).
    s = await start({
      env,
      store,
      adapters: {
        openai: {
          id: 'openai',
          defaultBaseUrl: 'https://api.openai.com',
          async generate(_req, ctx) {
            reached = true;
            await gate;
            const res = await ctx.fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: {}, body: '{}', signal: ctx.signal, redirect: 'manual' });
            return { text: String(res.status), finishReason: 'stop' };
          },
        },
      },
      config: credConfig([{ id: 'a', creds: [{ keyId: 'k-a', token: tok }] }], { limits: { upstreamTimeoutMs: 5_000, requestsPerMinute: 100 } }),
    });
    const ctrl = new AbortController();
    const p = post(s.base, tok, genBody(), { signal: ctrl.signal });
    await vi.waitFor(() => expect(reached).toBe(true));
    ctrl.abort();
    await expect(p).rejects.toThrow();
    await vi.waitFor(() => expect(s!.logs.some((l) => l.code === 'cancelled')).toBe(true));
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(s.calls).toHaveLength(0);
    expect(store.usage('a', day())).toBe(0);
    expect(store.inFlightOf('a')).toBe(0);
    expect(s.gw.inFlight()).toBe(0);
  });

  it('cancelamento DEPOIS do envio mantém a reserva (o provedor pode cobrar) e libera a vaga', async () => {
    const store = new MemoryUsageStore();
    const tok = newToken();
    s = await start({ env, store, upstream: hang, config: credConfig([{ id: 'a', creds: [{ keyId: 'k-a', token: tok }] }], { limits: { upstreamTimeoutMs: 5_000, requestsPerMinute: 100 } }) });
    const ctrl = new AbortController();
    const p = post(s.base, tok, genBody(), { signal: ctrl.signal });
    await vi.waitFor(() => expect(s!.calls).toHaveLength(1));
    ctrl.abort();
    await expect(p).rejects.toThrow();
    await vi.waitFor(() => expect(store.inFlightOf('a')).toBe(0));
    expect(store.usage('a', day())).toBe(266);
    expect(s.gw.inFlight()).toBe(0);
  });

  it('provedor recusa com erro HTTP (401/429/500): reserva devolvida; 2xx inaproveitável com uso: cobra o uso informado', async () => {
    const store = new MemoryUsageStore();
    const tok = newToken();
    let next: () => Response = () => json(500, {});
    s = await start({ env, store, upstream: async () => next(), config: credConfig([{ id: 'a', creds: [{ keyId: 'k-a', token: tok }] }], { limits: { requestsPerMinute: 100 } }) });
    for (const st of [401, 429, 500, 503]) {
      next = () => json(st, { error: {} });
      await post(s.base, tok, genBody());
    }
    expect(store.usage('a', day())).toBe(0);
    next = () => json(200, { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'reasoning' }], usage: { input_tokens: 30, output_tokens: 256 } });
    const r = await post(s.base, tok, genBody());
    expect(r.status).toBe(502);
    expect(store.usage('a', day())).toBe(286);
    expect(s.logs.at(-1)).toMatchObject({ code: 'invalid_response', inputTokens: 30, outputTokens: 256, usageSource: 'reported' });
    expect(store.inFlightOf('a')).toBe(0);
  });

  it('falha durante a resposta (conexão cai no meio do corpo): 502, sem repetir, vaga liberada', async () => {
    const store = new MemoryUsageStore();
    const tok = newToken();
    let hits = 0;
    const upstream = await listen(
      createServer((req, res) => {
        hits++;
        req.resume();
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '5000' });
        res.write('{"status":"completed","output":[');
        setTimeout(() => res.destroy(), 20);
      }),
    );
    const cfg = credConfig([{ id: 'a', creds: [{ keyId: 'k-a', token: tok }] }]);
    (cfg.providers.openai as Record<string, unknown>).baseUrl = upstream;
    const gw = createGateway({ config: cfg, env, store });
    const base = await listen(gw.server);
    const r = await post(base, tok, genBody());
    expect(r.status).toBe(502);
    expect(await err(r)).toBe('provider_failure');
    expect(hits).toBe(1);
    expect(store.inFlightOf('a')).toBe(0);
  });

  it('corpo enviado devagar demais: o tempo limite encerra a requisição e não prende o titular', async () => {
    const store = new MemoryUsageStore();
    const tok = newToken();
    s = await start({ env, store, config: credConfig([{ id: 'a', creds: [{ keyId: 'k-a', token: tok }] }], { limits: { upstreamTimeoutMs: 300, requestsPerMinute: 100 } }) });
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${s!.base}/v1/generate`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', 'content-length': '1000' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.write('{"provider":"openai",'); // e nunca termina
    });
    expect(status).toBe(504);
    expect(s.gw.inFlight()).toBe(0);
    expect(s.calls).toHaveLength(0);
    expect((await post(s.base, tok, genBody())).status).toBe(200);
  });

  it('limites com teto: valores absurdos na configuração bloqueiam em vez de desligar a proteção', () => {
    for (const limits of [{ upstreamTimeoutMs: 3_600_000 }, { maxBodyBytes: 50 * 1024 * 1024 }, { requestsPerMinute: 100_000 }, { maxConcurrentPerClient: 1_000 }, { maxUpstreamResponseBytes: 1e9 }])
      expect(validateConfig(testConfig(newToken(), { limits })).ok, JSON.stringify(limits)).toBe(false);
  });
});

describe('redirecionamentos e SSRF', () => {
  it('provedor que redireciona (307) não é seguido: chave e prompt não chegam ao outro destino', async () => {
    const seenByEvil: string[] = [];
    const evil = await listen(
      createServer((req, res) => {
        seenByEvil.push(JSON.stringify(req.headers));
        req.resume();
        res.end('{}');
      }),
    );
    const upstream = await listen(
      createServer((req, res) => {
        req.resume();
        res.writeHead(307, { location: `${evil}/coleta` });
        res.end();
      }),
    );
    const tok = newToken();
    const cfg = credConfig([{ id: 'a', creds: [{ keyId: 'k-a', token: tok }] }]);
    (cfg.providers.anthropic as Record<string, unknown>).baseUrl = upstream;
    const gw = createGateway({ config: cfg, env });
    const base = await listen(gw.server);
    const r = await post(base, tok, genBody({ provider: 'anthropic' }));
    expect(r.status).toBe(502);
    expect(await err(r)).toBe('provider_failure');
    expect(seenByEvil).toEqual([]);
  });

  it('SSRF: o cliente não escolhe destino; config exposta não aceita baseUrl http; metadados de nuvem bloqueados', async () => {
    const tok = newToken();
    s = await start({ env, config: credConfig([{ id: 'a', creds: [{ keyId: 'k-a', token: tok }] }]) });
    for (const model of ['http://169.254.169.254/latest', '../../v1/files', 'x/../../admin']) expect((await post(s.base, tok, genBody({ model }))).status).toBe(403);
    expect((await post(s.base, tok, genBody({ baseUrl: 'http://169.254.169.254' }))).status).toBe(400);
    expect(s.calls).toHaveLength(0);
    const exposed = (baseUrl: string) =>
      validateConfig(testConfig(newToken(), { host: '0.0.0.0', exposeBeyondLoopback: true, providers: { openai: { enabled: true, displayName: 'O', apiKeyEnv: 'OPENAI_API_KEY', baseUrl, models: [{ id: 'm', displayName: 'm', maxInputChars: 10, maxOutputTokens: 10 }] } } })).ok;
    expect(exposed('http://127.0.0.1:9999')).toBe(false);
    expect(exposed('http://169.254.169.254')).toBe(false);
    expect(exposed('https://proxy.exemplo.com')).toBe(true);
  });
});

describe('resiliência', () => {
  it('encerramento gracioso: recusa novas (503), espera as em andamento e fecha', async () => {
    const tok = newToken();
    let finish!: () => void;
    const slow: FetchLike = () => new Promise((r) => (finish = () => r(json(200, openaiOk()))));
    s = await start({ env, upstream: slow, config: credConfig([{ id: 'a', creds: [{ keyId: 'k-a', token: tok }] }], { limits: { upstreamTimeoutMs: 5_000, requestsPerMinute: 100 } }) });
    const pending = post(s.base, tok, genBody());
    await vi.waitFor(() => expect(s!.calls).toHaveLength(1));
    const down = s.gw.shutdown(2_000);
    setTimeout(() => finish(), 100);
    expect((await pending).status).toBe(200);
    await down;
    await expect(fetch(`${s.base}/v1/models`)).rejects.toThrow();
    s = undefined;
  });

  it('encerramento com prazo esgotado interrompe o que restar (503), sem repetir', async () => {
    const tok = newToken();
    s = await start({ env, upstream: hang, config: credConfig([{ id: 'a', creds: [{ keyId: 'k-a', token: tok }] }], { limits: { upstreamTimeoutMs: 5_000, requestsPerMinute: 100 } }) });
    const pending = post(s.base, tok, genBody());
    await vi.waitFor(() => expect(s!.calls).toHaveLength(1));
    const down = s.gw.shutdown(100);
    const r = await pending;
    expect(r.status).toBe(503);
    expect(s.calls[0].init.signal.aborted).toBe(true);
    await down;
    expect(s.calls).toHaveLength(1);
    s = undefined;
  });

  it('falha de DNS / conexão recusada / provedor indisponível: 502 sem fallback e sem repetir', async () => {
    const tok = newToken();
    for (const [name, baseUrl] of [
      ['conexão recusada', 'http://127.0.0.1:1'],
      ['DNS', 'https://host-que-nao-existe.invalid'],
    ] as const) {
      const cfg = credConfig([{ id: 'a', creds: [{ keyId: 'k-a', token: tok }] }], { limits: { upstreamTimeoutMs: 5_000, requestsPerMinute: 100 } });
      (cfg.providers.gemini as Record<string, unknown>).baseUrl = baseUrl;
      const gw = createGateway({ config: cfg, env });
      const base = await listen(gw.server);
      const r = await post(base, tok, genBody({ provider: 'gemini' }));
      expect(r.status, name).toBe(502);
      expect(await err(r)).toBe('provider_failure');
    }
  });
});

describe('observabilidade sem dados pessoais', () => {
  it('métricas agregadas: contagens, códigos, limites, duração e uso por provedor/modelo, sem titular nem conteúdo', async () => {
    const tok = newToken();
    s = await start({ env, config: credConfig([{ id: 'adriel-celular', creds: [{ keyId: 'k-a', token: tok }] }], { limits: { requestsPerMinute: 3 } }) });
    await post(s.base, tok, genBody({ messages: [{ role: 'user', content: 'Peso 83,4 kg MARCADOR-PESSOAL' }] }));
    await post(s.base, null, genBody());
    await post(s.base, tok, genBody({ model: 'nao-permitido' }));
    await post(s.base, tok, genBody());
    await post(s.base, tok, genBody());
    const m = s.gw.metrics();
    expect(m.requests).toBe(5);
    expect(m.byStatus).toMatchObject({ '200': 2, '401': 1, '403': 1, '429': 1 });
    expect(m.errorsByCode).toMatchObject({ unauthorized: 1, model_not_allowed: 1, rate_limited: 1 });
    expect(m.limitsHit).toEqual({ requests_per_minute: 1 });
    expect(m.byModel['openai/test-model-1']).toMatchObject({ requests: 2, ok: 2, errors: 0, reportedInputTokens: 80, reportedOutputTokens: 16 });
    const text = JSON.stringify(m);
    for (const bad of ['adriel', 'k-a', 'MARCADOR', '83,4', tok, env.OPENAI_API_KEY]) expect(text).not.toContain(bad);
  });

  it('log usa rótulo de rota fixo: caminhos arbitrários (que poderiam carregar dados) viram "outra"', async () => {
    const tok = newToken();
    s = await start({ env, config: credConfig([{ id: 'a', creds: [{ keyId: 'k-a', token: tok }] }]) });
    await fetch(`${s.base}/peso-83kg-cintura-88`, { headers: { authorization: `Bearer ${tok}` } });
    await fetch(`${s.base}/v1/models`, { method: 'DELETE', headers: { authorization: `Bearer ${tok}` } });
    const all = JSON.stringify(s.logs);
    expect(all).not.toContain('peso');
    expect(s.logs.map((l) => l.route)).toEqual(['outra', 'outra']);
  });

  it('respostas com cabeçalhos defensivos (no-store, nosniff, CSP sem nada permitido)', async () => {
    s = await start({ env, config: credConfig([{ id: 'a', creds: [{ keyId: 'k-a', token: newToken() }] }]) });
    const r = await fetch(`${s.base}/v1/models`);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(r.headers.get('x-powered-by')).toBeNull();
  });
});
