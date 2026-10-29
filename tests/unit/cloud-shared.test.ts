// Código compartilhado app ↔ API (Prompt 21): JSON canônico, identidade das entidades, mesclagem de três vias e
// política de senha. As duas pontas dependem destas funções darem exatamente o mesmo resultado.
import { describe, expect, it } from 'vitest';
import { canonicalJson, recordHash, sameContent } from '@shared/canonical.ts';
import { dexieKeyOf, entityIdOf, expectedProfileBoundId } from '@shared/sync/collections.ts';
import { threeWayMerge } from '@shared/sync/merge.ts';
import { isStrongPassword, isValidEmail, normalizeEmail, passwordRequirements, signupSchema } from '@shared/api/auth.ts';
import { pushRequestSchema, syncOpSchema } from '@shared/sync/protocol.ts';

describe('JSON canônico', () => {
  it('ordena chaves, omite undefined e é estável', async () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [1, { z: 1, y: 2 }] } })).toBe('{"a":{"c":[1,{"y":2,"z":1}]},"b":1}');
    expect(sameContent({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(await recordHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
    expect(await recordHash({ a: 1, x: undefined })).toBe(await recordHash({ a: 1 }));
  });
});

describe('identidade das entidades', () => {
  it('rotação usa a rotina; ajuste de dia vira rotina|data; configurações só "settings"', () => {
    expect(entityIdOf('rotations', { routineId: 'r1', nextIndex: 0 })).toBe('r1');
    expect(entityIdOf('overrides', { routineId: 'r1', date: '2026-10-01' })).toBe('r1|2026-10-01');
    expect(dexieKeyOf('overrides', 'r1|2026-10-01')).toEqual(['r1', '2026-10-01']);
    expect(entityIdOf('settings', { id: 'outra' })).toBeNull();
    expect(entityIdOf('sessions', { id: 'x'.repeat(201) })).toBeNull();
    expect(expectedProfileBoundId('exerciseFavorites', { target: 'cat:supino' }, 'P')).toBe('P~cat:supino');
  });
});

describe('mesclagem de três vias', () => {
  const base = { id: 's', status: 'active', updatedAt: 1, exercises: [{ id: 'e1', sets: [{ id: 'a', reps: 10 }, { id: 'b', reps: 10 }] }] };
  it('mudanças em itens diferentes se combinam; carimbos ficam com o maior', () => {
    const l = structuredClone(base);
    l.exercises[0].sets[0].reps = 12;
    l.updatedAt = 5;
    const r = structuredClone(base);
    r.exercises[0].sets[1].reps = 8;
    r.updatedAt = 3;
    const m = threeWayMerge('sessions', base, l, r);
    expect(m.ok && m.merged).toMatchObject({ updatedAt: 5, exercises: [{ sets: [{ reps: 12 }, { reps: 8 }] }] });
  });
  it('mesmo campo com valores diferentes é conflito (nunca escolhe pelo horário)', () => {
    const l = { ...base, exercises: [{ id: 'e1', sets: [{ id: 'a', reps: 12 }, { id: 'b', reps: 10 }] }], updatedAt: 999 };
    const r = { ...base, exercises: [{ id: 'e1', sets: [{ id: 'a', reps: 9 }, { id: 'b', reps: 10 }] }], updatedAt: 1 };
    expect(threeWayMerge('sessions', base, l, r)).toEqual({ ok: false, conflicts: ['exercises[e1].sets[a].reps'] });
  });
  it('itens novos dos dois lados entram; mesmo ID criado nos dois com conteúdo diferente é conflito', () => {
    const l = { ...base, exercises: [...base.exercises, { id: 'n1', sets: [] }] };
    const r = { ...base, exercises: [...base.exercises, { id: 'n2', sets: [] }] };
    const m = threeWayMerge('sessions', base, l, r);
    expect(m.ok && (m.merged.exercises as { id: string }[]).map((e) => e.id).sort()).toEqual(['e1', 'n1', 'n2']);
    expect(threeWayMerge('routines', null, { id: 'r', name: 'A' }, { id: 'r', name: 'B' })).toEqual({ ok: false, conflicts: ['(registro inteiro)'] });
  });
  it('finalizar num lado com qualquer alteração no outro exige decisão', () => {
    const l = { ...base, status: 'completed' };
    const r = { ...base, exercises: [{ id: 'e1', sets: [{ id: 'a', reps: 11 }, { id: 'b', reps: 10 }] }] };
    expect(threeWayMerge('sessions', base, l, r)).toEqual({ ok: false, conflicts: ['status'] });
  });
});

describe('contas: e-mail e senha', () => {
  it('e-mail normalizado e validado', () => {
    expect(normalizeEmail('  Ana@Exemplo.COM ')).toBe('ana@exemplo.com');
    expect(isValidEmail('ana@exemplo.com')).toBe(true);
    expect(isValidEmail('ana@exemplo')).toBe(false);
  });
  it('requisitos da senha (tamanho, letra, número, não é o e-mail, não é comum)', () => {
    expect(isStrongPassword('curta1')).toBe(false);
    expect(isStrongPassword('somenteletras')).toBe(false);
    expect(isStrongPassword('senha12345')).toBe(false);
    expect(isStrongPassword('anapaula10', 'anapaula10@x.com')).toBe(false);
    expect(isStrongPassword('barra-olimpica-2026')).toBe(true);
    expect(passwordRequirements('').every((r) => r.id === 'not_email' || r.id === 'not_common' || r.id === 'max' || !r.ok)).toBe(true);
  });
  it('cadastro exige aceite dos termos e recusa campos extras', () => {
    expect(signupSchema.safeParse({ name: 'Ana', email: 'a@b.co', password: 'x', acceptTerms: false }).success).toBe(false);
    expect(signupSchema.safeParse({ name: 'Ana', email: 'a@b.co', password: 'x', acceptTerms: true, userId: 'outro' }).success).toBe(false);
  });
});

describe('protocolo de sincronização', () => {
  it('operação estrita: put exige doc, delete não aceita doc, campos extras recusados', () => {
    const op = { opId: '6a7c1d1e-2b3c-4d5e-8f60-718293a4b5c6', collection: 'sessions', entityId: 's', kind: 'put', baseVersion: 0, doc: {} };
    expect(syncOpSchema.safeParse(op).success).toBe(true);
    expect(syncOpSchema.safeParse({ ...op, doc: undefined }).success).toBe(false);
    expect(syncOpSchema.safeParse({ ...op, kind: 'delete' }).success).toBe(false);
    expect(syncOpSchema.safeParse({ ...op, userId: 'x' }).success).toBe(false);
    expect(pushRequestSchema.safeParse({ protocol: 'irontrack.sync.v1', deviceId: op.opId, accountId: op.opId, ops: [] }).success).toBe(false);
  });
});
