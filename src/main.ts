/**
 * Boot, the animation loop, and the single place intents are turned into state
 * changes.
 *
 * Everything else in the app is either a producer of `Intent`s (keyboard,
 * voice, gestures) or a consumer of `state` (renderer, HUD). This file is the
 * only thing that knows about both.
 */

// Self-hosted fonts (§7): bundled by Vite, so they load offline.
import '@fontsource/inter-tight/400.css';
import '@fontsource/inter-tight/500.css';
import '@fontsource/inter-tight/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import * as THREE from 'three';

import { intentFromLlm } from './ai/intentFallback.ts';
import { llmName } from './ai/llm.ts';
import {
  changeLine,
  optimizeExplanation,
  optimizeReason,
  restartReply,
  patientCallouts,
  planSummary,
  shiftReply,
  patientNarrationText,
  planMarkdown,
  type PatientFacts,
} from './ai/narrate.ts';
import { CASES, loadCase } from './caseLoader.ts';
import { cameraBasis, clamp, cross, dot, easeInOut, length, lerp, normalize, scale, slerp, sub } from './coords.ts';
import { StentSession } from './devices/stentSession.ts';
import { GestureTracker } from './input/gestures.ts';
import { HandController } from './input/handControl.ts';
import { HandInput } from './input/hands.ts';
import { fromJson as netFromJson } from './input/gestureNet.ts';
import { HeadTracker } from './input/head.ts';
import { installKeyboard } from './input/keyboard.ts';
import { installMouse, pickOnVolume } from './input/mouseFallback.ts';
import { installPwa } from './pwa.ts';
import { contextFrom, evaluatePlane, type EngineContext } from './planning/engine.ts';
import { OptimizerClient } from './planning/optimizerClient.ts';
import { planeThrough } from './planning/plane.ts';
import { PlanningGrid } from './planning/volume.ts';
import { AnatomyView } from './render/anatomy.ts';
import { Overlays } from './render/overlays.ts';
import { measureStructure } from './planning/anatomyMeasure.ts';
import { idsFor, namedCut, renalLevelCut, structureDistance, type Orientation } from './planning/smartMeasure.ts';
import { Copilot } from './copilot/copilot.ts';
import { Bench } from './copilot/bench.ts';
import { Tutorial, tutorialDone } from './tutorial/tutorial.ts';
import { makePhantom } from './tutorial/phantom.ts';
import { caseFromFiles, installDrop, pickFiles } from './io/upload.ts';
import { InfoCard } from './ui/infoCard.ts';
import { outcomes, suggestions, type AdviceFacts } from './ai/advice.ts';
import { VolumeRenderer } from './render/volumeRenderer.ts';
import {
  defaultVisibility,
  emit,
  on,
  patch,
  resetScene,
  say,
  set,
  setLoading,
  state,
  toast,
} from './state.ts';
import { Guide } from './ui/guide.ts';
import { Hud } from './ui/hud.ts';
import { parseIntent, stripWake, type Intent, type TiltDir } from './voice/intents.ts';
import { SpeechInput } from './voice/stt.ts';
import { Speech } from './voice/tts.ts';
import type { CameraState } from './state.ts';
import { OFFSET_MM, score, type OptimizeResult } from './planning/optimize.ts';
import type { CaseData, OptimizePriority, Plane, PlanMetrics, PresetName, Thresholds, Vec3 } from './types.ts';
import { askAgent } from './ai/agentClient.ts';

/* ------------------------------------------------------------------ globals */

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const renderer = new VolumeRenderer(canvas);
const hud = new Hud();
const infoCard = new InfoCard();
const guide = new Guide();
const anatomy = new AnatomyView(renderer.rig);
const overlays = new Overlays(renderer.rig, (p) => renderer.worldToScreen(p));
const stents = new StentSession(renderer.rig, (p) => renderer.worldToScreen(p));
const copilot = new Copilot({
  engine: () => engine,
  grid: () => grid,
  frame: () => renderer.frame,
  tweenCamera: (to, ms) => tweenCamera(to, ms),
  stopTweens: () => {
    camTween = null;
    planeTween = null;
  },
  showCard: (c) => infoCard.show(c),
  setPreset: (p) => setPreset(p),
  restoreStent: (st) => stents.restore(st),
  rebuildPalette: () => {
    if (state.data) renderer.buildPalette(state.data);
  },
  noteMeasured: () => guide.note('measured'),
});
const bench = new Bench(copilot.plans);

const hands = new HandInput();
const head = HeadTracker.enabled() ? new HeadTracker() : null;
const gestures = new GestureTracker();
const handControl = new HandController({
  frame: () => renderer.frame,
  pivot: () => grid?.organCentroid() ?? null,
  pick: (x, y) => pickScreen(x, y),
  ray: (x, y) => screenRay(x, y),
  setMoving: (m) => {
    renderer.moving = m;
  },
  stentHit: (x, y) => stents.hit(x, y),
  stentDrag: (x, y) => stents.drag(x, y),
  onLock: (locked) => {
    speech.tick();
    say(locked ? 'Locked.' : 'Unlocked.');
  },
});
hands.onFrame = (obs, t) => handControl.update(gestures.update(obs, t), t);

const optimizer = new OptimizerClient();
const speech = new Speech();
const stt = new SpeechInput({
  onCommand: (cmd, heard, last) => onVoice(cmd, heard, last),
  onListening: (v) => set('listening', v),
  onUnavailable: (reason) => {
    set('listening', false);
    toast(`${reason} Keyboard shortcuts still work (? for the list).`, 'bad');
  },
});

/** Plane and camera animations: every state change travels, nothing pops. */
let planeTween: { from: Plane; to: Plane; start: number; ms: number } | null = null;
let camTween: { from: CameraState; to: Partial<CameraState>; start: number; ms: number } | null = null;

/** What patient mode changed, so surgeon mode can put it back exactly. */
let surgeonView: { visible: Record<string, boolean>; dist: number } | null = null;

/** Window/level animates toward the requested preset over ~300 ms. */
const wlTween = {
  from: { w: 150, l: 30 },
  to: { w: 150, l: 30 },
  startedAt: 0,
  ms: 300,
  active: false,
};

/** The deterministic planning engine for the loaded case. */
let grid: PlanningGrid | null = null;
let engine: EngineContext | null = null;

/** Only recompute the metrics when the plane has actually moved. */
let lastPlaneKey = '';
/** Label id of the intrahepatic vessel tree (pipeline/run.py). */
const HEPATIC_TREE_ID = 8;

/* -------------------------------------------------------------------- boot */

async function boot(): Promise<void> {
  set('phase', 'loading');
  installPwa();

  const caseId = new URLSearchParams(location.search).get('case') ?? 'liver';
  await switchCase(caseId);

  installKeyboard({
    dispatch: dispatchIntent,
    playDemo: () => void playDemo(),
    teach: () => void teachGestures(),
    toggleView: () => {
      renderer.volumeVisible = !renderer.volumeVisible;
      anatomy.enabled = !renderer.volumeVisible;
      toast(renderer.volumeVisible ? 'CT volume view' : 'Anatomy view', 'info');
    },
    toggleRecorder: () => {
      const on = hands.toggleRecording();
      toast(on ? 'Recording landmarks (Shift+D to stop)' : 'Saved landmarks.json', 'info');
    },
    tutorial: () => void tutorial.open(),
    upload: () => void pickAndUpload(),
  });
  installDrop((files) => void uploadScan(files));
  installTopActions();

  installMouse(canvas, {
    setMoving: (m) => {
      renderer.moving = m;
    },
    pick: (x, y) => pickScreen(x, y),
    frame: () => renderer.frame,
  });

  set('phase', 'ready');
  hud.hideLoader();
  requestAnimationFrame(loop);

  // First visit: the gesture tutorial on the practice object, unless a case
  // was asked for in the URL or the tutorial was turned off (?tutorial=0).
  const params = new URLSearchParams(location.search);
  const t = params.get('tutorial');
  if (t === '1' || (t !== '0' && !params.has('case') && !tutorialDone())) void tutorial.open();

  // The camera prompt and model download happen after first paint, so a
  // refused camera never delays the volume.
  await loadGestureNet();
  if (params.get('hands') !== 'off') void startHands();

  await speech.init();
  on('response', (text) => speech.speak(text));
  if (params.get('voice') !== 'off') stt.start();
  console.info(`[boot] LLM: ${llmName()}`);
}

