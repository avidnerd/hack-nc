/**
 * The single source of truth. Every module reads from `state` and writes through
 * `set()` / `patch()`; the HUD, renderer and voice layer all subscribe to the
 * same event stream rather than calling each other.
 */

import type {
  CaseData,
  PlanMetrics,
  Plane,
  Pose,
  PresetName,
  StentState,
  Thresholds,
  Vec3,
  WindowLevel,
} from './types.ts';

export type Mode = 'surgeon' | 'patient';
export type InputMode = 'hands' | 'mouse';
export type Phase = 'boot' | 'loading' | 'ready' | 'error';

export interface CameraState {
  /** Radians, applied as orbit around the volume centre. */
  yaw: number;
  pitch: number;
  /** Multiples of the volume's diagonal. */
  dist: number;
  /** Head-coupled offset in radians (M8), added on top of yaw/pitch. */
  headYaw: number;
  headPitch: number;
  /**
   * Point the camera orbits and looks at, in object space (the volume centre
   * is the origin). The copilot moves it onto the anatomy it frames; manual
   * rotate and zoom then pivot around it.
   */
  target: Vec3;
}

export interface AppState {
  phase: Phase;
  /** Human-readable progress line shown on the loading screen. */
  loadingLabel: string;
  loadingPct: number;
  error: string | null;

  caseId: string;
  data: CaseData | null;

  mode: Mode;
  inputMode: InputMode;

  camera: CameraState;

  /** The cutting plane, in world mm. `on` gates the shader uniform. */
  plane: Plane & { on: boolean; locked: boolean };

  /** Current (animated) window/level actually sent to the shader. */
  windowLevel: WindowLevel;
  /** The preset the user last asked for; windowLevel tweens toward it. */
  preset: PresetName;

  /** Per-structure visibility, keyed by LabelDef.key. */
  visible: Record<string, boolean>;
  /** Label id that should pulse, or 0 for none. */
  highlight: number;
  /**
   * Structures the copilot is showing: they glow in their own colours and
   * everything else fades to a ghost. Empty for the normal view.
   */
  focus: number[];
  /**
   * The cutting plane is a viewing section placed by the copilot (to show a
   * relationship on the CT), not a resection: no liver numbers or resection
   * marks are drawn for it. Cleared as soon as the plane is moved otherwise.
   */
  viewSection: boolean;
  /** A saved plan's plane drawn as a ghost beside the current one (compare). */
  ghostPlane: Plane | null;

  metrics: PlanMetrics | null;
  /** True while a worker recomputation is in flight. */
  metricsStale: boolean;

  stent: StentState | null;
  /** Proximal-to-distal pressure drop from the 1D flow model, native = 100; null without a vessel. */
  flowDrop: number | null;

  thresholds: Thresholds;

  /** Caliper endpoints in world mm, plus the live distance. */
  /** `label` names what the caliper spans when snapping can tell. */
  caliper: { a: Vec3 | null; b: Vec3 | null; mm: number; label?: string | null };

  hands: { left: boolean; right: boolean; pose: Pose };
  /** The lead hand on screen (0..1 fractions), for the HUD cursor; null when none. */
  cursor: { x: number; y: number; pose: Pose } | null;

  /** Last heard transcript and last spoken response, for the bottom HUD line. */
  transcript: string;
  transcriptAt: number;
  response: string;
  listening: boolean;

  /** Dev instrumentation surfaced in the console and the `?` overlay. */
  perf: { frameMs: number; steps: number; optimizeMs: number; sttMs: number };

  showWebcam: boolean;
  showHelp: boolean;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  marginMin: 10,
  remnantMin: 30,
  vesselPenalty: 'hard',
};

function initialState(): AppState {
  return {
    phase: 'boot',
    loadingLabel: 'Starting',
    loadingPct: 0,
    error: null,

    caseId: 'liver',
    data: null,

    mode: 'surgeon',
    inputMode: 'mouse',

    camera: { yaw: 0.3, pitch: 0.85, dist: 1.75, headYaw: 0, headPitch: 0, target: [0, 0, 0] },

    plane: { n: [1, 0, 0], d: 0, on: false, locked: false },

    windowLevel: { w: 150, l: 30 },
    preset: 'liver',

    visible: {},
    highlight: 0,
    focus: [],
    viewSection: false,
    ghostPlane: null,

    metrics: null,
    metricsStale: false,

    stent: null,
    flowDrop: null,

    thresholds: { ...DEFAULT_THRESHOLDS },

    caliper: { a: null, b: null, mm: 0 },

    hands: { left: false, right: false, pose: 'IDLE' },
    cursor: null,

    transcript: '',
    transcriptAt: 0,
    response: '',
    listening: false,

    perf: { frameMs: 0, steps: 256, optimizeMs: 0, sttMs: 0 },

    showWebcam: true,
    showHelp: false,
  };
}

export const state: AppState = initialState();

/* ------------------------------------------------------------------ events */

