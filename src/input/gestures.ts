/**
 * Pose classification and the dwell state machine (§6.1).
 *
 * Pure: takes smoothed landmarks, returns poses. No DOM, no three.js, no
 * state, which is what lets vitest drive it with synthetic hands and lets the
 * recorded-demo player feed it exactly what the camera would.
 *
 * Landmark coordinates arriving here are in "image units": x mirrored so the
 * user's right is screen right, y down, both scaled by the image height so the
 * axes are isotropic; z is MediaPipe's relative depth on the same scale
 * (negative = closer to the camera).
 */

import { cross, normalize, type Vec3 } from '../coords.ts';
import { AHEAD_MIN_CONF, argmax, fuse, HandNet, NET_CLASSES, type NetOutput, type NetWeights } from './gestureNet.ts';
import type { Pose } from '../types.ts';
import { FINGERS, LM, TUNING } from './tuning.ts';

export type Pt = [number, number, number];

export type Side = 'left' | 'right';

export interface HandObs {
  side: Side;
  /** 21 smoothed landmarks in image units. */
  lm: Pt[];
  /** Palm centre as a screen fraction (0..1, mirrored), for screen mapping. */
  uv: [number, number];
  /** Index tip and pinch point as screen fractions. */
  indexUv: [number, number];
  pinchUv: [number, number];
}

/**
 * Per-hand pose, before the two-hand rules (CALIPER, two-hand zoom) apply.
 *
 * DECISION: the spec's OPEN (rotate) vs PALM (cut) split hinged on a 35 degree
 * palm tilt, which real users could not hold reliably. Any open hand now cuts,
 * and rotation moved to pinch-and-drag, the most robust pose MediaPipe reads.
 */
export type HandPose = 'OPEN' | 'PINCH' | 'POINT' | 'FIST' | 'NONE';

export interface HandFeatures {
  /** index, middle, ring, pinky. */
  ext: [boolean, boolean, boolean, boolean];
  /** Hand size: wrist to middle MCP, in image units. The depth proxy. */
  hs: number;
  /** Thumb-tip to index-tip distance over hand size. */
  pinch: number;
  /** Index tip to wrist over hand size; separates a pinch from a fist. */
  reach: number;
  /** Palm normal in view space (x right, y up, z toward the viewer), unit. */
  normal: Vec3;
  /** True when the palm (or its back) faces the camera within palmFacingDeg. */
  facing: boolean;
}

function d3(a: Pt, b: Pt): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Image units to view space: flip y (down to up) and z (away to toward). */
function toView(p: Pt): Vec3 {
  return [p[0], -p[1], -p[2]];
}

export function features(lm: Pt[]): HandFeatures {
  const wrist = lm[LM.WRIST];
  const ext = FINGERS.map(
    ([tip, mcp]) => d3(lm[tip], wrist) > TUNING.extendRatio * d3(lm[mcp], wrist),
  ) as HandFeatures['ext'];

  const hs = Math.max(d3(wrist, lm[LM.MIDDLE_MCP]), 1e-6);
  const pinch = d3(lm[LM.THUMB_TIP], lm[LM.INDEX_TIP]) / hs;
  const reach = d3(lm[LM.INDEX_TIP], wrist) / hs;

  // n = (p5 - p0) x (p17 - p0), per the spec. Its sign depends on which hand
  // and which side faces the camera; callers orient it, so only |n.z| matters.
  const w = toView(wrist);
  const a = toView(lm[LM.INDEX_MCP]);
  const b = toView(lm[LM.PINKY_MCP]);
  const normal = normalize(
    cross([a[0] - w[0], a[1] - w[1], a[2] - w[2]], [b[0] - w[0], b[1] - w[1], b[2] - w[2]]),
  );
  // DECISION: "facing the camera" is unsigned, so the back of the hand counts
  // too. Handedness labels flip with mirroring and gloves; an unsigned test
  // cannot get that wrong, and the plane normal is re-oriented anyway.
  const facing = Math.abs(normal[2]) > Math.cos((TUNING.palmFacingDeg * Math.PI) / 180);

  return { ext, hs, pinch, reach, normal, facing };
}

/** Palm centre: mean of wrist and the four MCPs. */
export function palmCenter(lm: Pt[]): Pt {
  const ids = [LM.WRIST, LM.INDEX_MCP, LM.MIDDLE_MCP, LM.RING_MCP, LM.PINKY_MCP];
  const c: Pt = [0, 0, 0];
  for (const i of ids) {
    c[0] += lm[i][0] / ids.length;
    c[1] += lm[i][1] / ids.length;
    c[2] += lm[i][2] / ids.length;
  }
  return c;
}

/**
 * One hand's instantaneous pose. `wasPinching` gives the pinch hysteresis so a
 * held pinch does not flicker at the threshold.
 */
export function classify(f: HandFeatures, wasPinching: boolean): HandPose {
  const [index, middle, ring, pinky] = f.ext;
  const extended = f.ext.filter(Boolean).length;

  const pinchLimit = wasPinching ? TUNING.pinchOff : TUNING.pinchOn;
  // DECISION: the spec asks for the other fingers curled during a pinch; we
  // only reject a pinch when all three are straight (the "OK" sign), because
  // real users rarely curl them fully and a missed pinch feels broken.
  if (f.pinch < pinchLimit && f.reach > TUNING.pinchReachMin && !(middle && ring && pinky)) {
    return 'PINCH';
  }
  if (extended === 4 && f.pinch > TUNING.openPinchMin) return 'OPEN';
  if (index && !middle && !ring && !pinky) return 'POINT';
  if (extended === 0) return 'FIST';
  return 'NONE';
}