/* --------------------------------------------------- tutorial and uploads */

const tutorial = new Tutorial({
  loadPractice: () => loadCaseData(makePhantom(), 'practice'),
  finish: (choice) => {
    if (choice === 'upload') void switchCase('liver').then(() => pickAndUpload());
    else void switchCase(choice);
  },
});

async function pickAndUpload(): Promise<void> {
  const files = await pickFiles();
  if (files.length) await uploadScan(files);
}

/** Load a CT (and optional label map) from the user's own files. */
async function uploadScan(files: File[]): Promise<void> {
  let shown = '';
  try {
    const data = await caseFromFiles(files, (label) => {
      if (label !== shown) toast(`${label}…`, 'info');
      shown = label;
    });
    await loadCaseData(data, 'upload');
    const names = data.meta.labels.map((l) => l.name);
    const what =
      data.meta.kind === 'liver'
        ? 'Liver labels found: planning is on.'
        : names.length
          ? `Labels: ${names.join(', ')}.`
          : 'No labels: viewing, cutting and measuring.';
    say(`Scan loaded. ${what}`);
  } catch (err) {
    console.error('[upload]', err);
    say(err instanceof Error ? err.message : 'Could not read that file.');
  }
}

/** Two small buttons by the case name: practice again, upload a scan. */
function installTopActions(): void {
  const bar = document.createElement('div');
  bar.className = 'top-actions';
  const mk = (text: string, title: string, fn: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.title = title;
    b.addEventListener('click', fn);
    bar.append(b);
  };
  mk('Practice', 'Gesture tutorial (H)', () => void tutorial.open());
  mk('Upload CT', 'Load a .nii / .nii.gz CT, optionally with a label map (I); or drop the files anywhere', () => void pickAndUpload());
  document.body.append(bar);
}

/**
 * A de-waked utterance: regex grammar first, the LLM only if that misses.
 * The transcript stays on screen so judges can see what was heard.
 */
/**
 * Returns false only when `last` is false and the grammar did not match:
 * the recogniser then waits for the rest of the sentence before this runs
 * again (and falls back to the LLM).
 */
function onVoice(cmd: string, heard: string, last: boolean): boolean {
  state.transcriptAt = performance.now();
  set('transcript', heard);
  if (!cmd) return true; // bare wake word: the recogniser is armed for the next phrase
  const intent = parseIntent(cmd);
  if (intent) {
    dispatchIntent(intent, 'voice');
    return true;
  }
  if (!last) return false;
  void intentFromLlm(cmd).then((llm) => {
    if (llm) dispatchIntent(llm, 'llm');
    else say("Didn't catch that.");
  });
  return true;
}

