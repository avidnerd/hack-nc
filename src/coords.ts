/**
 * The three coordinate systems in Scrub+ and the maps between them.
 *
 *   voxel   integer grid index (i, j, k), 0..shape-1
 *   world   millimetres, `origin + index * spacing`. All planning maths,
 *           every number on screen, and the centerlines live here.
 *   object  the renderer's box, centred on 0 and scaled so the longest
 *           physical axis is 1 unit. Keeps the volume visually proportional
 *           without making the camera depend on patient size.
 *
 * Keeping these conversions in one file is what lets the gesture layer hand a
 * plane to both the shader and the planning engine and have them agree.
 */

import type { CaseMeta, Plane, Vec3 } from './types.ts';

// Re-exported so the planning modules can take their vector type from the
// same place they take the vector maths.
export type { Vec3 };

export interface Frame {
  shape: Vec3;
  spacing: Vec3;
  origin: Vec3;
  /** Physical size of the whole grid in mm, `shape * spacing`. */
  extent: Vec3;
  /** The longest physical axis in mm; the object-space unit. */
  maxExtent: Vec3[0];
  /** Object-space half-size of the box, `extent / (2 * maxExtent)`. */
  half: Vec3;
  /** World-mm centre of the grid. */
  centerMm: Vec3;
}

export function makeFrame(meta: CaseMeta): Frame {
  const extent: Vec3 = [
    meta.shape[0] * meta.spacing[0],
    meta.shape[1] * meta.spacing[1],
    meta.shape[2] * meta.spacing[2],
  ];
  const maxExtent = Math.max(extent[0], extent[1], extent[2]);
  return {
    shape: [...meta.shape] as Vec3,
    spacing: [...meta.spacing] as Vec3,
    origin: [...meta.origin] as Vec3,
    extent,
    maxExtent,
    half: [
      extent[0] / (2 * maxExtent),
      extent[1] / (2 * maxExtent),
      extent[2] / (2 * maxExtent),
    ],
    centerMm: [
      meta.origin[0] + extent[0] / 2,
      meta.origin[1] + extent[1] / 2,
      meta.origin[2] + extent[2] / 2,
    ],
  };
}

export function worldToObject(f: Frame, p: Vec3): Vec3 {
  return [
    (p[0] - f.centerMm[0]) / f.maxExtent,
    (p[1] - f.centerMm[1]) / f.maxExtent,
    (p[2] - f.centerMm[2]) / f.maxExtent,
  ];
}

export function objectToWorld(f: Frame, p: Vec3): Vec3 {
  return [
    p[0] * f.maxExtent + f.centerMm[0],
    p[1] * f.maxExtent + f.centerMm[1],
    p[2] * f.maxExtent + f.centerMm[2],
  ];
}

export function voxelToWorld(f: Frame, i: number, j: number, k: number): Vec3 {
  return [
    f.origin[0] + i * f.spacing[0],
    f.origin[1] + j * f.spacing[1],
    f.origin[2] + k * f.spacing[2],
  ];
}

/**
 * Re-express a world-mm plane in the renderer's object space.
 *
 * world:   dot(n, x) = d,  with x = o * maxExtent + center
 *      =>  dot(n * maxExtent, o) = d - dot(n, center)
 *
 * The scale is uniform across axes, so the normal stays parallel and only its
 * length changes; the shader divides by that length where it needs a true
 * distance.
 */
export function planeToObject(f: Frame, plane: Plane): { n: Vec3; d: number } {
  const n: Vec3 = [
    plane.n[0] * f.maxExtent,
    plane.n[1] * f.maxExtent,
    plane.n[2] * f.maxExtent,
  ];
  const d = plane.d - dot(plane.n, f.centerMm);
  return { n, d };
}

/* ------------------------------------------------------------ vector maths */

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function length(a: Vec3): number {
  return Math.sqrt(dot(a, a));
}

export function dist(a: Vec3, b: Vec3): number {
  return length(sub(a, b));
}

export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
}

/** Angle between two vectors in degrees. */
export function angleDeg(a: Vec3, b: Vec3): number {
  const c = dot(normalize(a), normalize(b));
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Smooth ease-in-out used by every state transition in the app. */
export function easeInOut(t: number): number {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/**
 * Where the orbit camera sits for a given yaw/pitch, as a unit direction from
 * the volume centre. The orbit axis is the patient's head-foot axis (+z,
 * superior), so yaw 0 / pitch 0 is a standard anterior view: patient upright,
 * facing the viewer, their right on the viewer's left.
 */
export function cameraDir(yaw: number, pitch: number): Vec3 {
  return [Math.cos(pitch) * Math.sin(yaw), Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch)];
}

/** Screen up in world space: the patient's superior direction. */
export const CAMERA_UP: Vec3 = [0, 0, 1];

/** The orbit camera's world-space basis, matching how the renderer places it. */
export function cameraBasis(yaw: number, pitch: number): { right: Vec3; up: Vec3; forward: Vec3 } {
  const forward = scale(cameraDir(yaw, pitch), -1);
  const right = normalize(cross(forward, CAMERA_UP));
  return { right, up: cross(right, forward), forward };
}

/** Rotate `v` by the shortest-arc rotation that takes unit `a` onto unit `b`. */
export function rotateBetween(a: Vec3, b: Vec3, v: Vec3): Vec3 {
  const axis = cross(a, b);
  const s = length(axis);
  const c = clamp(dot(a, b), -1, 1);
  if (s < 1e-9) return c > 0 ? v : scale(v, -1);
  const k = scale(axis, 1 / s);
  // Rodrigues: v cos + (k x v) sin + k (k.v)(1 - cos)
  const kv = cross(k, v);
  const kdv = dot(k, v);
  return [
    v[0] * c + kv[0] * s + k[0] * kdv * (1 - c),
    v[1] * c + kv[1] * s + k[1] * kdv * (1 - c),
    v[2] * c + kv[2] * s + k[2] * kdv * (1 - c),
  ];
}

/** Shortest-arc interpolation between two unit vectors. */
export function slerp(a: Vec3, b: Vec3, t: number): Vec3 {
  const na = normalize(a);
  const nb = normalize(b);
  const c = clamp(dot(na, nb), -1, 1);
  const omega = Math.acos(c);
  if (omega < 1e-5) return na;
  const s = Math.sin(omega);
  const wa = Math.sin((1 - t) * omega) / s;
  const wb = Math.sin(t * omega) / s;
  return normalize([
    na[0] * wa + nb[0] * wb,
    na[1] * wa + nb[1] * wb,
    na[2] * wa + nb[2] * wb,
  ]);
}
