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
  optimizeReason,
  patientCallouts,
  patientNarrationText,
  planMarkdown,
  type PatientFacts,
} from './ai/narrate.ts';
import { CASES, loadCase } from './caseLoader.ts';
import { clamp, easeInOut, lerp, normalize, slerp } from './coords.ts';
import { StentSession } from './devices/stentSession.ts';
import { GestureTracker } from './input/gestures.ts';
import { HandController } from './input/handControl.ts';
import { HandInput } from './input/hands.ts';
import { fromJson as netFromJson } from './input/gestureNet.ts';
import { HeadTracker } from './input/head.ts';
import { installKeyboard } from './input/keyboard.ts';
import { installMouse, pickOnVolume } from './input/mouseFallback.ts';
import { contextFrom, evaluatePlane, type EngineContext } from './planning/engine.ts';
import { OptimizerClient } from './planning/optimizerClient.ts';
import { planeThrough } from './planning/plane.ts';
import { PlanningGrid } from './planning/volume.ts';
import { AnatomyView } from './render/anatomy.ts';
import { Overlays } from './render/overlays.ts';
import { measureStructure } from './planning/anatomyMeasure.ts';
import { idsFor, namedCut, renalLevelCut, structureDistance, type Orientation } from './planning/smartMeasure.ts';
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
import { parseIntent, type Intent } from './voice/intents.ts';
import { SpeechInput } from './voice/stt.ts';
import { Speech } from './voice/tts.ts';
import type { CameraState } from './state.ts';
import type { Plane, PresetName, Vec3 } from './types.ts';

/* ------------------------------------------------------------------ globals */

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const renderer = new VolumeRenderer(canvas);
const hud = new Hud();
const infoCard = new InfoCard();
const guide = new Guide();
const anatomy = new AnatomyView(renderer.rig);
const overlays = new Overlays(renderer.rig, (p) => renderer.worldToScreen(p));
const stents = new StentSession(renderer.rig, (p) => renderer.worldToScreen(p));

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
  onCommand: (cmd, heard) => void onVoice(cmd, heard),
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
  });

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

  // The camera prompt and model download happen after first paint, so a
  // refused camera never delays the volume.
  const params = new URLSearchParams(location.search);
  await loadGestureNet();
  if (params.get('hands') !== 'off') void startHands();

  await speech.init();
  on('response', (text) => speech.speak(text));
  if (params.get('voice') !== 'off') stt.start();
  console.info(`[boot] LLM: ${llmName()}`);
}

/**
 * A de-waked utterance: regex grammar first, the LLM only if that misses.
 * The transcript stays on screen so judges can see what was heard.
 */
async function onVoice(cmd: string, heard: string): Promise<void> {
  state.transcriptAt = performance.now();
  set('transcript', heard);
  if (!cmd) return; // bare wake word: the recogniser is armed for the next phrase
  const intent = parseIntent(cmd) ?? (await intentFromLlm(cmd));
  if (intent) dispatchIntent(intent, parseIntent(cmd) ? 'voice' : 'llm');
  else say("Didn't catch that.");
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
  if (state.mode === 'patient') exitPatientMode();
  planeTween = null;
  try {
    const data = await loadCase(known.id);
    state.caseId = known.id;
    set('data', data);

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

    // Start the cut through the middle of the organ so turning the plane on
    // always does something visible.
    const centroid = grid.organCentroid();
    if (centroid) {
      state.plane = { ...planeThrough([1, 0, 0], centroid), on: false, locked: false };
      emit('plane', state.plane);
    }

    lastPlaneKey = '';
    recomputeMetrics();
    hud.syncNumbers();
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

  const metrics = evaluatePlane(engine, { n: p.n, d: p.d });
  // The whole-structure glow is for named trunks (portal vein, IVC). The
  // intrahepatic tree is one label, so lighting it would light every branch;
  // the overlay marks the divided branch itself instead.
  const viewOnly = state.data?.meta.kind === 'aorta';
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
    });
    if (t >= 1) camTween = null;
  }
}

function tweenCamera(to: Partial<CameraState>, ms = 700): void {
  camTween = { from: { ...state.camera }, to, start: performance.now(), ms };
}

/* ---------------------------------------------------------------- optimize */

