import { useEffect, useRef } from 'react';
import {
  AmbientLight,
  BoxGeometry,
  BufferGeometry,
  CapsuleGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  Material,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Quaternion,
  Scene,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  BODY,
  NEUTRAL_POSE,
  PART_SHAPES,
  SEGMENTS,
  SIDES,
  apply,
  axisOf,
  cueAt,
  poseAt,
  rotX,
  solvePose,
  type Demo,
  type Emphasis,
  type MusclePart,
  type Prop,
  type Segment,
  type SolvedPose,
  type Vec3,
} from '@/modules/exercises/demos';
import { MUSCLE_COLORS } from './colors';

// Humanoide 3D (P20, docs/ANIMACOES_EXERCICIOS.md). Modelo próprio `irontrack-humanoid-v1`, montado aqui com formas
// simples (cápsulas e elipsoides) sobre o esqueleto puro de src/modules/exercises/demos/rig.ts — sem arquivos de modelo,
// texturas ou animações de terceiros e sem rede. three.js (MIT) só é carregado com este arquivo (import sob demanda).
// Economia no celular: um único renderizador por vez, desenho só quando algo muda (animação tocando, giro ou zoom),
// densidade de pixels limitada a 1,5, pausa fora da tela ou com a aba escondida e liberação total da GPU ao fechar.

export type HumanoidView = 'lateral' | 'frontal' | 'costas';

export interface HumanoidProps {
  demo: Demo | null;
  emphasis: ReadonlyMap<MusclePart, Emphasis>;
  view: HumanoidView;
  playing: boolean;
  speed: number;
  loop: boolean;
  /** Muda para recomeçar o ciclo do início. */
  restartToken: number;
  label: string;
  /** Índice do texto sincronizado (demo.cues) — chamado só quando muda. */
  onCue?: (index: number) => void;
  /** Fim do ciclo com `loop` desligado. */
  onEnded?: () => void;
  /** WebGL indisponível ou contexto perdido: quem usa troca para o mapa 2D. */
  onFail: (reason: string) => void;
}

const MAX_PIXEL_RATIO = 1.5;
const v3 = (v: Vec3) => new Vector3(v[0], v[1], v[2]);

interface Built {
  segments: Record<Segment, Group>;
  dynamicProps: { prop: Prop; obj: Group }[];
}

function ellipsoid(geo: SphereGeometry, mat: Material, center: Vec3, radii: Vec3, tilt = 0): Mesh {
  const m = new Mesh(geo, mat);
  m.position.set(center[0], center[1], center[2]);
  m.scale.set(radii[0], radii[1], radii[2]);
  if (tilt) m.rotation.x = (tilt * Math.PI) / 180;
  return m;
}

function capsule(geo: Map<string, BufferGeometry>, mat: Material, radius: number, length: number, centerY: number): Mesh {
  const key = `c${radius}:${length}`;
  let g = geo.get(key);
  if (!g) {
    g = new CapsuleGeometry(radius, Math.max(0.01, length - radius), 6, 14);
    geo.set(key, g);
  }
  const m = new Mesh(g, mat);
  m.position.y = centerY;
  return m;
}

function cylinderX(geo: Map<string, BufferGeometry>, mat: Material, radius: number, length: number): Mesh {
  const key = `y${radius}:${length}`;
  let g = geo.get(key);
  if (!g) {
    g = new CylinderGeometry(radius, radius, length, 18);
    geo.set(key, g);
  }
  const m = new Mesh(g, mat);
  m.rotation.z = Math.PI / 2;
  return m;
}