/** The temporal gesture network. Optional: the rules work alone without it. */
async function loadGestureNet(): Promise<void> {
  if (new URLSearchParams(location.search).get('gnet') === 'off') return;
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}models/gesture-net.json`);
    if (!res.ok) return;
    gestures.setNet(netFromJson(await res.text()));
    console.info('[hands] gesture network loaded');
  } catch (err) {
    console.warn('[hands] gesture network unavailable, rules only', err);
  }
}

async function startHands(): Promise<void> {
  const ok = await hands.start();
  set('inputMode', ok ? 'hands' : 'mouse');
  if (ok && head && !(await head.start())) toast('Head tracking unavailable', 'info');
  if (!ok) {
    hud.banner('No camera: mouse mode. Drag to rotate, shift+drag moves the cut, ? for controls.');
    setTimeout(() => hud.banner(null), 9000);
  }
}

/**
 * Shift+G: prompt through every pose, record labelled landmarks, download
 * them. `node --experimental-transform-types scripts/train-gestures.ts --real
 * gestures-labelled.json` then fine-tunes the network on real hands.
 */
async function teachGestures(): Promise<void> {
  if (!hands.cameraOn || hands.recordingNow) {
    toast(hands.cameraOn ? 'Already recording' : 'Teaching needs the camera', 'bad');
    return;
  }
  const steps: [string, string][] = [
    ['OPEN', 'Open hand, fingers spread: turn it slowly'],
    ['PINCH', 'Pinch thumb and index: turn it slowly'],
    ['POINT', 'Point with your index finger'],
    ['FIST', 'Make a fist'],
    ['NONE', 'Anything else: relax, peace sign, claw'],
  ];
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  hands.toggleRecording('gestures-labelled.json');
  for (const [label, prompt] of steps) {
    hands.label = null;
    hud.banner(`Get ready: ${prompt}`);
    await wait(1500);
    hands.label = label;
    hud.banner(`Hold: ${prompt}  (recording ${label})`);
    await wait(5000);
  }
  hands.label = null;
  hud.banner(null);
  hands.toggleRecording('gestures-labelled.json');
  toast('Saved gestures-labelled.json: see README to fine-tune', 'good');
}

/** `D`: replay the recorded landmark stream through the gesture pipeline. */
async function playDemo(): Promise<void> {
  if (hands.playing) {
    hands.stopPlayback();
    return;
  }
  const ok = await hands.loadAndPlay();
  toast(ok ? 'Playing recorded demo (D to stop)' : 'No demo recording found', ok ? 'info' : 'bad');
}

async function switchCase(id: string): Promise<void> {
  const known = CASES.find((c) => c.id === id) ?? CASES[0];
  try {
    await loadCaseData(await loadCase(known.id), known.id);
  } catch (err) {
    console.error('[boot] case load failed', err);
    set('phase', 'error');
    state.error = String(err);
    hud.banner(
      `Could not load case "${known.id}". Run the data pipeline, or see README "Try it".`,
    );
    throw err;
  }
}

/**
 * Put any case on screen: a shipped one, an uploaded scan, or the tutorial's
 * practice object. Everything downstream sees the same CaseData either way.
 */
async function loadCaseData(data: CaseData, id: string): Promise<void> {
  if (state.mode === 'patient') exitPatientMode();
  planeTween = null;
  state.caseId = id;
  set('data', data);
  // The copilot's view of the last case (framing, focus, sections) goes with it.
  copilot.onCase();
  patch('camera', { target: [0, 0, 0] });
  set('focus', []);
  set('viewSection', false);
  set('ghostPlane', null);
  resetPlanHistory();

  // Apply the case's own defaults before the first frame is drawn.
  state.preset = data.meta.defaultPreset;
  state.windowLevel = { ...data.meta.windowPresets[state.preset] };
  state.visible = defaultVisibility(data);
  emit('visible', state.visible);
  emit('preset', state.preset);
  emit('windowLevel', state.windowLevel);

  renderer.setCase(data);
  const tex = renderer.textures();
  if (renderer.frame && tex) {
    anatomy.setCase(data, renderer.frame, tex);
    // No meshes (an old data folder): fall back to the ray-marched volume.
    renderer.volumeVisible = !anatomy.hasMeshes;
  }
  if (renderer.frame) {
    overlays.setFrame(renderer.frame);
    stents.setCase(data, renderer.frame);
  }

  // Build the planning grid: a majority-downsampled label volume plus the
  // tumour distance transform. One EDT over ~800k voxels, so it is measured
  // rather than assumed.
  setLoading('Building planning grid', 94);
  const t0 = performance.now();
  grid = new PlanningGrid(data);
  engine = contextFrom(grid);
  optimizer.setGrid(grid, engine);
  console.info(
    `[planning] ${grid.nx}x${grid.ny}x${grid.nz} grid (factor ${grid.factor}), ` +
      `${grid.organIdx.length} organ / ${grid.vesselIdx.length} vessel voxels, ` +
      `built in ${(performance.now() - t0).toFixed(0)} ms`,
  );

  // Start the cut through the middle of the organ (or of the scan, when
  // nothing is segmented) so turning the plane on always does something.
  const m = data.meta;
  const centre: Vec3 = [0, 1, 2].map((k) => m.origin[k] + ((m.shape[k] - 1) * m.spacing[k]) / 2) as Vec3;
  state.plane = { ...planeThrough([1, 0, 0], grid.organCentroid() ?? centre), on: false, locked: false };
  emit('plane', state.plane);

  lastPlaneKey = '';
  recomputeMetrics();
  hud.syncNumbers();
}

/* -------------------------------------------------------------------- loop */

let lastT = performance.now();

let loopErrors = 0;

function loop(now: number): void {
  const dt = Math.min((now - lastT) / 1000, 0.1);
  lastT = now;

  // An exception thrown anywhere in here would stop the rAF chain and leave a
  // frozen screen for the rest of the demo. Logging and carrying on is always
  // the better failure: a glitched frame beats a dead one.
  try {
    hands.tick(now);
    head?.tick(hands.videoElement, now);
    tickTweens(now);
    tickWindowLevel(now);
    recomputeMetrics();
    hud.tick();
    guide.tick();
    if (renderer.frame) {
      anatomy.update(renderer.frame, state.highlight || (state.plane.on ? renderer.proximityLabel : 0), now / 1000);
    }
    overlays.update();
    stents.update(dt);
    copilot.tick();
    bench.tick();
    renderer.render();
  } catch (err) {
    if (loopErrors++ < 5) console.error('[loop] frame failed', err);
    else if (loopErrors === 6) console.error('[loop] further frame errors suppressed');
  }

  if (import.meta.env.DEV && now - lastPerfLog > 5000) {
    lastPerfLog = now;
    const p = state.perf;
    console.info(
      `[perf] frame ${p.frameMs} ms · steps ${p.steps} · hand detect ${hands.detectMs.toFixed(1)} ms` +
        (p.optimizeMs ? ` · last optimize ${p.optimizeMs} ms` : ''),
    );
  }

  requestAnimationFrame(loop);
}

let lastPerfLog = 0;

/**
 * Re-evaluate every planning number for the current plane.
 *
 * Runs each frame but short-circuits unless the plane actually moved, so a
 * still hand costs nothing and a moving one costs well under a millisecond.
 */
function recomputeMetrics(): void {
  if (!engine) return;
  const p = state.plane;
  if (!p.on) {
    if (state.metrics !== null) set('metrics', null);
    lastPlaneKey = '';
    return;
  }
  // Quantising the key avoids recomputation from floating-point noise in the
  // hand tracker while still reacting to any movement a user could see.
  const key = `${p.n[0].toFixed(4)},${p.n[1].toFixed(4)},${p.n[2].toFixed(4)},${p.d.toFixed(2)}`;
  if (key === lastPlaneKey) return;
  lastPlaneKey = key;

  // An uploaded scan without a liver label has nothing to resect.
  if (!grid || grid.organIdx.length === 0) {
    if (state.metrics !== null) set('metrics', null);
    return;
  }
  const metrics = evaluatePlane(engine, { n: p.n, d: p.d });
  // The whole-structure glow is for named trunks (portal vein, IVC). The
  // intrahepatic tree is one label, so lighting it would light every branch;
  // the overlay marks the divided branch itself instead.
  const viewOnly = state.data?.meta.kind !== 'liver' || state.viewSection;
  renderer.proximityLabel = viewOnly || metrics.vesselId === HEPATIC_TREE_ID ? 0 : metrics.vesselId;
  set('metrics', metrics);
}

/** Animate window/level so a preset change reads as a dissolve, not a cut. */
function tickWindowLevel(now: number): void {
  if (!wlTween.active) return;
  const t = clamp((now - wlTween.startedAt) / wlTween.ms, 0, 1);
  const e = easeInOut(t);
  state.windowLevel = {
    w: lerp(wlTween.from.w, wlTween.to.w, e),
    l: lerp(wlTween.from.l, wlTween.to.l, e),
  };
  if (t >= 1) wlTween.active = false;
}

function setPreset(preset: PresetName): void {
  const meta = state.data?.meta;
  if (!meta) return;
  const target = meta.windowPresets[preset];
  if (!target) return;
  wlTween.from = { ...state.windowLevel };
  wlTween.to = { ...target };
  wlTween.startedAt = performance.now();
  wlTween.active = true;
  set('preset', preset);
  renderer.buildTransfer(target, preset);
}

/* ------------------------------------------------------------------ tweens */

function tickTweens(now: number): void {
  if (planeTween) {
    const t = clamp((now - planeTween.start) / planeTween.ms, 0, 1);
    const e = easeInOut(t);
    patch('plane', {
      n: slerp(planeTween.from.n, planeTween.to.n, e),
      d: lerp(planeTween.from.d, planeTween.to.d, e),
    });
    if (t >= 1) planeTween = null;
  }
  if (camTween) {
    const t = clamp((now - camTween.start) / camTween.ms, 0, 1);
    const e = easeInOut(t);
    const f = camTween.from;
    const to = { ...f, ...camTween.to };
    patch('camera', {
      yaw: lerp(f.yaw, to.yaw, e),
      pitch: lerp(f.pitch, to.pitch, e),
      dist: lerp(f.dist, to.dist, e),
      target: [lerp(f.target[0], to.target[0], e), lerp(f.target[1], to.target[1], e), lerp(f.target[2], to.target[2], e)],
    });
    if (t >= 1) camTween = null;
  }
}

function tweenCamera(to: Partial<CameraState>, ms = 700): void {
  camTween = { from: { ...state.camera }, to, start: performance.now(), ms };
}

/* ------------------------------------------------- cuts described by voice */

/** Put the cut at `to` by voice: animated and undoable when a cut is up, set directly otherwise. */
function placeCut(to: Plane): void {
  if (state.plane.on) movePlane(to, 700);
  else patch('plane', { n: to.n, d: to.d });
  patch('plane', { on: true });
}

function voiceCutAllowed(): boolean {
  if (!engine || !grid) return false;
  if (state.plane.locked) {
    say('The cut is locked. Say "unlock" first.');
    return false;
  }
  return true;
}

/** The point of the current cut nearest the tumour (or the organ): turns pivot there. */
function cutPivot(): Vec3 {
  const c = grid?.tumorCentroid() ?? grid?.organCentroid() ?? renderer.frame?.centerMm ?? [0, 0, 0];
  const n = state.plane.n;
  return sub(c, scale(n, dot(n, c) - state.plane.d));
}

/** Rodrigues: `v` turned by `rad` about unit `k`. */
function rotateAbout(v: Vec3, k: Vec3, rad: number): Vec3 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const kv = cross(k, v);
  const kd = dot(k, v) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd];
}

const TILT_WORD: Record<TiltDir, string> = {
  left: 'left', right: 'right', up: 'up', down: 'down',
  toward: 'toward you', away: 'away from you', clockwise: 'clockwise', counterclockwise: 'counterclockwise',
};

/**
 * "Tilt the cut 10 degrees left": as seen on screen, the cut face leans that
 * way (its normal turns toward the direction), pivoting where the cut passes
 * closest to the tumour so it stays put around the lesion.
 */
function tiltPlane(dir: TiltDir, deg: number, previewOnly: boolean): void {
  if (!state.plane.on) {
    say('Show me a cut first.');
    return;
  }
  if (!previewOnly && !voiceCutAllowed()) return;
  if (!engine) return;
  const c = state.camera;
  const { right, up, forward } = cameraBasis(c.yaw + c.headYaw, c.pitch + c.headPitch);
  const n0 = state.plane.n;
  const rad = (deg * Math.PI) / 180;
  let n: Vec3;
  if (dir === 'clockwise' || dir === 'counterclockwise') {
    // `forward` points into the screen: a positive turn about it reads clockwise.
    n = rotateAbout(n0, forward, dir === 'clockwise' ? rad : -rad);
  } else {
    const t = { left: scale(right, -1), right, up, down: scale(up, -1), toward: scale(forward, -1), away: forward }[dir];
    const axis = cross(n0, t);
    if (length(axis) < 1e-3) {
      say(`The cut already faces ${TILT_WORD[dir]}.`);
      return;
    }
    n = rotateAbout(n0, normalize(axis), rad);
  }
  n = normalize(n);
  const to: Plane = { n, d: dot(n, cutPivot()) };
  const before = evaluatePlane(engine, currentPlane(), { locate: false });
  const after = evaluatePlane(engine, to, { locate: false });
  clearPreview();
  if (previewOnly) {
    preview = { plane: to };
    set('ghostPlane', to);
    say(`Tilted ${Math.round(deg)} degrees ${TILT_WORD[dir]}: ${changeLine(before, after)}. It's outlined; say "do it" to use it.`);
    return;
  }
  movePlane(to, 500);
  say(`Tilted ${Math.round(deg)} degrees ${TILT_WORD[dir]}. ${capFirst(changeLine(before, after))}.`);
}

