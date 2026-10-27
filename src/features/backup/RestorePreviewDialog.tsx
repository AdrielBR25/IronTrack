import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm';
import { BackupRestoreError, STALE_PREVIEW_MESSAGE, restoreBackupMerge, restoreBackupReplace, type BackupFile, type RestoreIdentity, type RestorePreview } from '@/lib/backup';
import { shortProfileId } from '@/lib/profile';
import type { CollectionCounts, MergeItem } from '@/lib/merge';
import type { IntegrityIssue, IssueCollection } from '@/lib/integrity';
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

const ISSUE_COLLECTION_LABEL: Record<IssueCollection, string> = { ...COLLECTION_LABEL, profiles: 'Perfil' };

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
          · {ISSUE_COLLECTION_LABEL[i.collection]} · {i.message}
          <span className="block text-muted-foreground">{i.action}</span>
        </li>
      ))}
      {issues.length > 100 && <li className="text-muted-foreground">… e mais {issues.length - 100}.</li>}
    </ul>
  );
}

function MergeTable({ counts }: { counts: Record<CollectionName, CollectionCounts> }) {
  const rows = (Object.keys(COLLECTION_LABEL) as CollectionName[]).filter((c) => {
    const x = counts[c];
    return x.add + x.duplicate + x.conflict + x.skipped > 0;
  });
  if (!rows.length) return null;
  return (
    <table className="w-full table-fixed text-xs" data-testid="merge-table">
      <thead className="text-muted-foreground">
        <tr>
          <th className="text-left font-medium">Tipo</th>
          <th className="font-medium">Adicionar</th>
          <th className="font-medium">Duplic.</th>
          <th className="font-medium">Conflito</th>
          <th className="font-medium">Ignorar</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((c) => (
          <tr key={c} className="text-center tabular-nums">
            <td className="truncate text-left">{COLLECTION_LABEL[c]}</td>
            <td>{counts[c].add}</td>
            <td>{counts[c].duplicate}</td>
            <td className={counts[c].conflict ? 'font-semibold text-warn' : ''}>{counts[c].conflict}</td>
            <td className={counts[c].skipped ? 'font-semibold text-warn' : ''}>{counts[c].skipped}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ItemGroup({ title, items, tone, testId }: { title: string; items: MergeItem[]; tone?: 'warn'; testId: string }) {
  if (!items.length) return null;
  return (
    <details data-testid={testId} open={tone === 'warn' && items.length <= 5}>
      <summary className={cn('cursor-pointer text-xs font-semibold', tone === 'warn' ? 'text-warn' : 'text-primary')}>
        {title} ({items.length})
      </summary>
      <ul className="mt-1.5 max-h-40 space-y-1.5 overflow-y-auto text-xs">
        {items.slice(0, 100).map((i, k) => (
          <li key={k} className="break-words rounded-lg bg-muted/50 px-2.5 py-1.5">
            {COLLECTION_LABEL[i.collection]} · {i.message}
          </li>
        ))}
        {items.length > 100 && <li className="text-muted-foreground">… e mais {items.length - 100}.</li>}
      </ul>
    </details>
  );
}

/** Impacto da restauração sobre a identidade dos dados (perfil proprietário). */
function IdentityNotice({ identity }: { identity: RestoreIdentity }) {
  const local = (
    <strong className="text-foreground">
      “{identity.localProfile.displayName}” ({shortProfileId(identity.localProfile.id)})
    </strong>
  );
  if (identity.relation === 'same')
    return (
      <p className="rounded-xl border p-3 text-xs text-muted-foreground" data-testid="restore-identity" data-relation="same">
        Backup do perfil local {local}.
      </p>
    );
  if (identity.relation === 'legacy')
    return (
      <p className="rounded-xl border p-3 text-xs text-muted-foreground" data-testid="restore-identity" data-relation="legacy">
        Backup em formato anterior, sem identificação de perfil. Os dados restaurados serão atribuídos ao perfil local {local}.
      </p>
    );
  return (
    <div className="space-y-1 rounded-xl border border-warn/50 bg-warn/10 p-3 text-xs" data-testid="restore-identity" data-relation="different">
      <p className="font-semibold text-warn">Este backup pertence a outro perfil</p>
      <p className="break-words text-muted-foreground">
        Perfil do backup: <strong className="text-foreground">“{identity.backupProfile?.displayName}” ({shortProfileId(identity.backupProfile?.id ?? '')})</strong>. Perfil deste aparelho: {local}.
        Mesclar está bloqueado para não misturar dados de perfis diferentes. O identificador do perfil local nunca é trocado.
      </p>
    </div>
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
  // Nova prévia = nova confirmação.
  useEffect(() => {
    setAcceptPartial(false);
    setAcceptTransfer(false);
  }, [preview]);
  const open = !!backup && !!p;
  const warnings = p ? p.integrity.issues.filter((i) => i.severity !== 'error') : [];
  const errors = p ? p.integrity.issues.filter((i) => i.severity === 'error') : [];
  const t = p?.merge.totals;
  const [acceptPartial, setAcceptPartial] = useState(false);
  const [acceptTransfer, setAcceptTransfer] = useState(false);
  const partial = !!p && p.merge.notRestored > 0;
  const profileBlocked = !!p && p.merge.profileBlocked;
  const mergeBlocked = !!p && (p.merge.newErrors.length > 0 || profileBlocked);
  const needsTransfer = !!p && p.replaceRequiresProfileTransfer;
  const items = p?.merge.items ?? [];
  const kept = items.filter((i) => i.kind === 'conflict' || i.kind === 'kept-local');
  const skipped = items.filter((i) => i.kind === 'skipped');
  const addedWithWarning = items.filter((i) => i.kind === 'similar' || i.kind === 'orphan');
  const dedup = items.filter((i) => i.kind === 'duplicate-content');
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

          {p && <IdentityNotice identity={p.identity} />}

          {p?.blocked ? (
            <div className="space-y-2 rounded-xl border border-destructive/40 p-3" data-testid="restore-blocked">
              <p className="text-sm font-semibold text-destructive">Este backup tem {errors.length} problema(s) que impedem a restauração.</p>
              <IssueList issues={errors} />
            </div>
          ) : (
            p &&
            t && (
              <div className="space-y-3 text-sm">
                <div className="space-y-2 rounded-xl border p-3" data-testid="merge-summary">
                  <p className="font-semibold">Mesclar com os dados atuais</p>
                  {!profileBlocked && (
                    <>
                      <p className="text-muted-foreground">
                        <strong className="text-foreground">{t.add}</strong> a adicionar · <strong className="text-foreground">{t.duplicate}</strong> duplicatas confirmadas ·{' '}
                        <strong className={t.conflict ? 'text-warn' : 'text-foreground'}>{t.conflict}</strong> conflitos ·{' '}
                        <strong className={t.skipped ? 'text-warn' : 'text-foreground'}>{t.skipped}</strong> ignorados
                      </p>
                      <MergeTable counts={p.merge.counts} />
                      <ItemGroup testId="merge-kept" title="Mantidos como estão neste aparelho (conflitos)" items={kept} tone="warn" />
                      <ItemGroup testId="merge-skipped" title="Não serão restaurados" items={skipped} tone="warn" />
                      <ItemGroup testId="merge-added-warn" title="Serão adicionados, com aviso" items={addedWithWarning} />
                      <ItemGroup testId="merge-dedup" title="Reconhecidos como duplicatas" items={dedup} />
                      <p className="text-xs text-muted-foreground">Nada deste aparelho é sobrescrito ou apagado.</p>
                    </>
                  )}
                  {profileBlocked && (
                    <p className="text-xs font-semibold text-destructive" data-testid="merge-profile-blocked">
                      Mesclagem indisponível: o backup é de outro perfil. Use “Substituir” só se os dados deste aparelho puderem ser trocados pelos do backup.
                    </p>
                  )}
                  {mergeBlocked && !profileBlocked && (
                    <div className="space-y-1" data-testid="merge-blocked">
                      <p className="text-xs font-semibold text-destructive">A mesclagem deixaria referências inconsistentes e está indisponível. Use “Substituir” ou corrija o arquivo.</p>
                      <IssueList issues={p.merge.newErrors} />
                    </div>
                  )}
                  {partial && !mergeBlocked && (
                    <label className="flex items-start gap-2 rounded-lg bg-warn/10 p-2.5 text-xs" data-testid="merge-partial-warning">
                      <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-current" checked={acceptPartial} onChange={(e) => setAcceptPartial(e.target.checked)} data-testid="accept-partial" />
                      <span>
                        <strong className="text-warn">{p.merge.notRestored} registro(s) do backup não serão restaurados</strong> ({t.conflict} em conflito, mantida a versão deste aparelho; {t.skipped} ignorados).
                        Entendo e quero mesclar mesmo assim.
                      </span>
                    </label>
                  )}
                </div>
                <div className="rounded-xl border p-3" data-testid="replace-summary">
                  <p className="font-semibold">Substituir todos os dados</p>
                  <p className="text-muted-foreground">
                    Apaga os {localTotal} registros deste aparelho e grava os {incomingTotal} do backup. O perfil local é mantido.
                  </p>
                  {needsTransfer && (
                    <label className="mt-2 flex items-start gap-2 rounded-lg bg-warn/10 p-2.5 text-xs" data-testid="profile-transfer-warning">
                      <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-current" checked={acceptTransfer} onChange={(e) => setAcceptTransfer(e.target.checked)} data-testid="accept-profile-transfer" />
                      <span>
                        <strong className="text-warn">Os dados do outro perfil passarão a pertencer ao perfil local</strong> “{p.identity.localProfile.displayName}”. Entendo e quero substituir mesmo assim.
                      </span>
                    </label>
                  )}
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
                  disabled={busy || mergeBlocked || (partial && !acceptPartial)}
                  onClick={async () => {
                    if (!backup || !p) return;
                    setBusy(true);
                    try {
                      const r = await restoreBackupMerge(backup, { expectedLocalFingerprint: p.localFingerprint, acceptPartial });
                      const added = `+${r.sessions} treinos, +${r.routines} rotinas, +${r.bodyEntries} avaliações, +${r.photos} fotos · ${r.duplicates} duplicatas`;
                      if (r.notRestored > 0)
                        toast.warning('Backup mesclado parcialmente', {
                          description: `${added}. ${r.notRestored} registro(s) do backup não foram restaurados (${r.conflicts} em conflito, mantida a versão deste aparelho).`,
                          duration: 12000,
                        });
                      else toast.success('Backup mesclado', { description: added });
                      onClose();
                    } catch (e) {
                      const m = errorText(e);
                      toast.error(m.title, { description: m.description, duration: 10000 });
                      // Prévia desatualizada: fecha para que o usuário gere uma nova.
                      if (e instanceof BackupRestoreError && e.message === STALE_PREVIEW_MESSAGE) onClose();
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Mesclar com os dados atuais
                </Button>
                <Button size="lg" variant="outline" className="text-destructive" data-testid="backup-replace" disabled={busy || (needsTransfer && !acceptTransfer)} onClick={() => setConfirmReplace(true)}>
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
            const r = await restoreBackupReplace(backup, { expectedLocalFingerprint: preview?.localFingerprint, acceptProfileTransfer: acceptTransfer });
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
