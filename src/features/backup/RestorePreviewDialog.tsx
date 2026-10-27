import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm';
import { BackupRestoreError, restoreBackupMerge, restoreBackupReplace, type BackupFile, type RestorePreview } from '@/lib/backup';
import type { IntegrityIssue } from '@/lib/integrity';
import type { CollectionName } from '@/lib/types';
import { cn } from '@/lib/utils';

export const COLLECTION_LABEL: Record<CollectionName, string> = {
  settings: 'Configurações',
  routines: 'Rotinas',
  sessions: 'Treinos',
  rotations: 'Rotação',
  overrides: 'Agenda',
  bodyEntries: 'Avaliações',
  photos: 'Fotos',
};

const SEVERITY_LABEL = { error: 'Erro', warning: 'Aviso', info: 'Info' } as const;

export function IssueList({ issues, testId }: { issues: IntegrityIssue[]; testId?: string }) {
  if (!issues.length) return null;
  return (
    <ul className="max-h-48 space-y-1.5 overflow-y-auto text-xs" data-testid={testId}>
      {issues.slice(0, 100).map((i, k) => (
        <li key={k} className="rounded-lg bg-muted/50 px-2.5 py-1.5">
          <span className={cn('font-semibold', i.severity === 'error' ? 'text-destructive' : i.severity === 'warning' ? 'text-warn' : 'text-muted-foreground')}>
            {SEVERITY_LABEL[i.severity]}
          </span>{' '}
          · {COLLECTION_LABEL[i.collection]} · {i.message}
          <span className="block text-muted-foreground">{i.action}</span>
        </li>
      ))}
      {issues.length > 100 && <li className="text-muted-foreground">… e mais {issues.length - 100}.</li>}
    </ul>
  );
}

function errorText(e: unknown): { title: string; description: string } {
  if (e instanceof BackupRestoreError) return { title: e.message, description: e.details.join('\n') };
  return { title: 'A restauração falhou. Nenhum dado foi alterado.', description: e instanceof Error ? e.message : String(e) };
}