/** "Straighten the cut": the nearest anatomical plane, through the same pivot. */
function straightenPlane(): void {
  if (!state.plane.on) {
    say('Show me a cut first.');
    return;
  }
  if (!voiceCutAllowed() || !engine) return;
  const n0 = state.plane.n;
  const axis = [0, 1, 2].reduce((best, i) => (Math.abs(n0[i]) > Math.abs(n0[best]) ? i : best), 0);
  const n: Vec3 = [0, 0, 0];
  n[axis] = Math.sign(n0[axis]) || 1;
  const to: Plane = { n, d: dot(n, cutPivot()) };
  const before = evaluatePlane(engine, currentPlane(), { locate: false });
  const after = evaluatePlane(engine, to, { locate: false });
  movePlane(to, 500);
  say(`Straightened to ${['a sagittal', 'a coronal', 'an axial'][axis]} cut. ${capFirst(changeLine(before, after))}.`);
}

/**
 * A cut described without an anatomical plane. With `between`, halfway
 * across the closest gap between two structures, square to it, with the
 * tumour on the side removed. Otherwise oblique: facing straight away from
 * the organ's centre, `offsetMm` (default 10) clear of the structure.
 */
function describedCut(through: string | null, offsetMm: number | null, between: string | null): void {
  const data = state.data;
  if (!data || !voiceCutAllowed() || !engine || !grid) return;
  const name = (k: string) => k.replace(/_/g, ' ');
  let to: Plane;
  let where: string;
  if (between) {
    const a = through ?? 'tumor';
    const r = structureDistance(data, idsFor(data, a), idsFor(data, between), 120);
    if (!r) {
      say(`I can't find both the ${name(a)} and the ${name(between)} close enough to cut between them.`);
      return;
    }
    if (r.mm < 1) {
      say(`The ${name(a)} and the ${name(between)} touch: there is no gap to cut through.`);
      return;
    }
    // The tumour (or the first-named structure) goes on the resected side.
    const [keep, take] = between === 'tumor' ? [r.a, r.b] : [r.b, r.a];
    const n = normalize(sub(take, keep));
    const mid: Vec3 = [(r.a[0] + r.b[0]) / 2, (r.a[1] + r.b[1]) / 2, (r.a[2] + r.b[2]) / 2];
    to = { n, d: dot(n, mid) };
    where = `halfway between the ${name(a)} and the ${name(between)}, ${Math.round(r.mm / 2)} millimeters from each`;
  } else {
    const subject = through ?? 'tumor';
    if (subject !== 'tumor' || grid.tumorIdx.length === 0) {
      say('Oblique cuts are placed around the tumor. Name a plane for other structures, like "sagittal cut through the kidney".');
      return;
    }
    const tc = grid.tumorCentroid();
    const oc = grid.organCentroid();
    if (!tc || !oc) return;
    const n = normalize(sub(tc, oc));
    let tmin = Infinity;
    for (const i of grid.tumorIdx) tmin = Math.min(tmin, dot(n, grid.worldAt(i)));
    const off = offsetMm ?? 10;
    to = { n, d: tmin - off };
    where = `${Math.round(off)} millimeters from the tumor, facing away from the liver's center`;
  }
  placeCut(to);
  const m = evaluatePlane(engine, to, { locate: false });
  const nums = data.meta.kind === 'liver'
    ? m.tumorIncomplete
      ? ' Tumor not fully resected.'
      : ` Margin ${Math.round(m.marginMm)} millimeters, remnant ${Math.round(m.remnantPct)} percent${m.vesselsCrossed ? `, crosses ${m.vesselsCrossed} vessel${m.vesselsCrossed > 1 ? 's' : ''}` : ''}.`
    : '';
  say(`Cut ${where}.${nums}`);
}

function capFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* ---------------------------------------------------------------- optimize */

/** A what-if answer waiting for "do it": the outlined cut and the limits it was found under. */
let preview: { plane: Plane; marginMin?: number; remnantMin?: number } | null = null;
/** My changes to the cut (optimize, "do it", a spoken shift), newest last, for "undo". */
const planeUndo: { from: Plane; to: Plane }[] = [];
/** The last search, for "why". */
let lastOptimize: { res: OptimizeResult; th: Thresholds; priority: OptimizePriority } | null = null;

/** True when `a` and `b` are the same cut, within display precision. */
function samePlane(a: Plane, b: Plane): boolean {
  return Math.abs(a.d - b.d) < 0.5 && Math.abs(a.n[0] * b.n[0] + a.n[1] * b.n[1] + a.n[2] * b.n[2]) > 0.9999;
}

function currentPlane(): Plane {
  return { n: [...state.plane.n] as Vec3, d: state.plane.d };
}

function clearPreview(): void {
  if (!preview) return;
  preview = null;
  set('ghostPlane', null);
}

function resetPlanHistory(): void {
  clearPreview();
  planeUndo.length = 0;
  lastOptimize = null;
}

