/**
 * A procedural 21-landmark hand.
 *
 * Used by vitest to drive the gesture classifier and by
 * `scripts/make-demo.ts` to build the fallback demo stream played by `D`
 * until a real recording replaces it. Geometry is a rough adult hand in units
 * of hand size (wrist to middle MCP = 1).
 */

import { normalize, cross, type Vec3 } from '../coords.ts';
import type { Pt } from './gestures.ts';

export interface SynthOpts {
  /** Palm centre in image units (x right, y down). */
  center: [number, number];
  /** Hand size in image units. */
  size: number;
  /** Direction the fingers point, in view space (x right, y up, z toward viewer). */
  up?: Vec3;
  /** Direction the palm faces, in view space. +z = toward the camera. */
  facing?: Vec3;
  /** Which of index, middle, ring, pinky are extended. */
  ext?: [boolean, boolean, boolean, boolean];
  /** Thumb tip touching a half-bent index tip. */
  pinch?: boolean;
  /** Per-finger curl, 0 = straight, 1 = fully curled; overrides `ext`. */
  curl?: [number, number, number, number];
  /** 0..1 blend toward the pinch; overrides `pinch`. */
  pinchAmount?: number;
}

const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

// Local frame: wrist at origin, fingers along +y, palm faces +z, thumb at -x.
const MCP_X = [-0.36, -0.12, 0.12, 0.34];
const MCP_Y = [0.95, 1.0, 0.95, 0.85];
const SEG = [0.42, 0.26, 0.22];

function finger(i: number, curl: number): Vec3[] {
  const x = MCP_X[i];
  const y = MCP_Y[i];
  const len = i === 3 ? 0.75 : 1;
  const straight: Vec3[] = [
    [x, y, 0],
    [x, y + SEG[0] * len, 0],
    [x, y + (SEG[0] + SEG[1]) * len, 0],
    [x, y + (SEG[0] + SEG[1] + SEG[2]) * len, 0],
  ];
  // Curled into the palm: the tip ends up near the MCP, in front of the palm.
  const curled: Vec3[] = [
    [x, y, 0],
    [x, y + 0.3 * len, 0.18],
    [x, y + 0.12 * len, 0.36],
    [x, y - 0.05 * len, 0.3],
  ];
  return straight.map((p, j) => lerp3(p, curled[j], curl));
}

export function synthHand(o: SynthOpts): Pt[] {
  const ext = o.ext ?? [true, true, true, true];
  const curl = o.curl ?? (ext.map((e) => (e ? 0 : 1)) as [number, number, number, number]);
  const local: Vec3[] = new Array(21);
  local[0] = [0, 0, 0];
  // Thumb: CMC, MCP, IP, tip.
  local[1] = [-0.22, 0.22, 0.05];
  local[2] = [-0.42, 0.42, 0.1];
  local[3] = [-0.58, 0.6, 0.12];
  local[4] = [-0.7, 0.78, 0.14];
  for (let f = 0; f < 4; f++) {
    const pts = finger(f, curl[f]);
    for (let j = 0; j < 4; j++) local[5 + f * 4 + j] = pts[j];
  }
  const pinch = o.pinchAmount ?? (o.pinch ? 1 : 0);
  if (pinch > 0) {
    // Index half-bent forward, thumb tip meeting it.
    const target: [number, Vec3][] = [
      [6, [-0.34, 1.3, 0.12]],
      [7, [-0.3, 1.45, 0.3]],
      [8, [-0.28, 1.45, 0.45]],
      [4, [-0.33, 1.42, 0.47]],
      [3, [-0.5, 1.0, 0.35]],
    ];
    for (const [i, p] of target) local[i] = lerp3(local[i], p, pinch);
  }

  // Build the local -> view basis.
  const up = normalize(o.up ?? [0, 1, 0]);
  const facing = normalize(o.facing ?? [0, 0, 1]);
  const xAxis = normalize(cross(up, facing));
  const zAxis = normalize(cross(xAxis, up));

  // Centre the palm on o.center: the palm centre is about 0.55 up from the wrist.
  const palm: Vec3 = [0, 0.55, 0];
  return local.map((p) => {
    const q: Vec3 = [p[0] - palm[0], p[1] - palm[1], p[2] - palm[2]];
    const vx = xAxis[0] * q[0] + up[0] * q[1] + zAxis[0] * q[2];
    const vy = xAxis[1] * q[0] + up[1] * q[1] + zAxis[1] * q[2];
    const vz = xAxis[2] * q[0] + up[2] * q[1] + zAxis[2] * q[2];
    // View space to image units: y flips (up -> down), z flips (toward -> negative).
    return [o.center[0] + vx * o.size, o.center[1] - vy * o.size, -vz * o.size] as Pt;
  });
}

/**
 * Image units back to MediaPipe's raw normalised output for an unmirrored
 * camera of the given aspect (width / height), which is what the recorder
 * stores and the player feeds back in.
 */
export function toRaw(pts: Pt[], aspect: number): number[] {
  const out: number[] = [];
  for (const p of pts) out.push(1 - p[0] / aspect, p[1], p[2] / aspect);
  return out;
}