/** Monta corpo, músculos e equipamento. Tudo que é criado entra em `geo`/`mats` para ser liberado ao desmontar. */
function build(scene: Scene, demo: Demo | null, emphasis: ReadonlyMap<MusclePart, Emphasis>, geo: Map<string, BufferGeometry>, mats: Material[]): Built {
  const mat = (color: string, roughness = 0.7, metalness = 0) => {
    const m = new MeshStandardMaterial({ color: new Color(color), roughness, metalness });
    mats.push(m);
    return m;
  };
  const skin = mat(MUSCLE_COLORS.body, 0.8);
  const muscleMat = { neutral: mat(MUSCLE_COLORS.neutral, 0.75), primary: mat(MUSCLE_COLORS.primary, 0.55), secondary: mat(MUSCLE_COLORS.secondary, 0.6) };
  const face = mat('#64748b');
  const pad = mat('#334155', 0.9);
  const frame = mat('#475569', 0.5, 0.3);
  const steel = mat('#9ca3af', 0.35, 0.8);
  const plate = mat('#1f2937', 0.6, 0.2);
  const sphere = new SphereGeometry(1, 22, 16);
  geo.set('sphere', sphere);

  const segments = {} as Record<Segment, Group>;
  for (const s of SEGMENTS) {
    const g = new Group();
    g.name = s;
    segments[s] = g;
    scene.add(g);
  }
  // Tronco e cabeça (sistema local: +Y para cima ao longo do segmento, +Z para a frente).
  segments.pelvis.add(ellipsoid(sphere, skin, [0, -0.03, 0], [0.155, 0.1, 0.11]));
  segments.abdomen.add(ellipsoid(sphere, skin, [0, 0.11, 0], [0.135, 0.14, 0.1]));
  segments.chest.add(ellipsoid(sphere, skin, [0, 0.15, 0], [0.175, 0.17, 0.115]));
  const neck = capsule(geo, skin, 0.05, 0.08, 0.03);
  segments.head.add(neck);
  segments.head.add(ellipsoid(sphere, skin, [0, 0.15, 0.01], [0.085, 0.11, 0.1]));
  // Nariz: mostra para onde a pessoa está olhando.
  segments.head.add(ellipsoid(sphere, face, [0, 0.14, 0.105], [0.016, 0.022, 0.02]));
  for (const side of SIDES) {
    segments[`upperArm${side}`].add(ellipsoid(sphere, skin, [0, 0, 0], [0.06, 0.06, 0.06]));
    segments[`upperArm${side}`].add(capsule(geo, skin, 0.047, BODY.upperArm, -BODY.upperArm / 2));
    segments[`forearm${side}`].add(capsule(geo, skin, 0.04, BODY.forearm, -BODY.forearm / 2));
    segments[`forearm${side}`].add(ellipsoid(sphere, skin, [0, -BODY.forearm - 0.015, 0], [0.035, 0.05, 0.025]));
    segments[`thigh${side}`].add(capsule(geo, skin, 0.075, BODY.thigh, -BODY.thigh / 2));
    segments[`shin${side}`].add(capsule(geo, skin, 0.052, BODY.shin, -BODY.shin / 2));
    segments[`foot${side}`].add(ellipsoid(sphere, skin, [0, -0.045, 0.06], [0.045, 0.035, 0.125]));
  }
  // Músculos: todos desenhados (neutros em cinza) e os do exercício em vermelho (principal) ou laranja (secundário).
  for (const sh of PART_SHAPES) {
    const e = emphasis.get(sh.part);
    const m = ellipsoid(sphere, e ? muscleMat[e] : muscleMat.neutral, sh.center, [sh.radii[0] * 1.1, sh.radii[1] * 1.08, sh.radii[2] * 1.25], sh.tilt);
    m.name = `muscle:${sh.part}`;
    segments[sh.segment as Segment].add(m);
  }

  // Equipamento.
  const dynamicProps: Built['dynamicProps'] = [];
  for (const p of demo?.props ?? []) {
    const obj = new Group();
    scene.add(obj);
    if (p.kind === 'box') {
      const g = new BoxGeometry(p.size[0], p.size[1], p.size[2]);
      geo.set(`box:${p.id}`, g);
      const m = new Mesh(g, p.tone === 'frame' ? frame : pad);
      obj.position.set(p.center[0], p.center[1], p.center[2]);
      obj.rotation.x = ((p.tiltX ?? 0) * Math.PI) / 180;
      obj.add(m);
      continue;
    }
    if (p.kind === 'barbell') {
      const len = p.length ?? 1.6;
      obj.add(cylinderX(geo, steel, 0.014, len));
      if (p.plates) for (const k of [-1, 1]) {
        const pl = cylinderX(geo, plate, 0.17, 0.045);
        pl.position.x = k * (len / 2 - 0.16);
        obj.add(pl);
      }
    } else if (p.kind === 'dumbbell') {
      const h = new Group();
      h.add(cylinderX(geo, steel, 0.016, 0.16));
      for (const k of [-1, 1]) {
        const w = cylinderX(geo, plate, 0.055, 0.05);
        w.position.x = k * 0.09;
        h.add(w);
      }
      if (p.axis === 'z') h.rotation.y = Math.PI / 2;
      obj.add(h);
    } else if (p.kind === 'handle') {
      obj.add(cylinderX(geo, steel, 0.016, p.width));
    } else if (p.kind === 'cable') {
      const g = new CylinderGeometry(0.005, 0.005, 1, 6);
      geo.set(`cable:${dynamicProps.length}`, g);
      obj.add(new Mesh(g, frame));
    } else if (p.kind === 'platform') {
      const g = new BoxGeometry(p.size[0], p.size[1], p.size[2]);
      geo.set('platform', g);
      obj.add(new Mesh(g, frame));
      obj.rotation.x = (p.tiltX * Math.PI) / 180;
    } else if (p.kind === 'shinPad') {
      obj.add(cylinderX(geo, pad, 0.05, 0.42));
    }
    dynamicProps.push({ prop: p, obj });
  }

  const floor = new Mesh(new CircleGeometry(1.4, 48), mat('#94a3b8', 1));
  geo.set('floor', floor.geometry);
  (floor.material as MeshStandardMaterial).transparent = true;
  (floor.material as MeshStandardMaterial).opacity = 0.25;
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.001;
  scene.add(floor);
  return { segments, dynamicProps };
}

