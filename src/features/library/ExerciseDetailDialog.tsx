import { Link } from 'react-router-dom';
import { Archive, ArchiveRestore, Copy, LineChart, ListOrdered, Pencil, Plus, Star, Trash2, Trophy } from 'lucide-react';
import { LATERALITY_LABEL, LOAD_MODE_LABEL, MODALITY_LABEL } from '@/modules/training';
import { DIFFICULTY_LABEL, EQUIPMENT_NAME, MECHANICS_LABEL, MOVEMENT_LABEL, MUSCLE_NAME, type LibraryItem } from '@/modules/exercises';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export const GENERAL_NOTICE = 'Orientações gerais e conservadoras. Não substituem a avaliação de um profissional nem são prescrição individual.';

function Section({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <section className="space-y-1">
      <h3 className="text-sm font-semibold">{title}</h3>
      <ul className="list-disc space-y-0.5 pl-5 text-sm">
        {items.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Detalhes de um exercício da biblioteca (P17). Tudo local: sem vídeo, sem imagem remota. A dificuldade é só a
 * complexidade técnica geral; os grupos são a descrição usual do exercício, não medidas de ativação.
 */
export function ExerciseDetailDialog({
  item,
  onOpenChange,
  favorite,
  onToggleFavorite,
  onAdd,
  addLabel = 'Adicionar à ficha',
  onDuplicate,
  onEdit,
  onArchive,
  onDelete,
  usage,
  usageLines = [],
  hideFavorite = false,
  performance = null,
}: {
  item: LibraryItem | null;
  onOpenChange: (o: boolean) => void;
  favorite: boolean;
  onToggleFavorite: () => void;
  onAdd?: () => void;
  addLabel?: string;
  onDuplicate?: () => void;
  onEdit?: () => void;
  onArchive?: (archived: boolean) => void;
  onDelete?: () => void;
  /** Uso de um personalizado (fichas e treinos). undefined enquanto carrega. */
  usage?: { templates: number; sessions: number } | null;
  /** P18: evidências de uso, separadas (presença em ficha × sessão registrada com esta origem). */
  usageLines?: string[];
  /** Só leitura (ex.: aberto do editor de fichas, P18): sem favoritar. */
  hideFavorite?: boolean;
  /**
   * P19: desempenho da visão agregada deste item (sessões que registraram esta origem). `available` = há treino
   * concluído com a origem; sem ele, mostra o estado vazio (nada é associado automaticamente).
   */
  performance?: { href: string; available: boolean } | null;
}) {
  const it = item;
  const inUse = !!usage && (usage.templates > 0 || usage.sessions > 0);
  return (
    <Dialog open={!!it} onOpenChange={onOpenChange}>
      <DialogContent data-testid="exercise-detail">
        {it && (
          <>
            <DialogHeader>
              <DialogTitle className="break-words">{it.name}</DialogTitle>
              <DialogDescription>
                {it.kind === 'custom' ? 'Meu exercício' : 'Catálogo do IronTrack'}
                {it.archived ? ' · arquivado' : ''}
                {it.aliases.length ? ` · também chamado de ${it.aliases.slice(0, 3).join(', ')}` : ''}
              </DialogDescription>
            </DialogHeader>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Modalidade</dt>
              <dd>{MODALITY_LABEL[it.modality]}</dd>
              <dt className="text-muted-foreground">Grupo principal</dt>
              <dd>{it.primaryMuscles.map((m) => MUSCLE_NAME[m]).join(', ')}</dd>
              {it.secondaryMuscles.length > 0 && (
                <>
                  <dt className="text-muted-foreground">Secundários</dt>
                  <dd>{it.secondaryMuscles.map((m) => MUSCLE_NAME[m]).join(', ')}</dd>
                </>
              )}
              <dt className="text-muted-foreground">Equipamento</dt>
              <dd>{it.equipment.map((e) => EQUIPMENT_NAME[e]).join(', ')}</dd>
              {it.modality !== 'cardio' && (
                <>
                  <dt className="text-muted-foreground">Execução</dt>
                  <dd>{LATERALITY_LABEL[it.laterality]}{it.laterality === 'unilateral' ? ' (lado registrado em cada série)' : ''}</dd>
                </>
              )}
              <dt className="text-muted-foreground">Tipo de carga</dt>
              <dd>{it.loadMode ? (it.modality === 'timed' && it.loadMode === 'corporal' ? 'Sem carga' : LOAD_MODE_LABEL[it.loadMode]) : 'Sem carga (duração e distância)'}</dd>
              {it.movementPattern && (
                <>
                  <dt className="text-muted-foreground">Movimento</dt>
                  <dd>{MOVEMENT_LABEL[it.movementPattern]}</dd>
                </>
              )}
              {it.mechanics && (
                <>
                  <dt className="text-muted-foreground">Mecânica</dt>
                  <dd>{MECHANICS_LABEL[it.mechanics]}</dd>
                </>
              )}
              {it.difficulty && (
                <>
                  <dt className="text-muted-foreground">Complexidade</dt>
                  <dd>{DIFFICULTY_LABEL[it.difficulty]} (técnica geral)</dd>
                </>
              )}
            </dl>
            {usageLines.length > 0 && (
              <ul className="space-y-0.5 rounded-xl bg-secondary/60 p-3 text-xs" data-testid="detail-usage">
                {usageLines.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            )}
            {performance && (
              <section className="space-y-1.5" data-testid="detail-performance">
                <h3 className="text-sm font-semibold">Desempenho</h3>
                {performance.available ? (
                  <div className="flex flex-wrap gap-1.5">
                    {[
                      { ver: 'evolucao', label: 'Ver evolução', icon: LineChart },
                      { ver: 'recordes', label: 'Ver recordes', icon: Trophy },
                      { ver: 'sessoes', label: 'Ver sessões', icon: ListOrdered },
                    ].map(({ ver, label, icon: Icon }) => (
                      <Link
                        key={ver}
                        to={`${performance.href}?periodo=all&ver=${ver}`}
                        className="inline-flex h-9 items-center gap-1.5 rounded-xl border px-3 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        data-testid={`detail-performance-${ver}`}
                      >
                        <Icon className="h-4 w-4" aria-hidden /> {label}
                      </Link>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground" data-testid="detail-performance-empty">
                    Ainda não há treino concluído com este exercício registrado como origem. Treinos antigos não são associados automaticamente.
                  </p>
                )}
              </section>
            )}
            <Section title="Como executar" items={it.instructions} />
            <Section title="Erros comuns" items={it.commonMistakes} />
            <Section title="Cuidados" items={it.safetyNotes} />
            {it.notes && (
              <section className="space-y-1">
                <h3 className="text-sm font-semibold">Observações</h3>
                <p className="whitespace-pre-line break-words text-sm">{it.notes}</p>
              </section>
            )}
            {it.kind === 'catalog' && <p className="text-xs text-muted-foreground">{GENERAL_NOTICE}</p>}
            {it.kind === 'custom' && inUse && (
              <p className="text-xs text-muted-foreground">
                Usado em {usage!.templates} ficha(s) e {usage!.sessions} treino(s). Não pode ser excluído; arquive para tirá-lo da lista sem perder nada.
              </p>
            )}
            <div className="flex flex-wrap gap-1.5">
              {!hideFavorite && (
                <Button variant={favorite ? 'secondary' : 'outline'} size="sm" aria-pressed={favorite} onClick={onToggleFavorite} data-testid="detail-favorite">
                  <Star className={favorite ? 'fill-current' : ''} /> {favorite ? 'Favorito' : 'Favoritar'}
                </Button>
              )}
              {onDuplicate && (
                <Button variant="outline" size="sm" onClick={onDuplicate}>
                  <Copy /> {it.kind === 'catalog' ? 'Duplicar como meu' : 'Duplicar'}
                </Button>
              )}
              {it.kind === 'custom' && onEdit && !it.archived && (
                <Button variant="outline" size="sm" onClick={onEdit} data-testid="detail-edit">
                  <Pencil /> Editar
                </Button>
              )}
              {it.kind === 'custom' && onArchive && (
                <Button variant="outline" size="sm" onClick={() => onArchive(!it.archived)} data-testid={it.archived ? 'detail-restore' : 'detail-archive'}>
                  {it.archived ? <ArchiveRestore /> : <Archive />} {it.archived ? 'Restaurar' : 'Arquivar'}
                </Button>
              )}
              {it.kind === 'custom' && onDelete && usage && !inUse && (
                <Button variant="ghost" size="sm" className="text-destructive" onClick={onDelete} data-testid="detail-delete">
                  <Trash2 /> Excluir
                </Button>
              )}
            </div>
            {onAdd && (
              <DialogFooter>
                <Button size="lg" disabled={it.archived} onClick={onAdd} data-testid="detail-add">
                  <Plus /> {addLabel}
                </Button>
              </DialogFooter>
            )}
            {onAdd && it.archived && <p className="text-xs text-muted-foreground">Restaure o exercício para adicioná-lo a uma ficha.</p>}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