/** Animate the cut to `to`, remembering where it was for "undo". */
function movePlane(to: Plane, ms = 800): void {
  planeUndo.push({ from: currentPlane(), to });
  if (planeUndo.length > 20) planeUndo.shift();
  planeTween = { from: currentPlane(), to, start: performance.now(), ms };
}

/** How a what-if was put, for the opening of its answer. */
function askPhrase(req: Extract<Intent, { kind: 'optimize' }>, marginMin: number, remnantMin: number): string {
  const parts: string[] = [];
  if (req.marginMm !== undefined || req.widen) parts.push(`with a ${marginMin} millimeter margin`);
  if (req.remnantPct !== undefined) parts.push(`keeping ${remnantMin} percent`);
  if (req.priority === 'vessels') parts.push('sparing the vessels');
  if (req.priority === 'remnant') parts.push('keeping the most liver');
  const s = parts.length ? parts.join(' and ') : 'searching near your cut';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** True when a cut actually divides the organ (not off to one side of it). */
function throughOrgan(m: PlanMetrics): boolean {
  return m.remnantPct > 2 && m.remnantPct < 99.5;
}

async function optimizePlan(req: Extract<Intent, { kind: 'optimize' }>): Promise<void> {
  if (!engine) return;
  const mine = state.plane.on ? currentPlane() : null;
  const mineM = mine ? evaluatePlane(engine, mine, { locate: false }) : null;
  const usable = mineM !== null && throughOrgan(mineM);
  const priority: OptimizePriority = req.priority ?? 'balanced';
  let marginMin = req.marginMm ?? state.thresholds.marginMin;
  // "A bigger margin": 5 mm more than the cut has now, never below the target.
  if (req.widen) marginMin = Math.max(marginMin, Math.ceil(usable && !mineM.tumorIncomplete ? mineM.marginMm : 0) + 5);
  const remnantMin = req.remnantPct ?? state.thresholds.remnantMin;
  const th: Thresholds = { ...state.thresholds, marginMin, remnantMin, priority };
  const newLimits = marginMin !== state.thresholds.marginMin || remnantMin !== state.thresholds.remnantMin;
  // An order changes the targets for good; a what-if only borrows them.
  if (!req.preview && newLimits) {
    patch('thresholds', { marginMin, remnantMin });
    hud.syncNumbers();
  }
  clearPreview();

  // A good cut is refined where the surgeon put it. A bad one (or none, or
  // one that misses the liver) is replaced by the best cut anywhere around
  // the tumour, however far that is from where it started: the point is the
  // optimal plan, not a small nudge.
  const t0 = performance.now();
  let res: OptimizeResult | null;
  let note = '';
  let wide = false;
  if (!usable || !mine) {
    toast('Searching all around the tumor…', 'info');
    res = await optimizer.run(mine, th, 'wide');
    wide = true;
    note = mine ? "Your cut wasn't through the liver, so I searched all around the tumor." : 'There was no cut, so I searched all around the tumor.';
  } else {
    res = await optimizer.run(mine, th, 'local');
    if (res && !res.feasible) {
      toast('Searching all around the tumor…', 'info');
      const far = await optimizer.run(mine, th, 'wide');
      const quality = (r: OptimizeResult) => score(r.after, r.plane.n, r.plane.d, r.plane.n, r.plane.d, th);
      if (far && quality(far) > quality(res) + 0.5) {
        res = far;
        wide = true;
      }
    }
  }
  if (!res) {
    say(state.plane.on ? "Couldn't optimize." : 'Show me a cut first.');
    return;
  }
  const ms = performance.now() - t0;
  patch('perf', { optimizeMs: Math.round(ms) });
  console.info(`[optimize] ${res?.candidates ?? 0} candidates, search ${res?.ms.toFixed(0)} ms, round trip ${ms.toFixed(0)} ms`);
  // The search ranks on the 64^3 grid; the numbers spoken and shown come from
  // the 128^3 grid, exactly like every other number on screen.
  const before = mine ? evaluatePlane(engine, mine) : res.after;
  const after = evaluatePlane(engine, res.plane);
  lastOptimize = { res: { ...res, before, after }, th, priority };
  const moved = note !== '' || res.angleDeg >= 0.5 || res.offsetMm >= 0.5;
  const reason = () =>
    optimizeReason(res, before, after, th, {
      preview: req.preview,
      priority,
      ...(req.preview ? { ask: askPhrase(req, marginMin, remnantMin) } : {}),
    });
  const line = note
    ? restartReply(note, null, after, th, priority, req.preview === true)
    : wide
      ? `Nothing near your cut meets your targets, so I searched all around the tumor. ${reason()}`
      : reason();
  if (req.preview) {
    if (moved) {
      preview = { plane: res.plane, ...(newLimits ? { marginMin, remnantMin } : {}) };
      set('ghostPlane', res.plane);
    }
  } else {
    if (moved) placeCut(res.plane);
    if (res.feasible) speech.chord();
    toast('Planar approximation: real resections follow Couinaud segments', 'info');
  }
  say(line);
}

/** "Move the cut 5 mm closer to the tumor" (or, as a question, outline it). */
function shiftPlane(mm: number, previewOnly: boolean): void {
  if (!engine || !state.plane.on) {
    say('Show me a cut first.');
    return;
  }
  if (!previewOnly && state.plane.locked) {
    say('The cut is locked. Say "unlock" first.');
    return;
  }
  const from = currentPlane();
  // The resected side is n.x - d > 0, where the tumour is: a larger d moves
  // the cut toward it.
  const to: Plane = { n: from.n, d: from.d + mm };
  const before = evaluatePlane(engine, from, { locate: false });
  const after = evaluatePlane(engine, to, { locate: false });
  clearPreview();
  if (previewOnly) {
    preview = { plane: to };
    set('ghostPlane', to);
  } else {
    movePlane(to, 500);
  }
  say(shiftReply(mm, before, after, previewOnly));
}

function applyPreview(): void {
  const p = preview;
  if (!p || !engine) {
    say('Nothing to apply. Ask a what-if first, like "what if the margin were 15 millimeters".');
    return;
  }
  clearPreview();
  if (p.marginMin !== undefined || p.remnantMin !== undefined) {
    patch('thresholds', {
      ...(p.marginMin !== undefined ? { marginMin: p.marginMin } : {}),
      ...(p.remnantMin !== undefined ? { remnantMin: p.remnantMin } : {}),
    });
    hud.syncNumbers();
  }
  const before = evaluatePlane(engine, currentPlane(), { locate: false });
  const after = evaluatePlane(engine, p.plane, { locate: false });
  movePlane(p.plane);
  say(`Done: ${changeLine(before, after)}.`);
}

function undoPlane(): void {
  const last = planeUndo.at(-1);
  if (!last || !engine) {
    copilot.previousView();
    return;
  }
  // Undo reverses my change only while it is still the cut on screen; a cut
  // the surgeon has since moved by hand is theirs.
  if (!samePlane(last.to, planeTween?.to ?? currentPlane())) {
    planeUndo.length = 0;
    say('Nothing to undo: the cut is where you last put it.');
    return;
  }
  planeUndo.pop();
  const prev = last.from;
  clearPreview();
  const before = evaluatePlane(engine, currentPlane(), { locate: false });
  const after = evaluatePlane(engine, prev, { locate: false });
  planeTween = { from: currentPlane(), to: prev, start: performance.now(), ms: 700 };
  say(`Back to your previous cut: ${changeLine(before, after)}.`);
}

function explainPlan(about?: 'margin' | 'remnant' | 'vessels'): void {
  const m = state.metrics;
  if (!engine || !state.plane.on || !m) {
    say('There is no cut yet.');
    return;
  }
  if (about === 'vessels') {
    // What it would take to avoid them is exactly the vessels-first search.
    if (m.vesselsCrossed === 0) say('The cut crosses no vessels.');
    else void optimizePlan({ kind: 'optimize', priority: 'vessels', preview: true });
    return;
  }
  if (about) {
    say(limitAnalysis(about, m));
    return;
  }
  // "Why" is about the last optimize only while its cut is still the one on
  // screen (or on its way there).
  const shown = planeTween?.to ?? currentPlane();
  if (lastOptimize && samePlane(lastOptimize.res.plane, shown)) {
    say(optimizeExplanation(lastOptimize.res, lastOptimize.th, lastOptimize.priority));
  } else {
    say(`I haven't moved this cut. ${planSummary(m, state.thresholds)}`);
  }
}

/**
 * What bounds the margin (or the remnant) on the cut as it is: slide it 1 mm
 * at a time away from the tumour (toward it, for the remnant) and report the
 * first thing that gives, so the answer names a real trade-off.
 */
function limitAnalysis(about: 'margin' | 'remnant', m: PlanMetrics): string {
  const th = state.thresholds;
  const from = currentPlane();
  const dir = about === 'margin' ? -1 : 1;
  if (about === 'remnant' && (m.tumorIncomplete || m.marginMm < th.marginMin)) {
    return `The margin is already under your ${th.marginMin} millimeters, so the cut cannot move toward the tumor to keep more liver. A tilted cut may: say "keep more liver".`;
  }
  if (about === 'margin' && m.remnantPct < th.remnantMin) {
    return `The remnant is already under your ${th.remnantMin} percent, so the cut cannot move away from the tumor to widen the margin. A tilted cut may: say "optimize".`;
  }
  const mmWords = (k: number) => `${k} millimeter${k === 1 ? '' : 's'}`;
  const ids = (x: PlanMetrics) => new Set((x.vesselCuts ?? []).map((c) => c.id));
  const had = ids(m);
  for (let k = 1; k <= OFFSET_MM; k++) {
    const x = evaluatePlane(engine!, { n: from.n, d: from.d + dir * k }, { locate: false });
    const lead =
      about === 'margin'
        ? `The margin is the gap from the cut to the tumor's nearest edge, ${Math.round(m.marginMm)} millimeters now. Moving the cut away from the tumor widens it, but ${mmWords(k)} further`
        : `Moving the cut toward the tumor keeps more liver, but ${mmWords(k)} closer`;
    if (about === 'remnant' && (x.tumorIncomplete || x.marginMm < th.marginMin)) {
      return `${lead} the margin falls to ${Math.round(x.marginMm)} millimeters, under your ${th.marginMin}.`;
    }
    if (x.vesselsCrossed > m.vesselsCrossed) {
      const fresh = [...ids(x)].find((id) => !had.has(id));
      return `${lead} it also crosses the ${fresh ? labelName(fresh) : 'next vessel'}. A tilted cut may do better: ask "what if the margin were ${Math.round(m.marginMm) + 5}".`;
    }
    if (about === 'margin' && x.remnantPct < th.remnantMin) {
      return `${lead} the remnant drops to ${Math.round(x.remnantPct)} percent, under your ${th.remnantMin}.`;
    }
  }
  return about === 'margin'
    ? `Nothing close: the cut can move ${OFFSET_MM} millimeters further from the tumor without crossing another vessel or going under your remnant. Say "move the cut 5 millimeters away from the tumor".`
    : `Nothing close: the cut can move ${OFFSET_MM} millimeters toward the tumor and keep your margin. Say "keep more liver".`;
}

/* ----------------------------------------------------------------- measure */

function measure(what: string): void {
  const data = state.data;
  if (!data) return;
  const aortaCase = data.meta.kind === 'aorta';
  // "Measure" alone means the case's subject: the tumour, or the stent neck
  // (the aorta itself before a stent is placed).
  if (what === 'tumor' && aortaCase) what = state.stent ? 'neck' : 'aorta';
  if (what === 'neck' || what === 'stent') {
    const st = state.stent;
    if (!st) {
      say('Place a stent first.');
      return;
    }
    const neckD = st.diameterMm / 1.15;
    infoCard.show({
      kicker: 'Measure',
      title: 'Infrarenal neck',
      rows: [
        { label: 'Neck length', value: `${st.neckMm.toFixed(0)} mm`, ref: 'IFU: ≥10–15 mm', flag: st.neckMm < 10 },
        { label: 'Neck diameter (lumen)', value: `${neckD.toFixed(1)} mm`, ref: 'IFU: ~17–32 mm', flag: neckD < 17 || neckD > 32 },
        { label: 'Device diameter', value: `${st.diameterMm.toFixed(1)} mm`, ref: `${st.oversizePct.toFixed(0)} % oversize; IFU 10–20 %` },
        { label: 'Neck angulation', value: `${st.angulationDeg.toFixed(0)}°`, ref: 'IFU: ≤60°', flag: st.angulationDeg > 60 },
      ],
      notes: ['Lumen-based; outer-wall sizing reads 3–6 mm larger, so this would undersize a real device.'],
    });
    say(`Neck ${Math.round(st.neckMm)} millimeters, diameter ${Math.round(neckD)} millimeters.`);
    guide.note('measured');
    return;
  }
  const m = measureStructure(data, what);
  if (!m) {
    say(`I can't measure the ${what.replace('_', ' ')} in this case.`);
    return;
  }
  if (m.caliper) set('caliper', { a: m.caliper.a, b: m.caliper.b, mm: m.caliper.mm, label: m.title });
  guide.note('measured');
  infoCard.show({ kicker: 'Measure', title: m.title, rows: m.rows, notes: m.notes });
  say(m.speech);
}

/* ------------------------------------------------------- smart measurement */

const ORIENT_WORD = { sagittal: 'Sagittal', coronal: 'Coronal', axial: 'Axial' } as const;

/** "Make a sagittal cut 10 mm from the tumor": a named plane, animated in. */
function namedCutIntent(orientation: Orientation, through: string | null, offsetMm: number | null): void {
  const data = state.data;
  if (!data || !engine) return;
  if (state.plane.locked) {
    say('The cut is locked. Unlock it first.');
    return;
  }
  // An uploaded scan with nothing named to cut around: through its centre.
  const centred = data.meta.kind === 'scan' && !through;
  const subject = through ?? (data.meta.kind === 'aorta' ? 'aorta' : data.meta.kind === 'scan' ? 'scan' : 'tumor');
  const ctx = engine;
  const axis = orientation === 'sagittal' ? 0 : orientation === 'coronal' ? 1 : 2;
  const centre = data.meta.origin[axis] + ((data.meta.shape[axis] - 1) * data.meta.spacing[axis]) / 2;
  const plane = centred
    ? { n: [axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0] as Vec3, d: centre }
    : subject === 'renal_arteries'
      ? renalLevelCut(data)
      : namedCut(data, orientation, idsFor(data, subject), offsetMm, (pl) => evaluatePlane(ctx, pl, { locate: false, vessels: false }).remnantPct);
  if (!plane) {
    say(`No ${subject.replace('_', ' ')} in this case.`);
    return;
  }
  const from: Plane = { n: state.plane.n, d: state.plane.d };
  const flip = from.n[0] * plane.n[0] + from.n[1] * plane.n[1] + from.n[2] * plane.n[2] < -0.95;
  if (state.plane.on && !flip) planeTween = { from, to: plane, start: performance.now(), ms: 700 };
  else patch('plane', { n: plane.n, d: plane.d });
  patch('plane', { on: true });
  const m = evaluatePlane(engine, plane);
  const where =
    subject === 'renal_arteries'
      ? 'at the renal arteries'
      : offsetMm !== null
        ? `${Math.round(offsetMm)} millimeters from the ${subject.replace('_', ' ')}`
        : `through the ${subject.replace('_', ' ')}`;
  const nums = data.meta.kind === 'liver'
    ? m.tumorIncomplete
      ? ' Tumor not fully resected.'
      : ` Margin ${Math.round(m.marginMm)} millimeters, remnant ${Math.round(m.remnantPct)} percent.`
    : '';
  say(`${ORIENT_WORD[orientation]} cut ${where}.${nums}`);
}

/** "What's the margin", "how much liver is left", "which vessels does it cross". */
function queryIntent(what: 'margin' | 'remnant' | 'vessels' | 'summary'): void {
  const m = state.metrics;
  if (!state.plane.on || !m) {
    say('There is no cut yet.');
    return;
  }
  if (what === 'summary') {
    say(planSummary(m, state.thresholds));
  } else if (what === 'margin') {
    const min = state.thresholds.marginMin;
    say(
      m.tumorIncomplete
        ? 'No margin: part of the tumor is on the side that stays.'
        : `Margin ${m.marginMm.toFixed(0)} millimeters, ${m.marginMm >= min ? 'meets' : 'under'} your ${min} millimeter target.`,
    );
  } else if (what === 'remnant') {
    say(`Remnant ${Math.round(m.remnantPct)} percent. ${Math.round(m.resectedMl)} milliliters would be removed.`);
  } else {
    const names = [...new Set((m.vesselCuts ?? []).map((c) => labelName(c.id)))];
    say(m.vesselsCrossed === 0 ? 'The cut crosses no vessels of 5 millimeters or more.' : `The cut crosses ${m.vesselsCrossed}: ${names.join(', ')}.`);
  }
}

function labelName(id: number): string {
  return (state.data?.meta.labels.find((l) => l.id === id)?.name ?? 'vessel').toLowerCase();
}

/* --------------------------------------------------------------- plan note */

function writePlan(): void {
  const data = state.data;
  if (!data || !grid) return;
  const md = planMarkdown({
    caseName: data.meta.name,
    caseKind: data.meta.kind,
    structures: data.meta.labels.map((l) => l.name),
    plane: { n: state.plane.n, d: state.plane.d, on: state.plane.on },
    metrics: state.metrics,
    stent: state.stent,
    pressureDrop: state.stent ? stents.pressureDrop() : null,
    thresholds: state.thresholds,
    organMl: grid.organMl,
    tumorMl: grid.tumorMl,
    when: new Date(),
  });
  download('plan.md', md, 'text/markdown');
  if (state.plane.on) {
    download('plane.json', JSON.stringify({ n: state.plane.n, d: state.plane.d, units: 'mm' }, null, 2), 'application/json');
  }
  say('Plan written.');
}

function download(name: string, text: string, type: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ------------------------------------------------------------ patient mode */

function enterPatientMode(): void {
  const data = state.data;
  if (!data || state.mode === 'patient') return;
  surgeonView = { visible: { ...state.visible }, dist: state.camera.dist };

  // Organ of interest, tumour and device only.
  const keep = new Set<string>(['tumor']);
  if (data.meta.kind === 'liver') keep.add('liver');
  if (data.meta.kind === 'aorta') keep.add('aorta');
  const visible: Record<string, boolean> = {};
  for (const l of data.meta.labels) visible[l.key] = keep.has(l.key);
  set('visible', visible);
  set('highlight', 0);
  set('mode', 'patient');
  tweenCamera({ dist: Math.min(state.camera.dist * 1.25, 3.2) });

  const facts: PatientFacts = {
    caseKind: data.meta.kind,
    metrics: state.plane.on ? state.metrics : null,
    stent: state.stent,
    organ: data.meta.kind === 'liver' ? 'liver' : data.meta.kind === 'aorta' ? 'aorta' : 'body',
  };
  hud.setCallouts(patientCallouts(facts));
  void patientNarrationText(facts).then((text) => {
    if (state.mode === 'patient') say(text);
  });
}

function exitPatientMode(): void {
  if (state.mode !== 'patient') return;
  if (surgeonView) {
    set('visible', surgeonView.visible);
    tweenCamera({ dist: surgeonView.dist });
  }
  surgeonView = null;
  set('mode', 'surgeon');
}

/* ------------------------------------------------------------------ picking */

/** Camera ray through a screen pixel, in world mm. */
function screenRay(x: number, y: number): { o: Vec3; d: Vec3 } | null {
  const f = renderer.frame;
  if (!f) return null;
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1), renderer.camera);
  const o = ray.ray.origin;
  const d = ray.ray.direction;
  return {
    o: [o.x * f.maxExtent + f.centerMm[0], o.y * f.maxExtent + f.centerMm[1], o.z * f.maxExtent + f.centerMm[2]],
    d: normalize([d.x, d.y, d.z]),
  };
}

