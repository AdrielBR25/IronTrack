// Lembretes da Bíblia (Fase 05): horário de silêncio (inclusive atravessando a meia-noite), janela de disparo,
// dias da semana e "uma vez por dia".
import { describe, expect, it } from 'vitest';
import { dueReminders, inQuiet } from '@/cloud/bible/reminders';

describe('lembretes da Bíblia', () => {
  it('silêncio: intervalo simples e atravessando a meia-noite', () => {
    expect(inQuiet('23:30', '22:00', '07:00')).toBe(true);
    expect(inQuiet('06:59', '22:00', '07:00')).toBe(true);
    expect(inQuiet('07:00', '22:00', '07:00')).toBe(false);
    expect(inQuiet('13:00', '12:00', '14:00')).toBe(true);
    expect(inQuiet('13:00', null, null)).toBe(false);
  });

  it('dispara só no horário (até 15 min depois), no dia marcado e uma vez', () => {
    const r = [{ kind: 'reading' as const, enabled: true, time: '07:00', days: [1, 2, 3, 4, 5] }];
    const mon = new Date(2026, 10, 2, 7, 5); // segunda
    expect(dueReminders(r, mon, new Set())).toHaveLength(1);
    expect(dueReminders(r, new Date(2026, 10, 2, 7, 20), new Set())).toHaveLength(0);
    expect(dueReminders(r, new Date(2026, 10, 2, 6, 59), new Set())).toHaveLength(0);
    expect(dueReminders(r, new Date(2026, 10, 1, 7, 5), new Set())).toHaveLength(0); // domingo
    expect(dueReminders(r, mon, new Set(['2026-11-02|reading|07:00']))).toHaveLength(0);
    expect(dueReminders([{ ...r[0], enabled: false }], mon, new Set())).toHaveLength(0);
  });
});