async function optimizePlan(): Promise<void> {
  if (!engine || !state.plane.on) {
    say('Show me a cut first.');
    return;
  }
  const start: Plane = { n: [...state.plane.n] as Vec3, d: state.plane.d };
  const t0 = performance.now();
  const res = await optimizer.run(start, state.thresholds);
  const ms = performance.now() - t0;
  patch('perf', { optimizeMs: Math.round(ms) });
  console.info(`[optimize] ${res?.candidates ?? 0} candidates, search ${res?.ms.toFixed(0)} ms, round trip ${ms.toFixed(0)} ms`);
  if (!res) {
    say("Couldn't optimize.");
    return;
  }
  // The search ranks on the 64^3 grid; the numbers spoken and shown come from
  // the 128^3 grid, exactly like every other number on screen.
  const before = evaluatePlane(engine, start);
  const after = evaluatePlane(engine, res.plane);
  planeTween = { from: start, to: res.plane, start: performance.now(), ms: 800 };
  const line = optimizeReason(res, before, after, state.thresholds);
  if (res.feasible) speech.chord();
  say(line);
  toast('Planar approximation: real resections follow Couinaud segments', 'info');
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
  const subject = through ?? (data.meta.kind === 'aorta' ? 'aorta' : 'tumor');
  const ctx = engine;
  const plane =
    subject === 'renal_arteries'
      ? renalLevelCut(data)
      : namedCut(data, orientation, idsFor(data, subject), offsetMm, (pl) => evaluatePlane(ctx, pl, false).remnantPct);
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

/** "How far is the tumor from the portal vein": closest wall-to-wall gap. */
function distanceIntent(a: string, b: string): void {
  const data = state.data;
  if (!data) return;
  const aIds = idsFor(data, a);
  const bIds = idsFor(data, b);
  // Speak a single structure by its label name ("inferior vena cava"), a
  // group by its word ("vessels").
  const name = (k: string) => {
    const ids = idsFor(data, k);
    return ids.length === 1 ? labelName(ids[0]) : k.replace('_', ' ');
  };
  if (!aIds.length || !bIds.length) {
    say(`No ${name(aIds.length ? b : a)} in this case.`);
    return;
  }
  const r = structureDistance(data, aIds, bIds);
  if (!r) {
    say(`The ${name(a)} and the ${name(b)} are more than 6 centimeters apart.`);
    return;
  }
  const label = `${cap(name(a))} ↔ ${name(b)}`;
  set('caliper', { a: r.a, b: r.b, mm: r.mm, label });
  const vesselish = /vein|vessel|ivc|aorta|portal/.test(a + b) && /tumor/.test(a + b);
  infoCard.show({
    kicker: 'Measure',
    title: label,
    rows: [{ label: 'Closest wall-to-wall gap', value: r.touching ? 'in contact' : `${r.mm.toFixed(1)} mm` }],
    notes: [
      'Closest points marked. Edge to edge on the segmentation grid (±1 voxel).',
      ...(vesselish
        ? [
            r.mm < state.thresholds.marginMin
              ? `Closer than your ${state.thresholds.marginMin} mm margin target: on this side the margin cannot reach it without taking the vessel.`
              : `Beyond your ${state.thresholds.marginMin} mm margin target, so it does not limit the margin.`,
          ]
        : []),
    ],
  });
  guide.note('measured');
  const mm = Math.round(r.mm);
  say(r.touching ? `The ${name(a)} touches the ${name(b)}.` : `The ${name(a)} is ${mm} millimeter${mm === 1 ? '' : 's'} from the ${name(b)}.`);
}

/** "What's the margin", "how much liver is left", "which vessels does it cross". */
function queryIntent(what: 'margin' | 'remnant' | 'vessels'): void {
  const m = state.metrics;
  if (!state.plane.on || !m) {
    say('There is no cut yet.');
    return;
  }
  if (what === 'margin') {
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

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
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
    organ: data.meta.kind === 'liver' ? 'liver' : 'aorta',
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
  if (source !== 'key') console.debug('[intent]', source, intent);

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
      } else void optimizePlan();
      break;

    case 'measure':
      measure(intent.what);
      break;

    case 'cut':
      namedCutIntent(intent.orientation, intent.through, intent.offsetMm);
      break;

    case 'distance':
      distanceIntent(intent.a, intent.b);
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
    };
  }
}
window.scrub = { state, renderer, dispatch: dispatchIntent };
