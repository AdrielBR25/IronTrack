import { describe, expect, it } from 'vitest';
import { evaluationToEntry, newMonthsOnly, parseAnthropometricItems, type TextItem } from '@/lib/bodyPdf';
import { evolutionSummary, metricChanges, skinfoldChanges } from '@/lib/bodyEvolution';

// Layout semelhante ao relatório comparativo (valores fictícios): rótulos à esquerda,
// uma coluna por data e as diferenças "( -1,00 )" entre as colunas.
const COLS = [190, 270, 365, 460];
const DATES = ['10/01/2030', '12/02/2030', '15/03/2030', '20/04/2030'];

function report(rows: ([string, string[]] | [string])[], dates = DATES): TextItem[] {
  const items: TextItem[] = [
    { str: 'Nome:', x: 59, y: 720, w: 28 },
    { str: 'Pessoa Teste', x: 92, y: 720, w: 60 },
    { str: 'Data', x: 59, y: 660, w: 20 },
  ];
  dates.forEach((d, i) => items.push({ str: d, x: COLS[i], y: 660, w: 46 }));
  let y = 640;
  for (const [label, values] of rows) {
    if (label.includes('\n')) {
      const [a, b] = label.split('\n');
      items.push({ str: a, x: 59, y: y + 5, w: 110 }, { str: b, x: 59, y: y - 5, w: 30 });
    } else items.push({ str: label, x: 59, y, w: 90 });
    values?.forEach((v, i) => {
      items.push({ str: v, x: COLS[i] + 2, y, w: 36 });
      if (i > 0) items.push({ str: '(', x: COLS[i] + 48, y, w: 3 }, { str: '-1,00', x: COLS[i] + 51, y, w: 18 }, { str: ')', x: COLS[i] + 69, y, w: 3 });
    });
    y -= 18;
  }
  return items;
}

const ROWS: ([string, string[]] | [string])[] = [
  ['Altura', ['1,80 m', '1,80 m', '1,80 m', '1,80 m']],
  ['Peso', ['90,00 kg', '88,50 kg', '87,20 kg', '87,90 kg']],
  ['IMC', ['27,78', '27,31', '26,91', '27,13']],
  ['Massa Gorda', ['22,50 kg', '20,00 kg', '18,00 kg', '17,10 kg']],
  ['% Massa Gorda', ['25,00%', '22,60%', '20,64%', '19,45%']],
  ['Massa Magra', ['67,50 kg', '68,50 kg', '69,20 kg', '70,80 kg']],
  ['% Massa Magra', ['75,00%', '77,40%', '79,36%', '80,55%']],
  ['Soma de dobras', ['150,00 mm', '135,00 mm', '120,00 mm', '112,00 mm']],
  ['Área de Gordura do Braço\n(AGB)', ['20,00', '18,00', '16,00', '15,00']],
  ['Circunferências'],
  ['Cintura', ['95,00 cm', '93,00 cm', '91,50 cm', '90,00 cm']],
  ['Abdomen', ['100,00 cm', '98,00 cm', '96,00 cm', '95,00 cm']],
  ['Coxa direita', ['60,00 cm', '60,50 cm', '61,00 cm', '61,00 cm']],
  ['Braço relaxado direito', ['36,00 cm', '36,50 cm', '37,00 cm', '37,50 cm']],
  ['Pregas Cutâneas'],
  ['Tríceps', ['15,00 mm', '13,00 mm', '12,00 mm', '11,00 mm']],
  ['Abdominal', ['40,00 mm', '35,00 mm', '30,00 mm', '28,00 mm']],
  ['Coxa', ['30,00 mm', '28,00 mm', '25,00 mm', '24,00 mm']],
];

describe('parseAnthropometricItems', () => {
  const r = parseAnthropometricItems(report(ROWS));
  if (!r.ok) throw new Error(r.error);

  it('lê todas as datas e o nome', () => {
    expect(r.patient).toBe('Pessoa Teste');
    expect(r.evaluations.map((e) => e.date)).toEqual(['2030-01-10', '2030-02-12', '2030-03-15', '2030-04-20']);
  });

  it('mapeia composição, circunferências e dobras, ignorando as diferenças', () => {
    const first = r.evaluations[0];
    expect(first.values).toMatchObject({ heightM: 1.8, weightKg: 90, bmi: 27.78, fatMassKg: 22.5, bodyFatPct: 25, leanMassKg: 67.5, leanPct: 75, skinfoldSumMm: 150, armFatArea: 20 });
    expect(first.values).toMatchObject({ waistCm: 95, abdomenCm: 100, thighCm: 60, armCm: 36 });
    expect(first.skinfolds).toEqual({ Tríceps: 15, Abdominal: 40, Coxa: 30 });
    expect(r.evaluations[3].values.weightKg).toBe(87.9);
    // "Coxa" das dobras não sobrescreve a circunferência
    expect(r.evaluations[3].values.thighCm).toBe(61);
  });

  it('recusa arquivos sem datas', () => {
    const bad = parseAnthropometricItems([{ str: 'Cardápio', x: 10, y: 10, w: 50 }]);
    expect(bad.ok).toBe(false);
  });
});

describe('newMonthsOnly', () => {
  const r = parseAnthropometricItems(report(ROWS));
  if (!r.ok) throw new Error(r.error);

  it('importa só os meses que ainda não existem', () => {
    const existing = [{ date: '2030-01-03' }, { date: '2030-02-12' }];
    const { fresh, skipped } = newMonthsOnly(r.evaluations, existing);
    expect(fresh.map((e) => e.date)).toEqual(['2030-03-15', '2030-04-20']);
    expect(skipped.map((e) => e.date)).toEqual(['2030-01-10', '2030-02-12']);
  });

  it('um PDF novo com um mês a mais traz só esse mês', () => {
    const next = parseAnthropometricItems(report(ROWS.map(([l, v]) => (v ? [l, [...v.slice(1), v[3]]] : [l])), ['12/02/2030', '15/03/2030', '20/04/2030', '18/05/2030']));
    if (!next.ok) throw new Error(next.error);
    const { fresh } = newMonthsOnly(next.evaluations, r.evaluations);
    expect(fresh.map((e) => e.date)).toEqual(['2030-05-18']);
  });
});

describe('evolução', () => {
  const r = parseAnthropometricItems(report(ROWS));
  if (!r.ok) throw new Error(r.error);
  const entries = r.evaluations.map((e) => evaluationToEntry(e, 0));

  it('classifica as mudanças pela direção desejada', () => {
    const ch = metricChanges(entries);
    const by = (k: string) => ch.find((c) => c.metric.key === k)!;
    expect(by('fatMassKg').delta).toBeCloseTo(-5.4);
    expect(by('fatMassKg').verdict).toBe('better');
    expect(by('leanMassKg').verdict).toBe('better');
    expect(by('waistCm').verdict).toBe('better');
    expect(by('weightKg').verdict).toBe('neutral');
  });

  it('resume em uma frase', () => {
    expect(evolutionSummary(metricChanges(entries))).toBe(
      'Você perdeu 5,4 kg de gordura e ganhou 3,3 kg de massa magra (estimativas); o % de gordura foi de 25,0% para 19,5%; a cintura diminuiu 5,0 cm.',
    );
  });

  it('ordena as dobras pela maior redução', () => {
    expect(skinfoldChanges(entries).map((s) => [s.site, s.delta])).toEqual([
      ['Abdominal', -12],
      ['Coxa', -6],
      ['Tríceps', -4],
    ]);
  });
});
