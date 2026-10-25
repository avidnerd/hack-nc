/**
 * The parametric stent graft: placement, sizing and seal rules (§6.4).
 *
 * The rules are a simplified version of the EVAR instructions-for-use checks
 * a vascular surgeon runs on a CT, and the README says so:
 *
 *   renal       the covered graft starts at or below the lowest renal artery
 *               (an infrarenal graft seals BELOW the renals; anything higher
 *               covers them, or the visceral arteries above them)
 *   neck length >= 10 mm of lumen within 10 % of the neck's mean diameter
 *   oversize    device diameter 10 to 20 % above the native neck
 *   angulation  < 60 degrees between centerline tangents 15 mm apart
 *
 * DECISION: rules are checked in that order (renal first) because covering a
 * renal artery is the failure a surgeon most needs to hear about, and the spec
 * leaves "first failed rule" unordered.
 *
 * DECISION: the neck is measured distally from the stent's proximal end, i.e.
 * the length of healthy, uniform aorta the seal zone actually sits on.
 *
 * A device's rule card (src/devices/deviceRules.ts, from its instructions for
 * use) can replace these limits through `Limits`: minimum neck length, the
 * oversize range (a fresh device is sized at its midpoint), the angulation
 * maximum (inclusive on a card: IFUs write "<= 60") and an optional neck
 * diameter range, checked after neck length. The Python twin is
 * backend/app/engine/stent.py.
 */

import { angleDeg } from '../coords.ts';
import type { StentState } from '../types.ts';
import type { Centerline } from './centerline.ts';

/**
 * DECISION: the device is the main body of a bifurcated graft, from its seal
 * below the renals down the infrarenal aorta. The iliac limbs are not drawn:
 * the aortic centerline stops at the bifurcation. The aorta case (MSD
 * liver_8, 1 mm slices) has ~130 mm of infrarenal aorta, so an 80 mm body
 * fits with room to drag it around.
 */
export const STENT_LENGTH_MM = 80;
/** Where a fresh stent sits when the case has no renal ostia to seat below. */
export const FALLBACK_S0 = 30;
/** A fresh stent seats this far below the lowest renal ostium. */
export const RENAL_CLEARANCE_MM = 2;
/** Neck mean diameter is taken over this proximal length. */
export const NECK_WINDOW_MM = 15;
export const OVERSIZE = 0.15;
export const RULES = {
  neckMinMm: 10,
  oversizeMinPct: 10,
  oversizeMaxPct: 20,
  angulationMaxDeg: 60,
  /** Diameter deviation that ends the neck. */
  neckDeviation: 0.1,
};

export interface Limits {
  neckMinMm: number;
  oversizeMinPct: number;
  oversizeMaxPct: number;
  angulationMaxDeg: number;
  angulationInclusive: boolean;
  neckDiameterMm: [number, number] | null;
  /** "default", or "ifu:<card id>". */
  source: string;
}

export const DEFAULT_LIMITS: Limits = {
  neckMinMm: RULES.neckMinMm,
  oversizeMinPct: RULES.oversizeMinPct,
  oversizeMaxPct: RULES.oversizeMaxPct,
  angulationMaxDeg: RULES.angulationMaxDeg,
  angulationInclusive: false,
  neckDiameterMm: null,
  source: 'default',
};

/** Fraction a fresh device is sized over the neck: the oversize range midpoint (0.15 by default). */
export function oversizeOf(lim: Limits): number {
  return (lim.oversizeMinPct + lim.oversizeMaxPct) / 200;
}

export function angulationOk(deg: number, lim: Limits): boolean {
  return lim.angulationInclusive ? deg <= lim.angulationMaxDeg : deg < lim.angulationMaxDeg;
}

export function neckDiameterOk(neckMeanMm: number, lim: Limits): boolean {
  return lim.neckDiameterMm === null || (neckMeanMm >= lim.neckDiameterMm[0] && neckMeanMm <= lim.neckDiameterMm[1]);
}

export interface Ostium {
  s: number;
  side: 'left' | 'right';
}

/** Device diameter for a stent seated at s0: 15 % over the native neck (a card's oversize midpoint). */
export function sizeAt(cl: Centerline, s0: number, lim: Limits = DEFAULT_LIMITS): number {
  return (1 + oversizeOf(lim)) * cl.meanDiameter(s0, s0 + NECK_WINDOW_MM);
}

/** Largest start position that keeps the whole stent on the centerline. */
export function maxStart(cl: Centerline, lengthMm = STENT_LENGTH_MM): number {
  return Math.max(0, cl.length - lengthMm);
}

/**
 * Evaluate a stent of a given diameter seated at s0. Pure: the same inputs
 * always produce the same verdict, which is what the tests pin.
 */