/** Screen pixel to a world-mm point, used by the caliper. */
function pickScreen(x: number, y: number): Vec3 | null {
  const f = renderer.frame;
  if (!f) return null;

  const ndc = new THREE.Vector2(
    (x / window.innerWidth) * 2 - 1,
    -(y / window.innerHeight) * 2 + 1,
  );
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, renderer.camera);

  // The raycaster works in object space here because the rig is untransformed;
  // convert its origin to world mm so the plane test matches the planning maths.
  const o = ray.ray.origin;
  const d = ray.ray.direction;
  const originMm: Vec3 = [
    o.x * f.maxExtent + f.centerMm[0],
    o.y * f.maxExtent + f.centerMm[1],
    o.z * f.maxExtent + f.centerMm[2],
  ];
  const dir = normalize([d.x, d.y, d.z]);
  if (!state.plane.on) {
    // Without a cut, measure on the first segmented structure under the
    // pointer: march the ray through the label volume in 1 mm steps.
    const hit = firstLabelled(originMm, dir);
    if (hit) return hit;
  }
  return pickOnVolume(f, originMm, dir, state.plane.on);
}

function firstLabelled(o: Vec3, d: Vec3): Vec3 | null {
  const data = state.data;
  if (!data) return null;
  const [nx, ny, nz] = data.meta.shape;
  const sp = data.meta.spacing;
  const org = data.meta.origin;
  const len = Math.hypot(nx * sp[0], ny * sp[1], nz * sp[2]) * 3;
  for (let t = 0; t < len; t += 1) {
    const i = Math.round((o[0] + d[0] * t - org[0]) / sp[0]);
    const j = Math.round((o[1] + d[1] * t - org[1]) / sp[1]);
    const k = Math.round((o[2] + d[2] * t - org[2]) / sp[2]);
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) continue;
    const id = data.labels[i + nx * (j + ny * k)];
    if (id !== 0 && state.visible[data.meta.labels.find((l) => l.id === id)?.key ?? ''] !== false) {
      return [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
    }
  }
  return null;
}