/** Prévia obrigatória antes de mesclar ou substituir. Cancelar não altera nada. */
export function RestorePreviewDialog({ backup, preview, onClose }: { backup: BackupFile | null; preview: RestorePreview | null; onClose: () => void }) {
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const p = preview;
  const open = !!backup && !!p;
  const warnings = p ? p.integrity.issues.filter((i) => i.severity !== 'error') : [];
  const errors = p ? p.integrity.issues.filter((i) => i.severity === 'error') : [];
  const t = p?.merge.totals;
  const incomingTotal = p ? Object.values(p.incoming).reduce((a, b) => a + b, 0) : 0;
  const localTotal = p ? Object.values(p.local).reduce((a, b) => a + b, 0) : 0;

  return (
    <>
      <Dialog open={open && !confirmReplace} onOpenChange={(o) => !o && !busy && onClose()}>
        <DialogContent data-testid="restore-preview">
          <DialogHeader>
            <DialogTitle>Restaurar backup</DialogTitle>
            <DialogDescription>
              Backup de {p ? new Date(p.exportedAt).toLocaleString('pt-BR') : ''}: {p?.incoming.routines} rotinas, {p?.incoming.sessions} treinos, {p?.incoming.bodyEntries} avaliações,{' '}
              {p?.incoming.photos} fotos. Nada foi gravado ainda.
            </DialogDescription>
          </DialogHeader>

          {p?.blocked ? (
            <div className="space-y-2 rounded-xl border border-destructive/40 p-3" data-testid="restore-blocked">
              <p className="text-sm font-semibold text-destructive">Este backup tem {errors.length} problema(s) que impedem a restauração.</p>
              <IssueList issues={errors} />
            </div>
          ) : (
            p &&
            t && (
              <div className="space-y-3 text-sm">
                <div className="rounded-xl border p-3" data-testid="merge-summary">
                  <p className="font-semibold">Mesclar com os dados atuais</p>
                  <p className="text-muted-foreground">
                    <strong className="text-foreground">{t.add}</strong> a adicionar · <strong className="text-foreground">{t.duplicate}</strong> duplicatas confirmadas ·{' '}
                    <strong className={t.conflict ? 'text-warn' : 'text-foreground'}>{t.conflict}</strong> conflitos · <strong className="text-foreground">{t.skipped}</strong> ignorados
                  </p>
                  {p.merge.items.length > 0 && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs font-semibold text-primary">Ver detalhes ({p.merge.items.length})</summary>
                      <ul className="mt-2 max-h-48 space-y-1.5 overflow-y-auto text-xs" data-testid="merge-items">
                        {p.merge.items.slice(0, 100).map((i, k) => (
                          <li key={k} className="rounded-lg bg-muted/50 px-2.5 py-1.5">
                            {COLLECTION_LABEL[i.collection]} · {i.message}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  <p className="mt-1 text-xs text-muted-foreground">Nada deste aparelho é sobrescrito ou apagado.</p>
                </div>
                <div className="rounded-xl border p-3" data-testid="replace-summary">
                  <p className="font-semibold">Substituir todos os dados</p>
                  <p className="text-muted-foreground">
                    Apaga os {localTotal} registros deste aparelho e grava os {incomingTotal} do backup.
                  </p>
                </div>
                {warnings.length > 0 && (
                  <details data-testid="integrity-warnings">
                    <summary className="cursor-pointer text-xs font-semibold text-warn">
                      {p.integrity.counts.warning} aviso(s) e {p.integrity.counts.info} observação(ões) de integridade no backup
                    </summary>
                    <div className="mt-2">
                      <IssueList issues={warnings} />
                    </div>
                  </details>
                )}
              </div>
            )
          )}

          <div className="grid gap-2">
            {!p?.blocked && (
              <>
                <Button
                  size="lg"
                  data-testid="backup-merge"
                  disabled={busy}
                  onClick={async () => {
                    if (!backup || !p) return;
                    setBusy(true);
                    try {
                      const r = await restoreBackupMerge(backup, { expectedSignature: p.merge.signature });
                      toast.success('Backup mesclado', {
                        description: `+${r.sessions} treinos, +${r.routines} rotinas, +${r.bodyEntries} avaliações, +${r.photos} fotos · ${r.duplicates} duplicatas · ${r.conflicts} conflitos`,
                      });
                      onClose();
                    } catch (e) {
                      const m = errorText(e);
                      toast.error(m.title, { description: m.description, duration: 10000 });
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Mesclar com os dados atuais
                </Button>
                <Button size="lg" variant="outline" className="text-destructive" data-testid="backup-replace" disabled={busy} onClick={() => setConfirmReplace(true)}>
                  Substituir todos os dados
                </Button>
              </>
            )}
            <Button size="lg" variant="ghost" data-testid="backup-cancel" disabled={busy} onClick={onClose}>
              {p?.blocked ? 'Fechar' : 'Cancelar'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirmReplace}
        onOpenChange={(o) => {
          setConfirmReplace(o);
          if (!o) onClose();
        }}
        destructive
        title="Substituir todos os dados?"
        description="Tudo o que está neste aparelho será apagado e trocado pelo conteúdo do backup. Se algo falhar, nada é alterado. Exporte um backup antes se quiser guardar os dados atuais."
        confirmLabel="Substituir"
        onConfirm={async () => {
          if (!backup) return;
          try {
            const r = await restoreBackupReplace(backup);
            toast.success('Backup restaurado', { description: `${r.sessions} treinos, ${r.routines} rotinas, ${r.bodyEntries} avaliações` });
          } catch (e) {
            const m = errorText(e);
            toast.error(m.title, { description: m.description, duration: 10000 });
          }
        }}
      />
    </>
  );
}