const tmpM = new Matrix4();
const up = new Vector3(0, 1, 0);

/** Posiciona segmentos e equipamento na pose resolvida. */
function place(b: Built, s: SolvedPose) {
  for (const seg of SEGMENTS) {
    const f = s.frames[seg];
    const g = b.segments[seg];
    g.position.set(f.origin[0], f.origin[1], f.origin[2]);
    tmpM.makeBasis(v3(axisOf(f.rot, 0)), v3(axisOf(f.rot, 1)), v3(axisOf(f.rot, 2)));
    g.quaternion.setFromRotationMatrix(tmpM);
  }
  const hands = v3(s.arms.L.end).add(v3(s.arms.R.end)).multiplyScalar(0.5);
  const ankles = v3(s.legs.L.end).add(v3(s.legs.R.end)).multiplyScalar(0.5);
  for (const { prop: p, obj } of b.dynamicProps) {
    if (p.kind === 'barbell' || p.kind === 'handle') obj.position.copy(hands);
    else if (p.kind === 'dumbbell') obj.position.copy(v3(s.arms[p.side].end));
    else if (p.kind === 'cable') {
      const from = v3(p.from);
      const to = p.to === 'hands' ? hands : v3(s.arms[p.to === 'handL' ? 'L' : 'R'].end);
      const d = to.clone().sub(from);
      obj.position.copy(from).addScaledVector(d, 0.5);
      obj.quaternion.copy(new Quaternion().setFromUnitVectors(up, d.clone().normalize()));
      obj.scale.set(1, d.length(), 1);
    } else if (p.kind === 'platform') {
      const n = apply(rotX(p.tiltX), [0, 1, 0]);
      obj.position.copy(ankles).addScaledVector(v3(n), BODY.ankleHeight + p.size[1] / 2);
    } else if (p.kind === 'shinPad') {
      const z = p.side === 'front' ? 0.075 : -0.075;
      const pts = SIDES.map((k) => {
        const f = s.frames[`shin${k}`];
        return v3(f.origin).add(v3(apply(f.rot, [0, -BODY.shin + 0.06, z])));
      });
      obj.position.copy(pts[0]).add(pts[1]).multiplyScalar(0.5);
    }
  }
}

/** Câmera de cada vista (deslocamento a partir do foco). A lateral é levemente elevada e girada para o equipamento do
 * lado de cá (anilhas, halteres) não esconder braços e pernas. */
const CAMERA: Record<HumanoidView, Vec3> = { lateral: [-2.95, 0.95, 0.95], frontal: [0.45, 0.45, 3.25], costas: [-0.45, 0.45, -3.25] };

