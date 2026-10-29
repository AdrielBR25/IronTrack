// Detalhes da sincronização e resolução de conflitos (Prompt 21). Nada é escolhido sozinho quando os dois aparelhos
// mudaram a mesma coisa: aqui a pessoa compara e decide. As decisões ficam registradas no servidor (versão anterior
// guardada no histórico do registro).
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Copy, Laptop, Loader2, RefreshCw, Server, Trash2 } from 'lucide-react';
import { PageHeader } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useConflicts, useLocalPhotoCount, useOutbox } from '../hooks';
import { COLLECTION_LABELS } from '../importer';
import { currentAccountDb } from '../runtime';
import { KEEP_BOTH, discardRejected, getSyncEngine, resolveConflict, retryRejected, useSyncStatus, type ConflictView, type Resolution } from '../syncEngine';
import { FormAlert } from './authForms';
import { SyncStatusChip, syncLabel } from './SyncStatusChip';

type Doc = Record<string, unknown> | null;

/** Resumo legível de um registro (sem mostrar JSON cru). */
function describe(collection: string, d: Doc): string[] {
  if (!d) return ['Excluído'];
  const out: string[] = [];
  const s = d as Record<string, any>;
  if (collection === 'sessions') {
    out.push(`Treino ${s.workoutLabel ?? ''} · ${s.status === 'completed' ? 'finalizado' : s.status === 'active' ? 'em andamento' : String(s.status ?? '')}`.trim());
    const ex = Array.isArray(s.exercises) ? s.exercises : [];
    for (const e of ex.slice(0, 12)) {
      const sets = Array.isArray(e.sets) ? e.sets : [];
      const done = sets.filter((x: any) => x.status === 'done');
      out.push(`${e.name}: ${done.length}/${sets.length} séries${done.length ? ` (${done.map((x: any) => `${x.weight ?? '-'}×${x.reps ?? '-'}`).join(', ')})` : ''}`);
    }
    return out;
  }
  if (typeof s.name === 'string') out.push(s.name);
  if (typeof s.title === 'string') out.push(s.title);
  if (typeof s.date === 'string') out.push(`Data: ${s.date}`);
  if (typeof s.weightKg === 'number') out.push(`Peso: ${s.weightKg} kg`);
  if (!out.length) out.push(`${Object.keys(s).length} campo(s)`);
  return out;
}

