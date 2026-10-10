/**
 * One-dimensional flow along the centerline: continuity plus Poiseuille.
 *
 * This is a cartoon of hemodynamics, not CFD, and the README says so. With a
 * constant volumetric flow Q, continuity gives v(s) = Q / A(s) with
 * A = pi r^2, and Poiseuille gives a pressure drop per segment of
 * 8 mu ds / (pi r^4). Only ratios are reported, so Q and mu cancel.
 */

import type { Centerline } from './centerline.ts';
import { OVERSIZE } from './stent.ts';

/** A lumen narrower than this fraction of the median radius is a stenosis. */
export const STENOSIS_RATIO = 0.7;
const DS = 1; // mm

export interface FlowProfile {
  /** Arc-length positions, every 1 mm. */
  s: Float32Array;
  r: Float32Array;
  /** Velocity relative to the velocity at the median radius (1 = typical). */
  vRel: Float32Array;
  stenosis: Uint8Array;
  medianR: number;
  /** Total proximal-to-distal pressure drop; native vessel = 100. */
  dpRel: number;
}

export interface StentSpan {
  s0: number;
  lengthMm: number;
  diameterMm: number;
}

function rawProfile(cl: Centerline, stent: StentSpan | null, medianR = 0): { s: Float32Array; r: Float32Array } {
  const n = Math.max(2, Math.floor(cl.length / DS) + 1);
  const s = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const si = Math.min(i * DS, cl.length);
    s[i] = si;
    const native = cl.radiusAt(si);
    const inside = stent && si >= stent.s0 && si <= stent.s0 + stent.lengthMm;
    // A graft reopens a true narrowing (r < 0.7 x the native median) to its
    // reference lumen, nominal / (1 + oversize). Everywhere else it leaves the
    // lumen as it was: oversize buys wall apposition, and a graft neither
    // widens a healthy aorta nor straightens out its natural taper.
    const stenotic = native < STENOSIS_RATIO * medianR;
    r[i] = inside && stenotic ? Math.max(native, stent.diameterMm / 2 / (1 + OVERSIZE)) : native;
  }
  return { s, r };
}

function poiseuille(r: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < r.length; i++) sum += (8 * DS) / (Math.PI * r[i] ** 4);
  return sum;
}

export function flowProfile(cl: Centerline, stent: StentSpan | null): FlowProfile {
  const native = rawProfile(cl, null);

  // The median is the NATIVE vessel's, so a stent can relieve a stenosis but
  // never redefine what normal is.
  const sorted = Array.from(native.r).sort((a, b) => a - b);
  const medianR = sorted[sorted.length >> 1];
  const { s, r } = stent ? rawProfile(cl, stent, medianR) : native;

  const vRel = new Float32Array(r.length);
  const stenosis = new Uint8Array(r.length);
  for (let i = 0; i < r.length; i++) {
    vRel[i] = (medianR * medianR) / (r[i] * r[i]);
    stenosis[i] = r[i] < STENOSIS_RATIO * medianR ? 1 : 0;
  }

  const dpRel = (100 * poiseuille(r)) / poiseuille(native.r);
  return { s, r, vRel, stenosis, medianR, dpRel };
}

/** vRel at an arbitrary s, by nearest sample. */
export function velocityAt(f: FlowProfile, s: number): number {
  const i = Math.min(f.vRel.length - 1, Math.max(0, Math.round(s / DS)));
  return f.vRel[i];
}
