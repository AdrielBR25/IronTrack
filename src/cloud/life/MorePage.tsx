// "Mais" (Fase 08): centro de navegação. Mostra as categorias (não todas as rotas), uma busca de funções e as funções
// que a pessoa mais usa neste aparelho. Cada categoria abre a própria página (#/mais/:categoria) com poucos itens.
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ChevronRight, Search, X } from 'lucide-react';
import { PageHeader } from '@/components/AppLayout';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { CATEGORIES, frequentFeatures, recordUse, searchFeatures, type Category, type Feature } from './catalog';

function FeatureRow({ f, sub }: { f: Feature; sub?: string }) {
  return (
    <Link to={f.to} onClick={() => recordUse(f.id)} className="flex min-h-[3.5rem] items-center gap-3 px-4 py-2.5 transition-colors hover:bg-accent/60 active:bg-accent">
      <f.icon className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{f.label}</span>
        <span className="block truncate text-xs text-muted-foreground">{sub ?? f.hint}</span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60" aria-hidden />
    </Link>
  );
}

function CategoryTile({ c }: { c: Category }) {
  return (
    <Link
      to={`/mais/${c.id}`}
      data-testid={`more-cat-${c.id}`}
      className="group flex min-h-[6.5rem] flex-col justify-between gap-3 rounded-2xl bg-card p-4 ring-1 ring-border/60 transition hover:ring-primary/40 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <span className={cn('flex h-10 w-10 items-center justify-center rounded-xl', c.tone)}>
        <c.icon className="h-5 w-5" aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold leading-tight">{c.label}</span>
        <span className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{c.hint}</span>
      </span>
    </Link>
  );
}

export default function MorePage() {
  const [q, setQ] = useState('');
  const results = useMemo(() => searchFeatures(q), [q]);
  const frequent = useMemo(() => frequentFeatures(), []);
  const searching = q.trim().length > 0;
  return (
    <div className="space-y-5" data-testid="life-more">
      <PageHeader title="Mais" />
      <label className="relative block">
        <span className="sr-only">Buscar função</span>
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar função"
          className="h-12 w-full rounded-2xl bg-card pl-10 pr-10 text-sm ring-1 ring-border/60 placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary [&::-webkit-search-cancel-button]:hidden"
          data-testid="more-search"
        />
        {searching && (
          <button
            type="button"
            onClick={() => setQ('')}
            aria-label="Limpar busca"
            className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-accent"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </label>

      {searching ? (
        results.length ? (
          <Card className="divide-y divide-border/50 overflow-hidden" data-testid="more-results">
            {results.map((f) => (
              <FeatureRow key={f.id} f={f} sub={`${f.category.label} · ${f.hint}`} />
            ))}
          </Card>
        ) : (
          <p className="px-1 py-6 text-center text-sm text-muted-foreground">Nenhuma função encontrada para “{q.trim()}”.</p>
        )
      ) : (
        <>
          <section className="space-y-2">
            <h2 className="px-1 text-xs font-medium text-muted-foreground">Mais usados</h2>
            <div className="grid grid-cols-2 gap-2">
              {frequent.map((f) => (
                <Link
                  key={f.id}
                  to={f.to}
                  onClick={() => recordUse(f.id)}
                  className="flex min-h-[3rem] items-center gap-2.5 rounded-xl bg-secondary/70 px-3 py-2 text-sm font-medium transition hover:bg-secondary active:scale-[0.98]"
                >
                  <f.icon className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                  <span className="truncate">{f.label}</span>
                </Link>
              ))}
            </div>
          </section>
          <section className="space-y-2">
            <h2 className="px-1 text-xs font-medium text-muted-foreground">Categorias</h2>
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
              {CATEGORIES.filter((c) => c.id !== 'conta').map((c) => (
                <CategoryTile key={c.id} c={c} />
              ))}
            </div>
            {CATEGORIES.filter((c) => c.id === 'conta').map((c) => (
              <Link key={c.id} to={`/mais/${c.id}`} data-testid={`more-cat-${c.id}`} className="flex min-h-[3.5rem] items-center gap-3 rounded-2xl bg-card px-4 py-2.5 ring-1 ring-border/60 transition hover:ring-primary/40 active:scale-[0.99]">
                <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl', c.tone)}>
                  <c.icon className="h-[18px] w-[18px]" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">{c.label}</span>
                  <span className="block truncate text-xs text-muted-foreground">{c.hint}</span>
                </span>
                <ChevronRight className="h-4 w-4 text-muted-foreground/60" aria-hidden />
              </Link>
            ))}
          </section>
        </>
      )}
    </div>
  );
}

/** Página de uma categoria do Mais: poucos itens, nomes claros e voltar fácil. */
export function MoreCategoryPage() {
  const { cat } = useParams();
  const navigate = useNavigate();
  const c = CATEGORIES.find((x) => x.id === cat);
  if (!c) {
    return (
      <div className="space-y-4">
        <PageHeader title="Mais" back="/mais" />
        <p className="text-sm text-muted-foreground">Categoria não encontrada.</p>
        <button type="button" className="text-sm font-medium text-primary" onClick={() => navigate('/mais')}>
          Voltar para Mais
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-4" data-testid={`more-category-${c.id}`}>
      <PageHeader title={c.label} subtitle={c.hint} back="/mais" />
      <Card className="divide-y divide-border/50 overflow-hidden">
        {c.items.map((f) => (
          <FeatureRow key={f.id} f={f} />
        ))}
      </Card>
    </div>
  );
}