export default function Humanoid3D(props: HumanoidProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const live = useRef(props);
  live.current = props;
  const api = useRef<{ setView: (v: HumanoidView) => void; kick: () => void; restart: () => void } | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    } catch (e) {
      live.current.onFail(e instanceof Error ? e.message : 'WebGL indisponível');
      return;
    }
    const { demo, emphasis } = live.current;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    const canvas = renderer.domElement;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', live.current.label);
    canvas.dataset.testid = 'humanoid-canvas';
    canvas.style.touchAction = 'none';
    host.appendChild(canvas);

    const scene = new Scene();
    scene.add(new HemisphereLight('#ffffff', '#64748b', 1.6));
    scene.add(new AmbientLight('#ffffff', 0.35));
    const sun = new DirectionalLight('#ffffff', 1.6);
    sun.position.set(-2, 4, 3);
    scene.add(sun);
    const geo = new Map<string, BufferGeometry>();
    const mats: Material[] = [];
    const built = build(scene, demo, emphasis, geo, mats);

    const focus = v3(demo?.focus ?? [0, 0.9, 0]);
    const camera = new PerspectiveCamera(35, 1, 0.05, 30);
    const controls = new OrbitControls(camera, canvas);
    controls.enablePan = false;
    controls.minDistance = 1.4;
    controls.maxDistance = 6;
    controls.target.copy(focus);

    let phase = 0;
    let lastCue = -1;
    let raf = 0;
    let last = 0;
    let visible = true;
    let disposed = false;

    const pose = (ph: number) => (demo ? poseAt(demo, ph) : NEUTRAL_POSE);
    const draw = () => {
      if (disposed) return;
      place(built, solvePose(pose(phase)));
      renderer.render(scene, camera);
      if (demo) {
        const c = cueAt(demo, phase);
        const i = c ? demo.cues.indexOf(c) : -1;
        if (i !== lastCue) {
          lastCue = i;
          live.current.onCue?.(i);
        }
      }
    };
    const animating = () => !!demo && demo.kind === 'animated' && live.current.playing && visible && document.visibilityState === 'visible';
    const tick = (t: number) => {
      raf = 0;
      if (!animating() || !demo) return;
      const dt = last ? Math.min(0.1, (t - last) / 1000) : 0;
      last = t;
      phase += (dt * live.current.speed) / demo.cycleSec;
      if (phase >= 1) {
        if (live.current.loop) phase %= 1;
        else {
          phase = 0;
          draw();
          live.current.onEnded?.();
          return;
        }
      }
      draw();
      raf = requestAnimationFrame(tick);
    };
    const kick = () => {
      if (animating()) {
        if (!raf) {
          last = 0;
          raf = requestAnimationFrame(tick);
        }
      } else draw();
    };
    const setView = (v: HumanoidView) => {
      const off = CAMERA[v];
      camera.position.set(focus.x + off[0], focus.y + off[1], focus.z + off[2]);
      controls.update();
      draw();
    };
    api.current = { setView, kick, restart: () => ((phase = 0), (lastCue = -1), kick()) };

    const resize = () => {
      const w = host.clientWidth || 300;
      const h = host.clientHeight || 300;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      draw();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    const io = new IntersectionObserver((es) => {
      visible = es.some((e) => e.isIntersecting);
      kick();
    });
    io.observe(host);
    const onVis = () => kick();
    document.addEventListener('visibilitychange', onVis);
    controls.addEventListener('change', () => {
      if (!raf) draw();
    });
    const onLost = (e: Event) => {
      e.preventDefault();
      live.current.onFail('Contexto WebGL perdido');
    };
    canvas.addEventListener('webglcontextlost', onLost);

    setView(live.current.view);
    resize();
    kick();

    return () => {
      disposed = true;
      api.current = null;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      canvas.removeEventListener('webglcontextlost', onLost);
      controls.dispose();
      for (const g of geo.values()) g.dispose();
      for (const m of mats) m.dispose();
      scene.clear();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    };
    // O componente é remontado (key) quando a demonstração ou os músculos mudam; o resto é lido de `live`.
  }, []);

  useEffect(() => api.current?.setView(props.view), [props.view]);
  useEffect(() => api.current?.kick(), [props.playing, props.speed, props.loop]);
  useEffect(() => {
    if (props.restartToken) api.current?.restart();
  }, [props.restartToken]);

  return <div ref={hostRef} className="h-full w-full [&>canvas]:block [&>canvas]:h-full [&>canvas]:w-full" />;
}