/* ---------------------------------------------------------------- intents */

/**
 * The one funnel every command passes through, whatever produced it. Keeping
 * this exhaustive over `Intent` means a new command cannot be added without
 * the compiler insisting it be handled.
 */
export function dispatchIntent(intent: Intent, source: 'key' | 'voice' | 'llm'): void {
  if (source !== 'key') {
    console.debug('[intent]', source, intent);
    bench.countVoice(); // keys are counted by the bench's own listener
  }

  switch (intent.kind) {
    case 'window': {
      setPreset(intent.preset);
      const names: Record<PresetName, string> = {
        soft: 'Soft tissue',
        bone: 'Bone',
        lung: 'Lung',
        liver: 'Liver',
      };
      toast(`${names[intent.preset]} window`, 'info');
      break;
    }

    case 'show': {
      const data = state.data;
      if (!data) break;
      if (intent.structure === 'all') {
        state.visible = defaultVisibility(data);
        emit('visible', state.visible);
        set('highlight', 0);
        renderer.buildPalette(data);
        break;
      }
      // Group words ("vessels", "kidneys") cover several labels.
      const group =
        intent.structure === 'vessels'
          ? data.meta.labels.filter((l) => l.role === 'vessel' && l.key !== 'aorta')
          : intent.structure === 'kidneys'
            ? data.meta.labels.filter((l) => l.key.startsWith('kidney'))
            : data.meta.labels.filter((l) => l.key === intent.structure);
      if (group.length === 0) {
        say(`No ${intent.structure.replace('_', ' ')} in this case.`);
        break;
      }
      const vis = { ...state.visible };
      for (const l of group) vis[l.key] = intent.on;
      state.visible = vis;
      emit('visible', state.visible);
      renderer.buildPalette(data);
      // Showing one structure also points at it; hiding clears any pointing.
      set('highlight', intent.on && group.length === 1 ? group[0].id : 0);
      const name = group.length === 1 ? group[0].name.toLowerCase() : intent.structure;
      toast(`${intent.on ? 'Showing' : 'Hiding'} ${name}`, 'info');
      break;
    }

    case 'plane': {
      patch('plane', { on: intent.on });
      toast(intent.on ? 'Cutting plane on' : 'Cutting plane off', 'info');
      break;
    }

    case 'lock': {
      patch('plane', { locked: intent.on });
      speech.tick();
      say(intent.on ? 'Locked.' : 'Unlocked.');
      break;
    }

    case 'reset': {
      resetPlanHistory();
      planeTween = null;
      camTween = null;
      surgeonView = null;
      resetScene();
      stents.clear();
      if (state.data) renderer.buildPalette(state.data);
      if (state.data) renderer.buildTransfer(state.windowLevel, state.preset);
      toast('Reset', 'info');
      break;
    }

    case 'mode': {
      if (intent.mode === 'patient') enterPatientMode();
      else exitPatientMode();
      break;
    }

    case 'loadCase': {
      void switchCase(intent.id);
      break;
    }

    case 'setThreshold': {
      patch('thresholds', { [intent.name]: intent.value } as never);
      const label = intent.name === 'marginMin' ? 'Margin minimum' : 'Remnant minimum';
      const unit = intent.name === 'marginMin' ? 'millimetres' : 'percent';
      say(`${label} ${intent.value} ${unit}.`);
      hud.syncNumbers();
      break;
    }

    // These land once their milestone is in. Until then they say so rather
    // than failing silently, which keeps the keyboard map honest.
    case 'placeStent':
      stents.place();
      break;

    case 'removeDevice':
      stents.remove();
      break;

    case 'nudgeStent':
      stents.nudge(intent.mm);
      break;

    case 'optimize':
      // The aorta case optimizes the stent seat; the liver case, the cut.
      if (state.data?.meta.kind === 'aorta') {
        if (state.stent) stents.optimize();
        else say('Place the stent first.');
      } else if (state.data?.meta.kind === 'scan') {
        say('Optimizing a cut needs a liver segmentation. This scan has none.');
      } else void optimizePlan(intent);
      break;

    case 'shiftPlane':
      shiftPlane(intent.mm, intent.preview === true);
      break;

    case 'applyPreview':
      applyPreview();
      break;

    case 'undo':
      undoPlane();
      break;

    case 'explain':
      explainPlan(intent.about);
      break;

    case 'measure':
      measure(intent.what);
      break;

    case 'cut':
      if (intent.orientation === 'oblique') describedCut(intent.through, intent.offsetMm, intent.between ?? null);
      else namedCutIntent(intent.orientation, intent.through, intent.offsetMm);
      break;

    case 'tiltPlane':
      tiltPlane(intent.dir, intent.deg, intent.preview === true);
      break;

    case 'straightenPlane':
      straightenPlane();
      break;

    // "How far is X from Y" gets the same view as "show me X relative to Y".
    case 'distance':
    case 'relation':
      copilot.relation(intent.a, intent.b);
      break;

    case 'nearest':
      copilot.nearest(intent.a);
      break;

    case 'focus':
      copilot.focus(intent.structure);
      break;

    case 'savePlan':
      copilot.saveBaseline();
      break;

    case 'confirm':
      // "Yes" after a what-if means "do it", unless a save is waiting.
      if (preview && !copilot.confirmPending) applyPreview();
      else copilot.confirm();
      break;

    case 'restorePlan':
      copilot.restoreBaseline();
      break;

    case 'comparePlan':
      copilot.compare();
      break;

    case 'previousView':
      copilot.previousView();
      break;

    case 'cancel':
      preview = null;
      copilot.cancel();
      break;

    case 'tutorial':
      void tutorial.open();
      break;

    case 'query':
      queryIntent(intent.what);
      break;

    case 'suggest':
    case 'outcomes': {
      const data = state.data;
      if (!data) break;
      const facts: AdviceFacts = {
        caseKind: data.meta.kind,
        planeOn: state.plane.on,
        metrics: state.metrics,
        stent: state.stent,
        thresholds: state.thresholds,
      };
      const a = intent.kind === 'suggest' ? suggestions(facts) : outcomes(facts);
      infoCard.show(a.card);
      if (intent.kind === 'outcomes') guide.note('evidence');
      say(a.speech);
      break;
    }

    case 'writePlan':
      writePlan();
      break;
  }
}