/**
 * Event payloads. Keys that mirror a state field fire whenever that field is
 * written through `set`/`patch`; the rest are one-shot notifications.
 */
export interface Events {
  phase: Phase;
  loading: { label: string; pct: number };
  data: CaseData | null;
  mode: Mode;
  inputMode: InputMode;
  camera: CameraState;
  plane: AppState['plane'];
  windowLevel: WindowLevel;
  preset: PresetName;
  visible: Record<string, boolean>;
  highlight: number;
  focus: number[];
  viewSection: boolean;
  ghostPlane: Plane | null;
  metrics: PlanMetrics | null;
  stent: StentState | null;
  flowDrop: number | null;
  thresholds: Thresholds;
  caliper: AppState['caliper'];
  hands: AppState['hands'];
  cursor: AppState['cursor'];
  transcript: string;
  response: string;
  listening: boolean;
  perf: AppState['perf'];
  showWebcam: boolean;
  showHelp: boolean;
  /** Fired by `resetScene()` so modules can drop derived state. */
  reset: void;
  /** A short message for the toast stack. */
  toast: { text: string; tone: ToastTone };
}

export type ToastTone = 'info' | 'good' | 'bad';

type Handler<K extends keyof Events> = (payload: Events[K]) => void;

const listeners = new Map<keyof Events, Set<Handler<never>>>();

export function on<K extends keyof Events>(key: K, fn: Handler<K>): () => void {
  let set_ = listeners.get(key);
  if (!set_) {
    set_ = new Set();
    listeners.set(key, set_);
  }
  const bag = set_;
  bag.add(fn as unknown as Handler<never>);
  return () => {
    bag.delete(fn as unknown as Handler<never>);
  };
}

export function emit<K extends keyof Events>(key: K, payload: Events[K]): void {
  const bag = listeners.get(key);
  if (!bag) return;
  for (const fn of bag) {
    try {
      (fn as unknown as Handler<K>)(payload);
    } catch (err) {
      console.error('[state] listener threw for', String(key), err);
    }
  }
}

/* ------------------------------------------------------------- mutations */

/**
 * Write one top-level field and emit the matching event. Using this instead of
 * assigning to `state` directly is what keeps the HUD and renderer in sync.
 */
export function set<K extends keyof AppState & keyof Events>(
  key: K,
  value: AppState[K] & Events[K],
): void {
  state[key] = value;
  emit(key, value);
}

/** Merge into an object-valued field, then emit. */
export function patch<K extends keyof AppState & keyof Events>(
  key: K,
  value: Partial<AppState[K]>,
): void {
  state[key] = { ...(state[key] as object), ...(value as object) } as AppState[K];
  emit(key, state[key] as unknown as Events[K]);
}

export function setLoading(label: string, pct: number): void {
  state.loadingLabel = label;
  state.loadingPct = pct;
  emit('loading', { label, pct });
}

export function toast(text: string, tone: ToastTone = 'info'): void {
  emit('toast', { text, tone });
}

/** Record a spoken response so the HUD can echo what the voice just said. */
export function say(text: string): void {
  set('response', text);
}

/**
 * Return to the state a judge should find at the start of the demo, keeping the
 * loaded case data so a reset is instant.
 */
export function resetScene(): void {
  const fresh = initialState();
  state.mode = fresh.mode;
  state.camera = fresh.camera;
  state.plane = fresh.plane;
  state.metrics = null;
  state.stent = null;
  state.caliper = fresh.caliper;
  state.thresholds = { ...DEFAULT_THRESHOLDS };
  state.highlight = 0;
  state.focus = [];
  state.viewSection = false;
  state.ghostPlane = null;
  state.transcript = '';
  state.response = '';
  if (state.data) {
    state.preset = state.data.meta.defaultPreset;
    state.windowLevel = { ...state.data.meta.windowPresets[state.preset] };
    state.visible = defaultVisibility(state.data);
  }
  emit('reset', undefined);
  emit('mode', state.mode);
  emit('camera', state.camera);
  emit('plane', state.plane);
  emit('metrics', null);
  emit('stent', null);
  emit('caliper', state.caliper);
  emit('preset', state.preset);
  emit('windowLevel', state.windowLevel);
  emit('visible', state.visible);
  emit('highlight', 0);
  emit('focus', []);
  emit('viewSection', false);
  emit('ghostPlane', null);
}

/**
 * Everything visible except skin, which would hide the anatomy behind it.
 * The aorta case also starts without the liver's internal vessels: the stent
 * story is the aorta, the renal arteries and the kidneys, and a lit hepatic
 * tree in front of them is noise ("show vessels" brings it back).
 */
const AORTA_CASE_HIDDEN = new Set(['skin', 'hepatic_vessels', 'portal_vein']);

export function defaultVisibility(data: CaseData): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  const hidden = data.meta.kind === 'aorta' ? AORTA_CASE_HIDDEN : new Set(['skin']);
  for (const l of data.meta.labels) out[l.key] = !hidden.has(l.key);
  return out;
}