export function evaluateStent(
  cl: Centerline,
  ostia: Ostium[],
  s0: number,
  diameterMm: number,
  lengthMm = STENT_LENGTH_MM,
  lim: Limits = DEFAULT_LIMITS,
): StentState {
  const s1 = s0 + lengthMm;
  const neckMean = cl.meanDiameter(s0, s0 + NECK_WINDOW_MM);

  // Neck length: walk distally from s0 until the diameter leaves +-10 %.
  let neckMm = 0;
  for (let s = s0; s <= s1; s += 0.5) {
    const d = 2 * cl.radiusAt(s);
    if (Math.abs(d - neckMean) > RULES.neckDeviation * neckMean) break;
    neckMm = s - s0;
  }

  const oversizePct = (diameterMm / neckMean - 1) * 100;
  const angulationDeg = angleDeg(cl.tangentAt(s0), cl.tangentAt(s0 + NECK_WINDOW_MM));
  const covered = ostia.filter((o) => o.s >= s0 && o.s <= s1);
  const lowest = lowestRenal(ostia);

  let failReason: string | null = null;
  if (covered.length > 0) {
    failReason = covered.length > 1 ? 'Renal arteries covered' : `${cap(covered[0].side)} renal artery covered`;
  } else if (lowest !== null && s0 < lowest) {
    failReason = 'Above the renal arteries';
  } else if (neckMm < lim.neckMinMm) {
    failReason = `Neck too short, ${Math.round(neckMm)} millimeters`;
  } else if (!neckDiameterOk(neckMean, lim)) {
    // One decimal: whole millimetres would read "19" for an 18.6 mm neck against a 19 mm minimum.
    const [lo, hi] = lim.neckDiameterMm!;
    const side = neckMean < lo ? `below the device minimum of ${lo}` : `above the device maximum of ${hi}`;
    failReason = `Neck diameter ${Math.round(neckMean * 10) / 10} millimeters, ${side}`;
  } else if (oversizePct < lim.oversizeMinPct) {
    failReason = `Undersized, ${Math.round(oversizePct)} percent oversize`;
  } else if (oversizePct > lim.oversizeMaxPct) {
    failReason = `Oversized, ${Math.round(oversizePct)} percent`;
  } else if (!angulationOk(angulationDeg, lim)) {
    failReason = `Neck angled ${Math.round(angulationDeg)} degrees`;
  }

  return {
    s0,
    lengthMm,
    diameterMm,
    neckMm,
    neckMeanMm: neckMean,
    oversizePct,
    angulationDeg,
    seals: failReason === null,
    verdict: failReason === null ? 'Seals.' : `Won't seal: ${failReason}.`,
    failReason,
  };
}

/** Arc length of the lowest (most distal) renal ostium, or null. */
export function lowestRenal(ostia: Ostium[]): number | null {
  return ostia.length ? Math.max(...ostia.map((o) => o.s)) : null;
}

/** Where an infrarenal graft wants to start: just below the lowest renal. */
export function preferredStart(ostia: Ostium[], fallback: number): number {
  const lowest = lowestRenal(ostia);
  return lowest === null ? fallback : lowest + RENAL_CLEARANCE_MM;
}

/**
 * Where to put a fresh stent: scan every 1 mm start, size the device for each,
 * and take the sealing position closest to `preferS0`. Falls back to
 * `preferS0` (and its failing verdict) if nothing seals.
 */
export function placeStent(
  cl: Centerline,
  ostia: Ostium[],
  preferS0: number = preferredStart(ostia, 0),
  lengthMm = STENT_LENGTH_MM,
  lim: Limits = DEFAULT_LIMITS,
): StentState {
  const hi = maxStart(cl, lengthMm);
  let best: StentState | null = null;
  for (let s0 = 0; s0 <= hi; s0 += 1) {
    const st = evaluateStent(cl, ostia, s0, sizeAt(cl, s0, lim), lengthMm, lim);
    if (!st.seals) continue;
    if (!best || Math.abs(s0 - preferS0) < Math.abs(best.s0 - preferS0)) best = st;
  }
  if (best) return best;
  const s0 = Math.min(Math.max(preferS0, 0), hi);
  return evaluateStent(cl, ostia, s0, sizeAt(cl, s0, lim), lengthMm, lim);
}

/**
 * The stent half of "optimize": keep the chosen device, slide it +-40 mm in
 * 1 mm steps, and return the nearest sealing position. When none exists,
 * report the rule that failed most often across the search.
 */
export function optimizeStent(
  cl: Centerline,
  ostia: Ostium[],
  current: StentState,
  rangeMm = 40,
  lim: Limits = DEFAULT_LIMITS,
): { stent: StentState | null; movedMm: number; blocker: string | null } {
  const hi = maxStart(cl, current.lengthMm);
  const tally = new Map<string, number>();
  for (let step = 0; step <= rangeMm; step++) {
    for (const sign of step === 0 ? [1] : [-1, 1]) {
      const s0 = current.s0 + sign * step;
      if (s0 < 0 || s0 > hi) continue;
      const st = evaluateStent(cl, ostia, s0, current.diameterMm, current.lengthMm, lim);
      if (st.seals) return { stent: st, movedMm: s0 - current.s0, blocker: null };
      const key = (st.failReason ?? '').replace(/,.*$/, '');
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
  }
  let blocker: string | null = null;
  let most = 0;
  for (const [k, n] of tally) {
    if (n > most) {
      most = n;
      blocker = k;
    }
  }
  return { stent: null, movedMm: 0, blocker };
}

/** Project the renal ostia (world points) onto the centerline's arc length. */
export function ostiaOnCenterline(
  cl: Centerline,
  ostia: { p: [number, number, number]; side: 'left' | 'right' }[],
): Ostium[] {
  return ostia.map((o) => ({ s: cl.nearest(o.p).s, side: o.side }));
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