/**
 * A candidate must persist `dwellMs` before it becomes the active value, and
 * switching requires the same dwell in the new value.
 */
export class Dwell<T> {
  active: T;
  private candidate: T;
  private since = 0;

  constructor(
    initial: T,
    private readonly dwellMs: number,
  ) {
    this.active = initial;
    this.candidate = initial;
  }

  /** `dwellMs` can be shortened per call, when a change was predicted. */
  update(value: T, tMs: number, dwellMs = this.dwellMs): T {
    if (value !== this.candidate) {
      this.candidate = value;
      this.since = tMs;
    }
    if (this.candidate !== this.active && tMs - this.since >= dwellMs) {
      this.active = this.candidate;
    }
    return this.active;
  }

  reset(value: T): void {
    this.active = value;
    this.candidate = value;
  }
}

export interface TrackedHand {
  side: Side;
  obs: HandObs;
  f: HandFeatures;
  /** Stable (dwelled) pose. */
  pose: HandPose;
  /**
   * This frame's instantaneous pose. Actions require it to agree with the
   * stable pose, so a hand mid-way into a fist stops steering the plane at
   * once instead of dragging it for the whole dwell window.
   */
  raw: HandPose;
  /** The gesture network's reading for this frame, when it is loaded. */
  net: NetOutput | null;
}

export interface GestureFrame {
  /** The app-level pose shown in the HUD and used by the controller. */
  pose: Pose;
  hands: TrackedHand[];
  left: boolean;
  right: boolean;
}

/** Order used to pick the app-level pose when two hands disagree. */
const PRIORITY: HandPose[] = ['PINCH', 'OPEN', 'FIST', 'POINT', 'NONE'];

/**
 * Turns per-frame hand observations into stable poses, per hand slot, plus the
 * two-hand CALIPER rule and the LOST timeout.
 */
export class GestureTracker {
  private readonly dwell: Record<Side, Dwell<HandPose>> = {
    left: new Dwell<HandPose>('NONE', TUNING.dwellMs),
    right: new Dwell<HandPose>('NONE', TUNING.dwellMs),
  };
  private readonly caliper = new Dwell<boolean>(false, TUNING.dwellMs);
  private readonly pinching: Record<Side, boolean> = { left: false, right: false };
  private lastSeen = -Infinity;
  private seen: Record<Side, boolean> = { left: false, right: false };
  private nets: Record<Side, HandNet> | null = null;

  /** Load (or drop) the temporal gesture network. Without it, the rules decide alone. */
  setNet(w: NetWeights | null): void {
    this.nets = w ? { left: new HandNet(w), right: new HandNet(w) } : null;
  }

  update(hands: HandObs[], tMs: number): GestureFrame {
    const tracked: TrackedHand[] = [];
    const present: Record<Side, boolean> = { left: false, right: false };

    for (const obs of hands) {
      if (present[obs.side]) continue; // two hands labelled the same: keep the first
      present[obs.side] = true;
      const f = features(obs.lm);
      if (!this.seen[obs.side]) this.nets?.[obs.side].reset();
      const rule = classify(f, this.pinching[obs.side]);
      const net = this.nets ? this.nets[obs.side].push(obs.lm, tMs) : null;
      const raw = fuse(rule, net);
      this.pinching[obs.side] = raw === 'PINCH';
      // A hand that just reappeared dwells like any other change, so a
      // half-raised hand cannot fire an action on its first frame.
      if (!this.seen[obs.side]) this.dwell[obs.side].reset('NONE');
      // Look-ahead: when the network saw this change coming, commit sooner.
      let dwell: number = TUNING.dwellMs;
      if (net) {
        const k = argmax(net.ahead);
        if (NET_CLASSES[k] === raw && net.ahead[k] >= AHEAD_MIN_CONF) dwell = TUNING.dwellPredictedMs;
      }
      const pose = this.dwell[obs.side].update(raw, tMs, dwell);
      tracked.push({ side: obs.side, obs, f, pose, raw, net });
    }
    for (const s of ['left', 'right'] as Side[]) {
      if (!present[s]) this.pinching[s] = false;
    }
    this.seen = present;

    if (tracked.length > 0) this.lastSeen = tMs;

    const bothPointing = tracked.length === 2 && tracked.every((h) => h.raw === 'POINT');
    const caliper = this.caliper.update(bothPointing, tMs);

    let pose: Pose;
    if (tracked.length === 0) {
      pose = tMs - this.lastSeen > TUNING.lostMs ? 'LOST' : 'IDLE';
    } else if (caliper && tracked.length === 2) {
      pose = 'CALIPER';
    } else {
      const best = PRIORITY.find((p) => tracked.some((h) => h.pose === p)) ?? 'NONE';
      pose = best === 'NONE' || best === 'POINT' ? 'IDLE' : best;
    }

    return { pose, hands: tracked, left: present.left, right: present.right };
  }
}

/**
 * MediaPipe's raw output (x, y, z per landmark, normalised, unmirrored camera)
 * to the mirrored, isotropic image units everything here works in. The same
 * transform hands.ts applies before filtering.
 */
export function rawToPts(raw: ArrayLike<number>, aspect: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < 21; i++) out.push([(1 - raw[i * 3]) * aspect, raw[i * 3 + 1], raw[i * 3 + 2] * aspect]);
  return out;
}
