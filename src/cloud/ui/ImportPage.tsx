// Importar dados antigos para a conta (Prompt 21): perfil local deste navegador (modo sem conta) ou arquivo de backup
// (ex.: exportado do GitHub Pages). Etapas visíveis: detectar → mostrar contagens → enviar para análise → prévia →
// confirmar → efetivar (uma transação no servidor) → verificar lendo de volta → concluído.
// A origem nunca é apagada nem alterada.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, FileJson, HardDrive, Image, Loader2, ShieldAlert } from 'lucide-react';
import { SYNC_COLLECTIONS, type SyncCollection } from '@shared/sync/collections.ts';
import { PageHeader } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { checkBackupSize, parseBackup } from '@/lib/backup';
import { readFileText } from '@/lib/utils';
import { readLegacyLocalData, type LegacyLocalData } from '../accountDb';
import { useAccountPointer } from '../accountPointer';
import { COLLECTION_LABELS, copyPhotosLocally, importApi, prepareImport, stageImport, type ImportJob, type ImportReport, type PreparedImport, type VerifyResult } from '../importer';
import { currentAccountDb } from '../runtime';
import { getSyncEngine } from '../syncEngine';
import { FormAlert, friendlyError } from './authForms';
import { dismissImportOffer } from './ImportOffer';

type Step =
  | { s: 'choose' }
  | { s: 'prepared'; p: PreparedImport; label: string }
  | { s: 'staging'; p: PreparedImport; label: string; sent: number }
  | { s: 'preview'; p: PreparedImport; label: string; job: ImportJob; preview: ImportReport & { staged: number; expected: number } }
  | { s: 'committing'; p: PreparedImport; label: string }
  | { s: 'done'; p: PreparedImport; label: string; report: ImportReport; verify: VerifyResult; photosCopied: number };

