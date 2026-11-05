#!/usr/bin/env python3
# Gera services/api/src/nutrition/catalog/taco.json a partir dos CSV da TACO (4ª edição, NEPA/UNICAMP, 2011)
# publicados no repositório MIT https://github.com/raulfdm/taco-api (pasta references/csv).
# Uso: python3 services/api/scripts/build-taco-catalog.py <pasta com food.csv, nutrients.csv, categories.csv>
# Regras: só entram alimentos com energia (kcal) informada; macronutrientes ausentes (NA, traço ou não analisado na
# tabela) ficam null — o app mostra "—" e soma como 0. Nenhum valor é estimado ou completado aqui.
import csv, json, sys, os
src = sys.argv[1]
foods = list(csv.DictReader(open(os.path.join(src, 'food.csv'), encoding='utf-8')))
nut = {r['foodId']: r for r in csv.DictReader(open(os.path.join(src, 'nutrients.csv'), encoding='utf-8'))}
cats = {r['id']: r['name'] for r in csv.DictReader(open(os.path.join(src, 'categories.csv'), encoding='utf-8'))}
num = lambda v: None if v in ('', None) else float(v)
out, skipped = [], []
for f in foods:
    n = nut.get(f['id'])
    if not n or num(n['kcal']) is None:
        skipped.append(f['name']); continue
    out.append([int(f['id']), f['name'], int(f['categoryId']), num(n['kcal']), num(n['protein']), num(n['carbohydrates']), num(n['lipids']), num(n['dietaryFiber'])])
doc = {
    'source': 'TACO — Tabela Brasileira de Composição de Alimentos, 4ª edição revisada e ampliada (NEPA/UNICAMP, 2011)',
    'via': 'https://github.com/raulfdm/taco-api (references/csv, licença MIT)',
    'basis': 'valores por 100 g da parte comestível',
    'columns': ['id', 'name', 'categoryId', 'kcal', 'protein', 'carbs', 'fat', 'fiber'],
    'categories': {int(k): v for k, v in cats.items()},
    'skippedWithoutEnergy': skipped,
    'foods': out,
}
dst = os.path.join(os.path.dirname(__file__), '..', 'src', 'nutrition', 'catalog', 'taco.json')
json.dump(doc, open(dst, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print(len(out), 'alimentos;', len(skipped), 'sem energia informada')
