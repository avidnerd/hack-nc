/**
 * A small temporal network that reads the hand pose from landmarks, robust to
 * the moments MediaPipe's landmarks collapse under occlusion.
 *
 * Idea credit: HoloTouch (github.com/justanotherinternetguy/HoloTouch) reads
 * poses with a one-hidden-layer MLP over pairwise joint distances. This is our
 * own implementation of that idea, extended in time:
 *
 *   input   pairwise distances between 15 key joints, in palm lengths
 *           (invariant to where the hand is, how big, how turned, which hand):
 *           3D + 2D for the current frame, plus 3D at ~100, 200, 300 ms ago
 *   output  two softmax heads: the pose NOW, and the pose ~150 ms AHEAD
 *
 * When fingers overlap and one frame's landmarks are garbage, the history taps
 * carry the decision; the look-ahead head lets the dwell timer commit early to
 * a change the network saw coming. Trained by scripts/train-gestures.ts; the
 * rule classifier remains the fallback whenever the network is unsure.
 */

import type { HandPose, Pt } from './gestures.ts';

export const NET_CLASSES: HandPose[] = ['OPEN', 'PINCH', 'POINT', 'FIST', 'NONE'];

/** Wrist, fingertips, knuckles, and the joint below each fingertip. */
const KEY = [0, 4, 8, 12, 16, 20, 5, 9, 13, 17, 3, 6, 10, 14, 18];
const PAIRS: [number, number][] = [];
for (let i = 0; i < KEY.length; i++) for (let j = i + 1; j < KEY.length; j++) PAIRS.push([KEY[i], KEY[j]]);
export const N_PAIRS = PAIRS.length; // 105

/** History taps, ms before the current frame. */
export const TAPS_MS = [100, 200, 300];
export const INPUT_SIZE = N_PAIRS * (2 + TAPS_MS.length); // 525

export interface FrameFeatures {
  d3: Float32Array;
  d2: Float32Array;
}

/** Pairwise distances in palm lengths, 3D and as seen in the picture. */
export function frameFeatures(lm: Pt[]): FrameFeatures {
  const palm3 = Math.max(Math.hypot(lm[9][0] - lm[0][0], lm[9][1] - lm[0][1], lm[9][2] - lm[0][2]), 1e-6);
  // In the picture a turned hand foreshortens its length or its width, rarely
  // both: use whichever survived.
  const palm2 = Math.max(
    Math.hypot(lm[9][0] - lm[0][0], lm[9][1] - lm[0][1]),
    1.25 * Math.hypot(lm[5][0] - lm[17][0], lm[5][1] - lm[17][1]),
    1e-6,
  );
  const d3 = new Float32Array(N_PAIRS);
  const d2 = new Float32Array(N_PAIRS);
  for (let k = 0; k < N_PAIRS; k++) {
    const a = lm[PAIRS[k][0]];
    const b = lm[PAIRS[k][1]];
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    const dz = a[2] - b[2];
    d3[k] = Math.sqrt(dx * dx + dy * dy + dz * dz) / palm3;
    d2[k] = Math.sqrt(dx * dx + dy * dy) / palm2;
  }
  return { d3, d2 };
}

/** Assemble the network input from the current frame and the history taps. */
export function assemble(now: FrameFeatures, past: (Float32Array | undefined)[], out = new Float32Array(INPUT_SIZE)): Float32Array {
  out.set(now.d3, 0);
  out.set(now.d2, N_PAIRS);
  for (let i = 0; i < TAPS_MS.length; i++) out.set(past[i] ?? now.d3, N_PAIRS * (2 + i));
  return out;
}

export interface NetWeights {
  classes: string[];
  hidden: number;
  mean: Float32Array;
  scale: Float32Array;
  /** INPUT_SIZE x hidden, row-major. */
  w1: Float32Array;
  b1: Float32Array;
  /** hidden x (2 * classes): NOW head, then AHEAD head. */
  w2: Float32Array;
  b2: Float32Array;
}

export interface NetOutput {
  now: Float32Array;
  ahead: Float32Array;
}

/** Forward pass. Exported for the trainer and the tests. */
export function forward(w: NetWeights, x: Float32Array, hiddenOut?: Float32Array): NetOutput {
  const H = w.hidden;
  const C = NET_CLASSES.length;
  const h = hiddenOut ?? new Float32Array(H);
  h.set(w.b1);
  for (let i = 0; i < INPUT_SIZE; i++) {
    const z = (x[i] - w.mean[i]) / w.scale[i];
    if (z === 0) continue;
    const row = i * H;
    for (let j = 0; j < H; j++) h[j] += z * w.w1[row + j];
  }
  for (let j = 0; j < H; j++) if (h[j] < 0) h[j] = 0;
  const logits = new Float32Array(2 * C);
  logits.set(w.b2);
  for (let j = 0; j < H; j++) {
    if (h[j] === 0) continue;
    const row = j * 2 * C;
    for (let k = 0; k < 2 * C; k++) logits[k] += h[j] * w.w2[row + k];
  }
  return { now: softmax(logits.subarray(0, C)), ahead: softmax(logits.subarray(C)) };
}

