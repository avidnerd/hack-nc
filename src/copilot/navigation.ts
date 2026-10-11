/**
 * Automatic camera navigation: given the anatomy a request is about, find a
 * view that actually shows it.
 *
 *   frameView     orbit target on the region of interest (not the volume
 *                 centre), a distance that fits every point of interest in
 *                 the frustum with padding, and an orientation that sees a
 *                 relationship side-on (the measurement line perpendicular to
 *                 the view, so its length reads true), chosen as the smallest
 *                 turn from where the camera already is
 *   sectionFacing a cutting plane through the relationship that faces the
 *                 camera, so the CT section shows both structures and the gap
 *                 when surface meshes would hide it
 *
 * Pure geometry in the renderer's object space (volume centre at the origin,
 * same axes as world mm, uniformly scaled), so it generalises to any pair of
 * structures and is unit-tested without a GPU.
 */

import { CAMERA_UP, cameraDir, clamp, cross, dot, normalize } from '../coords.ts';
import type { CameraState } from '../state.ts';
import type { Plane, Vec3 } from '../types.ts';

export type View = Pick<CameraState, 'yaw' | 'pitch' | 'dist' | 'target'>;

export interface FrameOptions {
  /** Vertical field of view, degrees (the renderer uses 42). */
  fovDeg: number;
  /** Viewport width / height. */
  aspect: number;
  /** Where the camera is now; the new view turns as little as possible. */
  current: Pick<CameraState, 'yaw' | 'pitch'>;
  /** See this direction side-on (perpendicular to the view), e.g. a gap. */
  sideOn?: Vec3;
  /** Breathing room around the points of interest. */
  pad?: number;
  /** Never closer than this (object units). */
  minDist?: number;
}

/** Pitch is kept off the poles, where the up vector degenerates. */
export const MAX_PITCH = 1.25;

/** Yaw and pitch of a unit direction from the target toward the camera. */
export function yawPitchOf(dir: Vec3): { yaw: number; pitch: number } {
  return { yaw: Math.atan2(dir[0], dir[1]), pitch: Math.asin(clamp(dir[2], -1, 1)) };
}

/** Frame `points` (object space). */
export function frameView(points: Vec3[], o: FrameOptions): View {
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], p[k]);
      hi[k] = Math.max(hi[k], p[k]);
    }
  }
  const target: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  let radius = 0;
  for (const p of points) radius = Math.max(radius, Math.hypot(p[0] - target[0], p[1] - target[1], p[2] - target[2]));
  radius = Math.max(radius, 0.02);

  // Orientation: keep the current direction unless a relationship should be
  // seen side-on; then drop the component along it (smallest turn that puts
  // the segment across the screen).
  let dir = cameraDir(o.current.yaw, o.current.pitch);
  if (o.sideOn) {
    const u = normalize(o.sideOn);
    const along = dot(dir, u);
    let perp: Vec3 = [dir[0] - u[0] * along, dir[1] - u[1] * along, dir[2] - u[2] * along];
    // Looking straight down the segment: any perpendicular will do; prefer
    // one with the patient's head up the screen.
    if (Math.hypot(...perp) < 1e-3) perp = cross(u, CAMERA_UP);
    if (Math.hypot(...perp) < 1e-3) perp = cross(u, [1, 0, 0]);
    dir = normalize(perp);
  }
  const yp = yawPitchOf(dir);
  const pitch = clamp(yp.pitch, -MAX_PITCH, MAX_PITCH);

  const vHalf = ((o.fovDeg * Math.PI) / 180) / 2;
  const hHalf = Math.atan(Math.tan(vHalf) * o.aspect);
  const half = Math.min(vHalf, hHalf);
  const dist = Math.max(o.minDist ?? 0.18, (radius * (o.pad ?? 1.3)) / Math.sin(half));
  return { yaw: yp.yaw, pitch, dist, target };
}

/**
 * True when every point projects inside the viewport (with `margin` of the
 * half-width spare) for a camera at `view`. Used by the tests and as a
 * sanity check: the framing must not clip what it was asked to show.
 */
export function allVisible(view: View, points: Vec3[], fovDeg: number, aspect: number, margin = 0.02): boolean {
  const back = cameraDir(view.yaw, view.pitch);
  const forward: Vec3 = [-back[0], -back[1], -back[2]];
  const right = normalize(cross(forward, CAMERA_UP));
  const up = cross(right, forward);
  const eye: Vec3 = [view.target[0] + back[0] * view.dist, view.target[1] + back[1] * view.dist, view.target[2] + back[2] * view.dist];
  const tv = Math.tan(((fovDeg * Math.PI) / 180) / 2);
  const th = tv * aspect;
  return points.every((p) => {
    const q: Vec3 = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
    const z = dot(q, forward);
    if (z <= 0.01) return false;
    return Math.abs(dot(q, right) / z) <= th * (1 - margin) && Math.abs(dot(q, up) / z) <= tv * (1 - margin);
  });
}

/** A cutting plane (world mm) through point `p`, facing the camera at `view`. */
export function sectionThrough(p: Vec3, view: View): Plane {
  const n = cameraDir(view.yaw, view.pitch);
  return { n, d: dot(n, p) };
}

/**
 * A cutting plane (world mm) through the segment a-b that faces the camera at
 * `view`: the near side is cut away, so the CT section shows both endpoints.
 */
export function sectionFacing(a: Vec3, b: Vec3, view: View): Plane {
  // Object and world space share axes, so the view direction carries over.
  const back = cameraDir(view.yaw, view.pitch);
  const u = normalize([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
  const along = dot(back, u);
  let n: Vec3 = [back[0] - u[0] * along, back[1] - u[1] * along, back[2] - u[2] * along];
  if (Math.hypot(...n) < 1e-6) n = cross(u, CAMERA_UP);
  n = normalize(n);
  const mid: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  return { n, d: dot(n, mid) };
}
