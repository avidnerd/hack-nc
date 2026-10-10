/**
 * Plane representation and the signed-distance helpers every metric builds on.
 *
 * A plane is `dot(n, x) = d` with `n` a unit vector and `x` in world
 * millimetres. By convention the RESECTED side is `dot(n, x) - d > 0`, so the
 * normal points at the tissue being removed.
 */

import { cross, dot, normalize, sub, type Vec3 } from '../coords.ts';
import type { Plane } from '../types.ts';

export function signedDistance(plane: Plane, p: Vec3): number {
  return dot(plane.n, p) - plane.d;
}

/** True when `p` lies on the side the surgeon is removing. */
export function isResected(plane: Plane, p: Vec3): boolean {
  return signedDistance(plane, p) > 0;
}

/** Build a plane from a normal and a point it must pass through. */
export function planeThrough(n: Vec3, through: Vec3): Plane {
  const u = normalize(n);
  return { n: u, d: dot(u, through) };
}

/**
 * The palm's plane, in world millimetres.
 *
 * MediaPipe gives the wrist (0), the index MCP (5) and the pinky MCP (17);
 * those three points span the palm, so their cross product is the palm normal.
 * Handedness flips the cross product, so the normal is oriented to face away
 * from the camera and the user's palm pushes tissue away rather than pulling
 * it back.
 */
export function palmPlane(
  wrist: Vec3,
  indexMcp: Vec3,
  pinkyMcp: Vec3,
  through: Vec3,
  flip: boolean,
): Plane {
  const a = sub(indexMcp, wrist);
  const b = sub(pinkyMcp, wrist);
  let n = normalize(cross(a, b));
  if (flip) n = [-n[0], -n[1], -n[2]];
  return planeThrough(n, through);
}

/** Slide a plane along its own normal. */
export function offsetPlane(plane: Plane, mm: number): Plane {
  return { n: plane.n, d: plane.d + mm };
}

/**
 * Two orthogonal unit vectors spanning the plane, for drawing its gizmo.
 * Picks the world axis least aligned with the normal as a seed so the basis
 * never degenerates.
 */
export function planeBasis(n: Vec3): [Vec3, Vec3] {
  const ax = Math.abs(n[0]);
  const ay = Math.abs(n[1]);
  const az = Math.abs(n[2]);
  const seed: Vec3 = ax < ay && ax < az ? [1, 0, 0] : ay < az ? [0, 1, 0] : [0, 0, 1];
  const u = normalize(cross(n, seed));
  const v = normalize(cross(n, u));
  return [u, v];
}

/** Project a world point onto the plane. */
export function projectOnto(plane: Plane, p: Vec3): Vec3 {
  const s = signedDistance(plane, p);
  return [p[0] - plane.n[0] * s, p[1] - plane.n[1] * s, p[2] - plane.n[2] * s];
}

/** Are two planes the same cut, to within an angle and an offset? */
export function planesClose(a: Plane, b: Plane, degTol = 0.5, mmTol = 0.5): boolean {
  const c = dot(normalize(a.n), normalize(b.n));
  const deg = (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
  return deg <= degTol && Math.abs(a.d - b.d) <= mmTol;
}