function ConflictCard({ c, onResolved }: { c: ConflictView; onResolved: () => void }) {
  const [busy, setBusy] = useState<Resolution | null>(null);
  const resolve = async (how: Resolution) => {
    const d = currentAccountDb();
    if (!d) return;
    setBusy(how);
    try {
      await resolveConflict(d, c.key, how);
      toast.success('Conflito resolvido.');
      onResolved();
      void getSyncEngine()?.syncNow();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Não foi possível resolver.');
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card data-testid="sync-conflict" data-entity={c.entityId}>
      <CardHeader>
        <CardTitle>{COLLECTION_LABELS[c.collection]}</CardTitle>
        <CardDescription>
          Alterado neste aparelho e em outro ao mesmo tempo{c.paths.length ? `: ${c.paths.slice(0, 4).join(', ')}` : ''}.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <section aria-label="Versão deste aparelho" className="rounded-xl border p-3">
            <h4 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
              <Laptop className="h-4 w-4" aria-hidden /> Este aparelho
            </h4>
            <ul className="space-y-0.5 text-xs">
              {describe(c.collection, c.local).map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          </section>
          <section aria-label="Versão da nuvem" className="rounded-xl border p-3">
            <h4 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
              <Server className="h-4 w-4" aria-hidden /> Nuvem (outro aparelho)
            </h4>
            <ul className="space-y-0.5 text-xs">
              {describe(c.collection, c.server).map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          </section>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => resolve('keep_local')} disabled={!!busy}>
            {busy === 'keep_local' && <Loader2 className="animate-spin" aria-hidden />} Manter deste aparelho
          </Button>
          <Button size="sm" variant="secondary" onClick={() => resolve('use_server')} disabled={!!busy}>
            {busy === 'use_server' && <Loader2 className="animate-spin" aria-hidden />} Usar a da nuvem
          </Button>
          {KEEP_BOTH.includes(c.collection) && c.local && c.server && (
            <Button size="sm" variant="outline" onClick={() => resolve('keep_both')} disabled={!!busy}>
              <Copy aria-hidden /> Manter os dois
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default function SyncPage() {
  const status = useSyncStatus();
  const d = currentAccountDb();
  const [, setTick] = useState(0);
  const outbox = useOutbox();
  const photos = useLocalPhotoCount();
  const conflicts = useConflicts();
  const rejected = useMemo(() => (outbox ?? []).filter((o) => o.state === 'rejected'), [outbox]);
  const [syncing, setSyncing] = useState(false);
  useEffect(() => {
    document.title = 'Sincronização · IronTrack';
  }, []);
  if (!d || !status) return <FormAlert>Entre na sua conta para sincronizar.</FormAlert>;
  const label = syncLabel(status);
  return (
    <>
      <PageHeader title="Sincronização" action={<SyncStatusChip />} />
      <div className="space-y-4">
        <Card>
          <CardContent className="space-y-2 pt-4">
            <p className="text-sm" data-testid="sync-summary">
              Estado: <strong>{label.text}</strong>
              {status.lastSyncAt ? ` · última confirmação do servidor: ${new Date(status.lastSyncAt).toLocaleString('pt-BR')}` : ''}
            </p>
            <p className="text-sm text-muted-foreground">
              {status.pending} alteração(ões) aguardando envio · {status.conflicts} conflito(s) · {status.rejected} recusada(s)
            </p>
            {status.error && <FormAlert tone={status.state === 'offline' ? 'info' : 'error'}>{status.error}</FormAlert>}
            {status.state === 'account_mismatch' && <FormAlert>Este aparelho tem dados de outra conta. Entre na conta correta para enviá-los.</FormAlert>}
            <Button
              onClick={async () => {
                setSyncing(true);
                await getSyncEngine()?.syncNow();
                setSyncing(false);
                setTick((t) => t + 1);
              }}
              disabled={syncing}
            >
              {syncing ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />} Sincronizar agora
            </Button>
            {!!photos && (
              <p className="text-xs text-muted-foreground" data-testid="photos-not-synced">
                {photos} foto(s) de progresso: não sincronizadas (ficam só neste aparelho).
              </p>
            )}
          </CardContent>
        </Card>

        {(conflicts ?? []).length > 0 && (
          <section className="space-y-3" aria-label="Conflitos">
            <h2 className="font-display text-lg font-semibold">Conflitos para decidir</h2>
            {conflicts!.map((c) => (
              <ConflictCard key={c.key} c={c} onResolved={() => setTick((t) => t + 1)} />
            ))}
          </section>
        )}

        {rejected.length > 0 && (
          <section className="space-y-3" aria-label="Recusados">
            <h2 className="font-display text-lg font-semibold">Recusados pelo servidor</h2>
            {rejected.map((r) => (
              <Card key={r.key}>
                <CardContent className="space-y-2 pt-4">
                  <p className="text-sm">
                    {COLLECTION_LABELS[r.collection]}: {r.error}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={async () => {
                        await retryRejected(d, r.key);
                        void getSyncEngine()?.syncNow();
                        setTick((t) => t + 1);
                      }}
                    >
                      Tentar de novo
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        await discardRejected(d, r.key);
                        void getSyncEngine()?.syncNow();
                        setTick((t) => t + 1);
                      }}
                    >
                      <Trash2 aria-hidden /> Descartar esta alteração
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </section>
        )}
      </div>
    </>
  );
}