function CountsTable({ counts, photos }: { counts: Partial<Record<SyncCollection, number>>; photos?: number }) {
  const rows = SYNC_COLLECTIONS.filter((c) => counts[c]);
  return (
    <table className="w-full text-sm" data-testid="import-counts">
      <tbody>
        {rows.map((c) => (
          <tr key={c} className="border-b last:border-0">
            <td className="py-1.5">{COLLECTION_LABELS[c]}</td>
            <td className="py-1.5 text-right tabular">{counts[c]}</td>
          </tr>
        ))}
        {!!photos && (
          <tr>
            <td className="py-1.5">Fotos (ficam só neste aparelho, não sincronizadas)</td>
            <td className="py-1.5 text-right tabular">{photos}</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function ReportTable({ r }: { r: ImportReport }) {
  const rows = SYNC_COLLECTIONS.filter((c) => r.byCollection[c]);
  return (
    <table className="w-full text-xs" data-testid="import-report">
      <thead className="text-muted-foreground">
        <tr>
          <th className="text-left font-medium">Tipo</th>
          <th className="text-right font-medium">Novos</th>
          <th className="text-right font-medium">Iguais</th>
          <th className="text-right font-medium">Diferentes</th>
          {r.totals.replaced > 0 && <th className="text-right font-medium">Substituídos</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((c) => {
          const x = r.byCollection[c]!;
          return (
            <tr key={c} className="border-b last:border-0">
              <td className="py-1.5">{COLLECTION_LABELS[c]}</td>
              <td className="text-right tabular">{x.new}</td>
              <td className="text-right tabular">{x.identical}</td>
              <td className="text-right tabular">{x.conflict}</td>
              {r.totals.replaced > 0 && <td className="text-right tabular">{x.replaced}</td>}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export default function ImportPage() {
  const pointer = useAccountPointer();
  const [legacy, setLegacy] = useState<LegacyLocalData | null | 'loading'>('loading');
  const [step, setStep] = useState<Step>({ s: 'choose' });
  const [err, setErr] = useState<string | null>(null);
  const [policy, setPolicy] = useState<'merge' | 'replace'>('merge');
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [copyPhotos, setCopyPhotos] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    readLegacyLocalData().then(setLegacy, () => setLegacy(null));
  }, []);

  if (pointer?.mode !== 'account') return <FormAlert>Entre na sua conta para importar dados.</FormAlert>;
  const dataProfileId = pointer.dataProfileId;
  const dataProfileOwner = pointer.id;

  const prepareFrom = async (kind: 'local_profile' | 'backup_file', data: LegacyLocalData['data'], profileId: string | null, label: string, photos: LegacyLocalData['data']['photos'] = []) => {
    setErr(null);
    try {
      const p = await prepareImport({ ...data, photos }, dataProfileId, { kind, profileId });
      setStep({ s: 'prepared', p, label });
    } catch (e) {
      setErr(`Não foi possível preparar a importação: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const onFile = async (f: File) => {
    setErr(null);
    const tooBig = checkBackupSize(f.size);
    if (tooBig) return setErr(tooBig);
    const r = parseBackup(await readFileText(f));
    if (!r.ok) return setErr(`Backup inválido: ${r.errors.slice(0, 3).join(' ')}`);
    await prepareFrom('backup_file', r.value.data, r.value.profile?.id ?? null, `Arquivo ${f.name}`, r.value.data.photos ?? []);
  };

  const stage = async (p: PreparedImport, label: string) => {
    setErr(null);
    setStep({ s: 'staging', p, label, sent: 0 });
    try {
      const job = await stageImport(p, (sent) => setStep({ s: 'staging', p, label, sent }));
      const preview = await importApi.preview(job.jobId);
      setPolicy('merge');
      setConfirmReplace(false);
      setStep({ s: 'preview', p, label, job, preview });
    } catch (e) {
      setErr(friendlyError(e));
      setStep({ s: 'prepared', p, label });
    }
  };

  const commit = async (st: Extract<Step, { s: 'preview' }>) => {
    setErr(null);
    setStep({ s: 'committing', p: st.p, label: st.label });
    try {
      const { report } = await importApi.commit(st.job.jobId, policy);
      const verify = await importApi.verify(st.job.jobId);
      const d = currentAccountDb();
      const photosCopied = copyPhotos && d ? await copyPhotosLocally(d, st.p.photos) : 0;
      // Traz para este aparelho o que entrou na conta.
      void getSyncEngine()?.syncNow();
      if (verify.ok) dismissImportOffer(dataProfileOwner);
      setStep({ s: 'done', p: st.p, label: st.label, report, verify, photosCopied });
    } catch (e) {
      setErr(`${friendlyError(e)} Nada foi alterado na conta.`);
      setStep(st);
    }
  };

  return (
    <>
      <PageHeader title="Importar dados" subtitle="Traga para a conta os dados usados sem conta ou um arquivo de backup." />
      <div className="space-y-4">
        {err && <FormAlert>{err}</FormAlert>}

        {step.s === 'choose' && (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <HardDrive className="h-4 w-4" aria-hidden /> Dados deste navegador (sem conta)
                </CardTitle>
                <CardDescription>Ficam intactos neste navegador depois da importação.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {legacy === 'loading' && <Loader2 className="h-4 w-4 animate-spin" aria-label="Procurando dados locais" />}
                {legacy === null && <p className="text-sm text-muted-foreground">Nenhum dado sem conta encontrado neste navegador.</p>}
                {legacy && legacy !== 'loading' && (
                  <>
                    <p className="text-sm">
                      Perfil local <strong>{legacy.profile.displayName}</strong>:
                    </p>
                    <CountsTable counts={countsOf(legacy.data)} photos={legacy.photos} />
                    <Button
                      onClick={async () => {
                        const full = await readLegacyLocalData({ withPhotos: true });
                        if (full) await prepareFrom('local_profile', full.data, full.profile.id, `Perfil local "${full.profile.displayName}"`, full.data.photos);
                      }}
                    >
                      Revisar e importar
                    </Button>
                  </>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileJson className="h-4 w-4" aria-hidden /> Arquivo de backup
                </CardTitle>
                <CardDescription>Backup do IronTrack (qualquer versão), por exemplo exportado da versão do GitHub Pages em Ajustes → Exportar backup.</CardDescription>
              </CardHeader>
              <CardContent>
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/json,.json"
                  className="sr-only"
                  data-testid="cloud-import-file"
                  aria-label="Escolher arquivo de backup"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (f) void onFile(f);
                  }}
                />
                <Button variant="secondary" onClick={() => fileRef.current?.click()}>
                  Escolher arquivo
                </Button>
              </CardContent>
            </Card>
          </>
        )}

        {step.s === 'prepared' && (
          <Card>
            <CardHeader>
              <CardTitle>{step.label}</CardTitle>
              <CardDescription>Confira o que será enviado para análise. Nada entra na conta antes da sua confirmação.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <CountsTable counts={step.p.counts} photos={step.p.photos.length} />
              {step.p.skipped > 0 && <p className="text-xs text-muted-foreground">{step.p.skipped} registro(s) sem identificação válida serão ignorados.</p>}
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => stage(step.p, step.label)} disabled={!step.p.items.length}>
                  Analisar com a conta
                </Button>
                <Button variant="secondary" onClick={() => setStep({ s: 'choose' })}>
                  Voltar
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {step.s === 'staging' && (
          <Card>
            <CardContent className="space-y-2 pt-4" role="status">
              <p className="flex items-center gap-2 text-sm">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Enviando para análise: {step.sent} de {step.p.items.length}
              </p>
              <progress className="w-full" max={step.p.items.length} value={step.sent} aria-label="Progresso do envio" />
            </CardContent>
          </Card>
        )}

        {step.s === 'preview' && (
          <Card>
            <CardHeader>
              <CardTitle>Prévia da importação</CardTitle>
              <CardDescription>
                {step.preview.staged} de {step.preview.expected} registros recebidos e comparados com a sua conta.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {step.job.previousImport && (
                <FormAlert tone="info">Estes mesmos dados já foram importados em {new Date(step.job.previousImport.committedAt).toLocaleString('pt-BR')}. Importar de novo não duplica nada: registros iguais são ignorados.</FormAlert>
              )}
              <ReportTable r={step.preview} />
              {step.preview.totals.conflict > 0 && (
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">{step.preview.totals.conflict} registro(s) existem na conta com conteúdo diferente. O que fazer com eles?</legend>
                  <label className="flex items-start gap-2 text-sm">
                    <input type="radio" name="politica" checked={policy === 'merge'} onChange={() => setPolicy('merge')} className="mt-1" />
                    <span>
                      <strong>Mesclar (recomendado):</strong> importa só os novos e mantém a versão da conta nos diferentes.
                    </span>
                  </label>
                  <label className="flex items-start gap-2 text-sm">
                    <input type="radio" name="politica" checked={policy === 'replace'} onChange={() => setPolicy('replace')} className="mt-1" />
                    <span>
                      <strong>Substituir:</strong> os diferentes passam a ter o conteúdo do arquivo. A versão anterior fica guardada no histórico da conta.
                    </span>
                  </label>
                  {policy === 'replace' && (
                    <label className="flex items-start gap-2 rounded-xl border border-destructive/50 p-2 text-sm">
                      <input type="checkbox" checked={confirmReplace} onChange={(e) => setConfirmReplace(e.target.checked)} className="mt-1" />
                      <span>
                        <ShieldAlert className="mr-1 inline h-4 w-4 text-destructive" aria-hidden />
                        Confirmo que quero substituir {step.preview.totals.conflict} registro(s) da conta.
                      </span>
                    </label>
                  )}
                </fieldset>
              )}
              {step.p.photos.length > 0 && (
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" checked={copyPhotos} onChange={(e) => setCopyPhotos(e.target.checked)} className="mt-1" />
                  <span>
                    <Image className="mr-1 inline h-4 w-4" aria-hidden />
                    Copiar {step.p.photos.length} foto(s) para esta conta <strong>só neste aparelho</strong> (fotos não são sincronizadas).
                  </span>
                </label>
              )}
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => commit(step)} disabled={policy === 'replace' && !confirmReplace} data-testid="import-confirm">
                  Confirmar importação
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    void importApi.cancel(step.job.jobId).catch(() => undefined);
                    setStep({ s: 'choose' });
                  }}
                >
                  Cancelar
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {step.s === 'committing' && (
          <Card>
            <CardContent className="pt-4" role="status">
              <p className="flex items-center gap-2 text-sm">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Gravando na conta e conferindo o resultado…
              </p>
            </CardContent>
          </Card>
        )}

        {step.s === 'done' && (
          <Card data-testid="import-done" data-verified={step.verify.ok ? 'ok' : 'falhou'}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {step.verify.ok ? <CheckCircle2 className="h-5 w-5 text-primary" aria-hidden /> : <ShieldAlert className="h-5 w-5 text-destructive" aria-hidden />}
                {step.verify.ok ? 'Importação concluída e conferida' : 'Importação gravada, mas a conferência encontrou diferenças'}
              </CardTitle>
              <CardDescription>
                {step.verify.matched} de {step.verify.expectedEqual} registro(s) conferidos no servidor
                {step.verify.keptAccountVersion ? `; ${step.verify.keptAccountVersion} mantidos com a versão da conta` : ''}.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <ReportTable r={step.report} />
              {!step.verify.ok && (
                <FormAlert>
                  {step.verify.mismatches.length} registro(s) não conferem. Os dados de origem continuam intactos; tente importar de novo (registros iguais são ignorados).
                </FormAlert>
              )}
              {step.photosCopied > 0 && <p className="text-sm">{step.photosCopied} foto(s) copiadas só para este aparelho (não sincronizadas).</p>}
              <p className="text-sm text-muted-foreground">A origem não foi alterada. Os dados aparecem nos seus outros aparelhos na próxima sincronização.</p>
              <div className="flex flex-wrap gap-2">
                <Button asChild>
                  <Link to="/">Ir para o início</Link>
                </Button>
                <Button variant="secondary" onClick={() => setStep({ s: 'choose' })}>
                  Fazer outra importação
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}

function countsOf(d: LegacyLocalData['data']): Partial<Record<SyncCollection, number>> {
  const out: Partial<Record<SyncCollection, number>> = {};
  for (const c of SYNC_COLLECTIONS) {
    const n = c === 'settings' ? (d.settings ? 1 : 0) : ((d[c] as unknown[]) ?? []).length;
    if (n) out[c] = n;
  }
  return out;
}
