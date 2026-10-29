import { Component, Suspense, lazy, useMemo, useState, type ReactNode } from 'react';
import { Box, Pause, Play, Repeat, RotateCcw } from 'lucide-react';
import { MUSCLE_NAME, type LibraryItem } from '@/modules/exercises';
import { VISUAL_STATUS_LABEL, demoForCatalog, emphasisFor, visualFor } from '@/modules/exercises/demos';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { cn } from '@/lib/utils';
import { MuscleMap2D } from './MuscleMap2D';
import { MUSCLE_COLORS } from './colors';
import type { HumanoidView } from './Humanoid3D';

// Seção visual de um exercício (P20, docs/BIBLIOTECA_VISUAL.md): humanoide 3D com os músculos destacados e, quando o
// exercício tem demonstração, o movimento real com controles e textos sincronizados. Sem WebGL (ou se a pessoa
// preferir), o mapa 2D com a mesma taxonomia. A legenda em texto vale para os dois modos (nunca só a cor).

const Humanoid3D = lazy(() => import('./Humanoid3D'));

export type VisualItem = Pick<LibraryItem, 'kind' | 'refId' | 'name' | 'primaryMuscles' | 'secondaryMuscles'>;

let webgl: boolean | null = null;
/** Testa uma vez se o aparelho abre WebGL (sem manter o contexto). */
export function webglAvailable(): boolean {
  if (webgl !== null) return webgl;
  try {
    const c = document.createElement('canvas');
    const ctx = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext | null;
    webgl = !!ctx;
    ctx?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    webgl = false;
  }
  return webgl;
}

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Se o pedaço do 3D falhar ao carregar (ex.: offline antes do primeiro cache), cai no mapa 2D. */
class Boundary extends Component<{ fallback: ReactNode; onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function MuscleLegend({ item }: { item: VisualItem }) {
  const secondary = item.secondaryMuscles.filter((m) => !item.primaryMuscles.includes(m));
  return (
    <ul className="space-y-1 text-sm" data-testid="muscle-legend">
      <li className="flex items-start gap-2">
        <span className="mt-1 h-3 w-3 shrink-0 rounded-sm" style={{ background: MUSCLE_COLORS.primary }} aria-hidden />
        <span>
          <strong>Principal:</strong> {item.primaryMuscles.map((m) => MUSCLE_NAME[m]).join(', ')}
        </span>
      </li>
      {secondary.length > 0 && (
        <li className="flex items-start gap-2">
          <span className="mt-1 h-3 w-3 shrink-0 rounded-sm" style={{ background: `repeating-linear-gradient(45deg, ${MUSCLE_COLORS.secondary} 0 3px, #fff8 3px 5px)` }} aria-hidden />
          <span>
            <strong>Secundário:</strong> {secondary.map((m) => MUSCLE_NAME[m]).join(', ')}
          </span>
        </li>
      )}
      <li className="flex items-start gap-2 text-muted-foreground">
        <span className="mt-1 h-3 w-3 shrink-0 rounded-sm" style={{ background: MUSCLE_COLORS.neutral }} aria-hidden />
        <span>Demais músculos: neutros</span>
      </li>
    </ul>
  );
}

const PHASE_LABEL = { excentrica: 'Excêntrica (descida/alongamento)', concentrica: 'Concêntrica (força)', pausa: 'Pausa', sustentacao: 'Sustentação' } as const;

export default function ExerciseVisual({ item, instructions = [] }: { item: VisualItem; instructions?: readonly string[] }) {
  const catalogId = item.kind === 'catalog' ? item.refId : null;
  const entry = visualFor(catalogId);
  const demo = demoForCatalog(catalogId);
  const emphasis = useMemo(() => emphasisFor(item.primaryMuscles, item.secondaryMuscles), [item.primaryMuscles, item.secondaryMuscles]);
  const [mode, setMode] = useState<'3d' | '2d'>(() => (webglAvailable() ? '3d' : '2d'));
  const [failed, setFailed] = useState<string | null>(() => (webglAvailable() ? null : 'Este aparelho não abre gráficos 3D (WebGL).'));
  const [view, setView] = useState<HumanoidView>(() => (demo?.views[0] === 'frontal' ? 'frontal' : 'lateral'));
  const [playing, setPlaying] = useState(() => !reducedMotion());
  const [loop, setLoop] = useState(true);
  const [speed, setSpeed] = useState<'0.5' | '1'>('1');
  const [restart, setRestart] = useState(0);
  const [cue, setCue] = useState(0);
  const animated = demo?.kind === 'animated';
  const c = demo?.cues[cue];
  const names = item.primaryMuscles.map((m) => MUSCLE_NAME[m]).join(', ');
  const label = `${item.name}: ${demo ? (animated ? 'demonstração do movimento' : 'posição do exercício') : 'mapa muscular'} no boneco 3D, músculos principais em vermelho (${names})`;
  const map2d = <MuscleMap2D emphasis={emphasis} label={`${item.name}: músculos trabalhados, frente e costas. Principais: ${names}.`} className="mx-auto max-h-72" />;

  return (
    <section className="space-y-2" aria-label="Visualização do exercício" data-testid="exercise-visual" data-status={entry.status}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Músculos e movimento</h3>
        <Badge variant={entry.status === 'anatomia' ? 'outline' : 'secondary'} data-testid="visual-status">
          <Box className="mr-1 h-3 w-3" aria-hidden /> {VISUAL_STATUS_LABEL[entry.status]}
        </Badge>
      </div>

      {mode === '3d' && !failed ? (
        <div className="relative aspect-square w-full overflow-hidden rounded-2xl bg-secondary/50 sm:aspect-[4/3]">
          <Boundary fallback={map2d} onError={() => setFailed('Não foi possível carregar o 3D.')}>
            <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted-foreground">Carregando 3D…</div>}>
              <Humanoid3D
                key={`${demo?.id ?? 'neutro'}:${[...emphasis].join()}`}
                demo={demo}
                emphasis={emphasis}
                view={view}
                playing={playing}
                speed={Number(speed)}
                loop={loop}
                restartToken={restart}
                label={label}
                onCue={setCue}
                onEnded={() => setPlaying(false)}
                onFail={(r) => setFailed(`O 3D não abriu neste aparelho (${r}).`)}
              />
            </Suspense>
          </Boundary>
          <p className="pointer-events-none absolute bottom-1.5 left-2 text-[11px] text-muted-foreground">Arraste para girar · pinça para zoom</p>
        </div>
      ) : (
        map2d
      )}
      {failed && (
        <p className="text-xs text-muted-foreground" role="status" data-testid="visual-fallback">
          {failed} Mostrando o mapa 2D.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {mode === '3d' && !failed && (
          <>
            {animated && (
              <>
                <Button size="sm" variant="secondary" onClick={() => setPlaying((p) => !p)} aria-pressed={playing} data-testid="visual-play">
                  {playing ? <Pause /> : <Play />} {playing ? 'Pausar' : 'Reproduzir'}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label="Recomeçar"
                  onClick={() => {
                    setRestart((n) => n + 1);
                    setPlaying(true);
                  }}
                >
                  <RotateCcw />
                </Button>
                <Button size="sm" variant={loop ? 'secondary' : 'outline'} aria-pressed={loop} aria-label="Repetir" onClick={() => setLoop((l) => !l)}>
                  <Repeat />
                </Button>
                <Segmented
                  size="sm"
                  className="w-24"
                  aria-label="Velocidade"
                  value={speed}
                  onChange={setSpeed}
                  options={[
                    { value: '0.5', label: '0,5×' },
                    { value: '1', label: '1×' },
                  ]}
                />
              </>
            )}
            <Segmented
              size="sm"
              className="w-44"
              aria-label="Vista"
              value={view}
              onChange={setView}
              options={[
                { value: 'lateral', label: 'Lado' },
                { value: 'frontal', label: 'Frente' },
                { value: 'costas', label: 'Costas' },
              ]}
            />
          </>
        )}
        {!failed && (
          <Button size="sm" variant="ghost" onClick={() => setMode((m) => (m === '3d' ? '2d' : '3d'))} data-testid="visual-mode">
            {mode === '3d' ? 'Ver mapa 2D' : 'Ver em 3D'}
          </Button>
        )}
      </div>

      {demo && c && mode === '3d' && !failed && (
        <p className={cn('rounded-xl bg-secondary/60 p-2 text-sm')} data-testid="visual-cue">
          <span className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {PHASE_LABEL[c.phase]}
            {c.instruction !== null && instructions[c.instruction] ? ` · passo ${c.instruction + 1}` : ''}
          </span>
          {c.text}
        </p>
      )}
      {!demo && (
        <p className="text-xs text-muted-foreground" data-testid="visual-no-demo">
          {item.kind === 'custom'
            ? 'Exercício personalizado: o boneco mostra só os músculos que você cadastrou. Não há animação.'
            : 'Ainda não há animação para este exercício: o boneco mostra só os músculos trabalhados. Siga as instruções em texto.'}
        </p>
      )}
      {demo && <p className="text-xs text-muted-foreground">Equipamento na cena: {demo.equipment}. Demonstração ilustrativa do movimento; não mede ativação muscular.</p>}
      <MuscleLegend item={item} />
    </section>
  );
}