function softmax(z: Float32Array): Float32Array {
  let m = -Infinity;
  for (const v of z) m = Math.max(m, v);
  const out = new Float32Array(z.length);
  let s = 0;
  for (let i = 0; i < z.length; i++) s += out[i] = Math.exp(z[i] - m);
  for (let i = 0; i < z.length; i++) out[i] /= s;
  return out;
}

/* ------------------------------------------------------------ serialisation */

interface NetJson {
  classes: string[];
  hidden: number;
  taps: number[];
  /** base64 float32 arrays */
  mean: string;
  scale: string;
  w1: string;
  b1: string;
  w2: string;
  b2: string;
  /** How it was trained and how it scored, for the README. */
  report?: unknown;
}

function f32ToB64(a: Float32Array): string {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function b64ToF32(s: string): Float32Array {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

export function toJson(w: NetWeights, report?: unknown): string {
  const j: NetJson = {
    classes: w.classes,
    hidden: w.hidden,
    taps: TAPS_MS,
    mean: f32ToB64(w.mean),
    scale: f32ToB64(w.scale),
    w1: f32ToB64(w.w1),
    b1: f32ToB64(w.b1),
    w2: f32ToB64(w.w2),
    b2: f32ToB64(w.b2),
    report,
  };
  return JSON.stringify(j);
}

export function fromJson(text: string): NetWeights {
  const j = JSON.parse(text) as NetJson;
  if (j.classes.join() !== NET_CLASSES.join() || j.taps.join() !== TAPS_MS.join()) {
    throw new Error('gesture-net.json was trained for different classes or taps');
  }
  return {
    classes: j.classes,
    hidden: j.hidden,
    mean: b64ToF32(j.mean),
    scale: b64ToF32(j.scale),
    w1: b64ToF32(j.w1),
    b1: b64ToF32(j.b1),
    w2: b64ToF32(j.w2),
    b2: b64ToF32(j.b2),
  };
}

/* ------------------------------------------------------------- per-hand use */

/** Confidence the NOW head needs before it overrides the rules. */
export const NET_MIN_CONF = 0.65;
/** Confidence the AHEAD head needs to shorten the dwell for a change. */
export const AHEAD_MIN_CONF = 0.75;

/**
 * One hand's rolling history and latest reading. The GestureTracker keeps one
 * per hand slot and resets it when the hand is lost.
 */
export class HandNet {
  private hist: { t: number; d3: Float32Array }[] = [];
  private x = new Float32Array(INPUT_SIZE);
  private h: Float32Array;
  last: NetOutput | null = null;

  constructor(private readonly w: NetWeights) {
    this.h = new Float32Array(w.hidden);
  }

  push(lm: Pt[], tMs: number): NetOutput {
    const f = frameFeatures(lm);
    const past = TAPS_MS.map((dt) => this.at(tMs - dt));
    assemble(f, past, this.x);
    this.hist.push({ t: tMs, d3: f.d3 });
    while (this.hist.length > 0 && tMs - this.hist[0].t > TAPS_MS[TAPS_MS.length - 1] + 120) this.hist.shift();
    this.last = forward(this.w, this.x, this.h);
    return this.last;
  }

  reset(): void {
    this.hist = [];
    this.last = null;
  }

  /** The stored frame closest to time t, or undefined with no history. */
  private at(t: number): Float32Array | undefined {
    let best: Float32Array | undefined;
    let bestDt = Infinity;
    for (const e of this.hist) {
      const dt = Math.abs(e.t - t);
      if (dt < bestDt) {
        bestDt = dt;
        best = e.d3;
      }
    }
    return best;
  }
}

export function argmax(p: Float32Array): number {
  let b = 0;
  for (let i = 1; i < p.length; i++) if (p[i] > p[b]) b = i;
  return b;
}

/** Fuse: the network when it is confident, the rules otherwise. */
export function fuse(rule: HandPose, out: NetOutput | null): HandPose {
  if (!out) return rule;
  const k = argmax(out.now);
  return out.now[k] >= NET_MIN_CONF ? NET_CLASSES[k] : rule;
}
