// Privacidade e consentimento da fundação de IA: nada sai sem autorização da solicitação exata,
// cada categoria e cada provedor precisam de autorização própria e fotos ficam bloqueadas.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AIError, buildAIContext, createConsent, evaluateConsent, type AIConsent, type PreparedAIRequest } from '@/modules/ai';
import { baseInput, blockNetwork, richSources, setup, T0 } from './aiFixtures';

afterEach(() => vi.unstubAllGlobals());

const sentText = (p: { received: { messages: readonly { content: string }[] }[] }) => p.received.map((r) => r.messages.map((m) => m.content).join('\n')).join('\n');

describe('consentimento por solicitação', () => {
  it('sem consentimento, nenhuma execução (o adaptador nem é chamado)', async () => {
    const { service, mock } = setup();
    const p = await service.prepare(baseInput());
    await expect(service.execute(p, undefined)).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(service.execute(p, {} as AIConsent)).rejects.toMatchObject({ code: 'permission_denied' });
    expect(mock.received).toHaveLength(0);
  });

  it('com consentimento válido executa uma única vez (não é permissão permanente)', async () => {
    const { service, mock, consent } = setup();
    const p = await service.prepare(baseInput());
    const c = consent(p);
    await service.execute(p, c);
    await expect(service.execute(p, c)).rejects.toMatchObject({ code: 'permission_denied' });
    expect(mock.received).toHaveLength(1);
  });

  it('consentimento para treino não libera avaliações', async () => {
    const { service, mock, consent } = setup();
    const training = await service.prepare(baseInput({ purpose: 'training_review', categories: ['training_summary'], sources: richSources() }));
    const c = consent(training);
    const body = await service.prepare(baseInput({ purpose: 'training_review', categories: ['training_summary', 'body_measurements'], sources: richSources() }));
    await expect(service.execute(body, { ...c, scope: { requestId: body.requestId, binding: body.binding } })).rejects.toMatchObject({ code: 'permission_denied' });
    expect(evaluateConsent(c, { ...training, categories: ['training_summary', 'body_measurements'] }, T0)).toEqual({ allowed: false, reason: 'category_mismatch' });
    expect(mock.received).toHaveLength(0);
  });

  it('consentimento para avaliações não libera fotos (e fotos não podem ser autorizadas)', async () => {
    const { service, consent } = setup();
    const p = await service.prepare(baseInput({ purpose: 'body_review', categories: ['body_measurements'], sources: richSources() }));
    const c = consent(p);
    const withPhotos = { ...c, categories: [...c.categories, 'progress_photos' as const] };
    expect(evaluateConsent(withPhotos, p, T0)).toEqual({ allowed: false, reason: 'blocked_category' });
    await expect(service.execute(p, withPhotos)).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('consentimento de um provedor não vale para outro', async () => {
    const { service, mock, others, consent } = setup({}, [{ id: 'mock-b' }]);
    const a = await service.prepare(baseInput());
    const c = consent(a);
    const b = await service.prepare(baseInput({ providerId: 'mock-b' }));
    await expect(service.execute(b, c)).rejects.toMatchObject({ code: 'permission_denied' });
    expect(evaluateConsent(c, b, T0)).toEqual({ allowed: false, reason: 'provider_mismatch' });
    expect(mock.received).toHaveLength(0);
    expect(others[0].received).toHaveLength(0);
  });

  it('alterar destino, modelo, finalidade, escopo ou conteúdo invalida a autorização', async () => {
    const { service, mock, consent } = setup();
    const p = await service.prepare(baseInput({ categories: ['training_summary'], sources: richSources() }));
    const c = consent(p);
    const tampered: PreparedAIRequest[] = [
      { ...p, providerId: 'mock-b' },
      { ...p, modelId: 'mock-structured' },
      { ...p, purpose: 'body_review' },
      { ...p, categories: ['training_summary', 'body_measurements'] },
      { ...p, request: { ...p.request, messages: [...p.request.messages, { role: 'user', content: 'extra' }] } },
      { ...p, request: { ...p.request, maxOutputTokens: 1_000 } },
    ];
    for (const t of tampered) await expect(service.execute(t, c)).rejects.toMatchObject({ code: 'permission_denied' });
    // Outra solicitação com o mesmo conteúdo tem outro ID: a autorização antiga não serve.
    const again = await service.prepare(baseInput({ categories: ['training_summary'], sources: richSources() }));
    await expect(service.execute(again, c)).rejects.toMatchObject({ code: 'permission_denied' });
    expect(mock.received).toHaveLength(0);
    // A original segue válida.
    await service.execute(p, c);
    expect(mock.received).toHaveLength(1);
  });

  it('a solicitação preparada é imutável', async () => {
    const { service } = setup();
    const p = await service.prepare(baseInput());
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.request.messages[0])).toBe(true);
    expect(() => {
      (p.request.messages[1] as { content: string }).content = 'trocado';
    }).toThrow();
  });

  it('autorização expirada, futura, malformada ou com categoria desconhecida é negada', async () => {
    const { service, advance } = setup();
    const p = await service.prepare(baseInput());
    const c = createConsent(p, { grantedAt: T0, id: 'c1', ttlMs: 1_000 });
    expect(evaluateConsent(c, p, T0 + 999)).toEqual({ allowed: true });
    expect(evaluateConsent(c, p, T0 + 1_000)).toEqual({ allowed: false, reason: 'expired' });
    expect(evaluateConsent(c, p, T0 - 1)).toEqual({ allowed: false, reason: 'not_yet_valid' });
    expect(evaluateConsent({ ...c, expiresAt: T0 + 24 * 3_600_000 }, p, T0 + 1)).toEqual({ allowed: false, reason: 'expired' });
    expect(evaluateConsent({ ...c, categories: ['tudo'] }, p, T0)).toEqual({ allowed: false, reason: 'unknown_category' });
    expect(evaluateConsent({ ...c, purpose: 'qualquer' }, p, T0)).toEqual({ allowed: false, reason: 'malformed' });
    expect(evaluateConsent('sim', p, T0)).toEqual({ allowed: false, reason: 'malformed' });
    expect(evaluateConsent(null, p, T0)).toEqual({ allowed: false, reason: 'missing' });
    advance(2_000);
    await expect(service.execute(p, c)).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('finalidade desconhecida é negada', async () => {
    const { service } = setup();
    await expect(service.prepare(baseInput({ purpose: 'marketing' as never }))).rejects.toMatchObject({ code: 'permission_denied' });
  });
});

describe('construção do contexto', () => {
  it('sem categorias, nenhum dado pessoal entra, mesmo que as fontes sejam oferecidas', () => {
    const ctx = buildAIContext(richSources(), []);
    expect(ctx.data).toEqual({});
    expect(ctx.included).toEqual([]);
    expect(ctx.excluded.map((e) => e.reason)).toEqual(['not_selected', 'not_selected', 'not_selected', 'not_selected', 'not_selected']);
  });

  it('contexto não autorizado é excluído', () => {
    const ctx = buildAIContext(richSources(), ['training_summary']);
    expect(Object.keys(ctx.data)).toEqual(['training_summary']);
    expect(ctx.excluded).toContainEqual({ category: 'body_measurements', reason: 'not_selected' });
    expect(ctx.excluded).toContainEqual({ category: 'training_history', reason: 'not_selected' });
  });

  it('categoria desconhecida falha (não é ignorada em silêncio)', () => {
    expect(() => buildAIContext(richSources(), ['all'])).toThrow(AIError);
    try {
      buildAIContext(richSources(), ['all']);
    } catch (e) {
      expect((e as AIError).code).toBe('context_invalid');
    }
  });

  it('fotos ficam bloqueadas por padrão e mesmo quando selecionadas; nada de data URL', async () => {
    const all = buildAIContext(richSources(), ['progress_photos', 'body_measurements', 'body_evolution', 'training_history']);
    expect(all.excluded).toContainEqual({ category: 'progress_photos', reason: 'blocked' });
    expect(all.included).not.toContain('progress_photos');
    const json = JSON.stringify(all.data);
    expect(json).not.toMatch(/data:image/);
    expect(json).not.toMatch(/base64/);
    // Texto com data URL embutida é descartado.
    const src = richSources();
    src.trainingSessions[0].exercises[0].name = 'data:image/png;base64,iVBORw0KGgo=';
    expect(JSON.stringify(buildAIContext(src, ['training_history']).data)).not.toMatch(/data:/);

    const { service, mock, consent } = setup();
    const p = await service.prepare(baseInput({ purpose: 'body_review', categories: ['body_measurements', 'progress_photos'], sources: richSources() }));
    expect(p.context.included).toEqual(['body_measurements']);
    expect(p.categories).toEqual(['body_measurements']);
    expect(consent(p).categories).toEqual(['body_measurements']);
    await service.execute(p, consent(p));
    expect(sentText(mock)).not.toMatch(/data:|base64|AAAA/);
  });

  it('IDs internos, perfil, nome e observações não vazam', async () => {
    const { service, mock, consent } = setup();
    const p = await service.prepare(
      baseInput({ categories: ['training_summary', 'training_history', 'body_measurements', 'body_evolution', 'profile_preferences'], sources: richSources() }),
    );
    await service.execute(p, consent(p));
    const sent = sentText(mock);
    for (const secret of ['sess-', '11111111-2222', 'aaaaaaaa-bbbb', 'body-entry-id', 'Fulano Fictício', 'observação pessoal', 'nota pessoal', 'Tricipital', 'r1-A', 'routineId', 'profileId', 'settings', 'createdAt', 'updatedAt'])
      expect(sent).not.toContain(secret);
    expect(sent).toContain('"weightUnit":"kg"');
    expect(sent).toContain('"trainingDaysPerWeek":3');
    expect(sent).toContain('"date":"2030-01-15"');
  });

  it('minimiza campos e arredonda números', () => {
    const ctx = buildAIContext(richSources(), ['training_history', 'body_measurements', 'training_summary']);
    expect(ctx.data.training_history).toEqual([
      { date: '2030-01-15', workout: 'A · Treino A', durationMin: 6, exercises: [{ name: 'Supino', muscleGroup: 'Peito', sets: [{ type: 'normal', weightKg: 60, reps: 8 }] }] },
    ]);
    expect(ctx.data.body_measurements).toEqual([
      { date: '2030-02-10', weightKg: 79, bodyFatPct: 18, waistCm: 85 },
      { date: '2030-01-10', weightKg: 80, bodyFatPct: 18, waistCm: 85 },
    ]);
    expect(ctx.data.training_summary?.totalVolumeKg).toBe(15432.12);
  });

  it('aplica limites de tamanho descartando os itens mais antigos', () => {
    const src = richSources();
    const base = src.trainingSessions[0];
    src.trainingSessions = Array.from({ length: 30 }, (_, i) => ({ ...base, id: `s${i}`, startedAt: base.startedAt + i * 86_400_000 }));
    const ctx = buildAIContext(src, ['training_history']);
    expect(ctx.data.training_history).toHaveLength(12);
    expect(ctx.data.training_history?.[0].date).toBe('2030-02-13');
    const small = buildAIContext(src, ['training_history'], { maxContextChars: 600 });
    expect(small.truncated).toBe(true);
    expect(small.chars).toBeLessThanOrEqual(600);
    expect(() => buildAIContext(src, ['training_summary'], { maxContextChars: 10 })).toThrow(AIError);
  });

  it('nenhum acesso automático ao banco nem persistência de contexto ou consentimento', async () => {
    const net = blockNetwork();
    const idbOpen = vi.spyOn(indexedDB, 'open');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    const { service, consent } = setup();
    const p = await service.prepare(baseInput({ categories: ['training_summary', 'body_measurements'], sources: richSources() }));
    await service.execute(p, consent(p));
    // Sem fontes, o contexto fica vazio: o serviço não busca nada sozinho.
    const empty = await service.prepare(baseInput({ categories: ['training_history', 'body_measurements'] }));
    expect(empty.context.included).toEqual([]);
    expect(empty.context.excluded.every((e) => e.reason === 'no_data')).toBe(true);
    expect(idbOpen).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(getItem).not.toHaveBeenCalled();
    expect(net.fetch).not.toHaveBeenCalled();
    idbOpen.mockRestore();
    setItem.mockRestore();
    getItem.mockRestore();
  });
});
