// Oferta de importação (Prompt 21): no modo conta, se este navegador tem dados usados sem conta, pergunta uma vez se a
// pessoa quer trazê-los para a conta. Nunca importa sozinho; "Agora não" fica lembrado por conta neste aparelho.
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { HardDriveUpload, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ACCOUNTS_ENABLED } from '../config';
import { readLegacyLocalData } from '../accountDb';
import { useAccountPointer } from '../accountPointer';

export const IMPORT_OFFER_KEY = 'irontrack.importOffer.v1';

function dismissed(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(IMPORT_OFFER_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(-20) : [];
  } catch {
    return [];
  }
}

export function dismissImportOffer(accountId: string) {
  try {
    localStorage.setItem(IMPORT_OFFER_KEY, JSON.stringify([...new Set([...dismissed(), accountId])]));
  } catch {
    /* sem armazenamento: a oferta volta na próxima abertura */
  }
}

export function ImportOffer() {
  const p = useAccountPointer();
  const { pathname } = useLocation();
  const [summary, setSummary] = useState<{ sessions: number; routines: number; name: string } | null>(null);
  const [hidden, setHidden] = useState(false);
  const accountId = p?.mode === 'account' ? p.id : null;
  useEffect(() => {
    if (!ACCOUNTS_ENABLED || !accountId || dismissed().includes(accountId)) return;
    let alive = true;
    readLegacyLocalData().then(
      (l) => {
        if (!alive || !l) return;
        const total = l.data.routines.length + l.data.sessions.length + l.data.bodyEntries.length + l.data.goals.length + l.data.planEntries.length + l.photos;
        if (total > 0) setSummary({ sessions: l.data.sessions.length, routines: l.data.routines.length, name: l.profile.displayName });
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [accountId]);
  if (!summary || hidden || !accountId || pathname.startsWith('/conta/importar')) return null;
  return (
    <div role="region" aria-label="Dados sem conta encontrados" className="mb-4 flex items-start gap-3 rounded-2xl border border-primary/40 bg-primary/10 p-3" data-testid="import-offer">
      <HardDriveUpload className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-sm">
          Encontramos dados usados sem conta neste navegador (perfil <strong>{summary.name}</strong>: {summary.routines} ficha(s), {summary.sessions} treino(s)). Quer revisar e importar para a
          sua conta? Nada é importado sem a sua confirmação, e os dados originais ficam intactos.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" asChild>
            <Link to="/conta/importar">Revisar e importar</Link>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              dismissImportOffer(accountId);
              setHidden(true);
            }}
          >
            Agora não
          </Button>
        </div>
      </div>
      <button
        type="button"
        className="rounded-lg p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Fechar aviso"
        onClick={() => setHidden(true)}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