/* ------------------------------------------------------------------ wiring */

// A verdict change gets a sound as well as a sentence: a chord when the
// stent seals, a low tone when it stops sealing.
let lastSeals: boolean | null = null;
on('stent', (st) => {
  const seals = st ? st.seals : null;
  if (seals !== null && seals !== lastSeals) {
    if (seals) speech.chord();
    else speech.low();
  }
  lastSeals = seals;
});

// Keep the label palette in step with visibility changes made elsewhere.
on('visible', () => {
  if (state.data) renderer.buildPalette(state.data);
});

boot().catch((err) => console.error('[boot] failed', err));

// Expose a handle for the Playwright smoke test and for console poking.
declare global {
  interface Window {
    scrub?: {
      state: typeof state;
      renderer: VolumeRenderer;
      dispatch: typeof dispatchIntent;
      bench: Bench;
      /** Feed a transcript as if heard ("scrub, optimize"), for tests without a microphone. */
      hear: (text: string) => void;
      /** Ask the v2 agent backend (M0 check): returns the validated tool calls. */
      agent: typeof askAgent;
    };
  }
}
window.scrub = {
  state,
  renderer,
  dispatch: dispatchIntent,
  bench,
  hear: (text) => {
    const cmd = stripWake(text);
    onVoice(cmd ?? text.trim().toLowerCase(), text, true);
  },
  agent: askAgent,
};
