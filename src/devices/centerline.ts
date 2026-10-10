/**
 * A vessel centerline parameterised by arc length.
 *
 * The pipeline resamples the aorta's skeleton every ~2 mm and stores the lumen
 * radius at each point; this class turns those samples into continuous
 * functions of s in [0, L] by linear interpolation. s = 0 is the proximal
 * (cranial) end, which is the end a stent's seal zone faces.
 */

import { dist, normalize, type Vec3 } from '../coords.ts';
import type { CenterlinePoint } from '../types.ts';

export class Centerline {
  readonly pts: CenterlinePoint[];
  /** Cumulative arc length at each sample, mm. */
  readonly s: Float64Array;
  readonly length: number;

  constructor(points: CenterlinePoint[]) {
    if (points.length < 2) throw new Error('centerline needs at least two points');
    this.pts = points;
    this.s = new Float64Array(points.length);
    for (let i = 1; i < points.length; i++) {
      this.s[i] = this.s[i - 1] + dist(points[i].p, points[i - 1].p);
    }
    this.length = this.s[points.length - 1];
  }

  /** Sample index i and fraction t such that s lies between samples i and i+1. */
  private locate(s: number): [number, number] {
    const n = this.pts.length;
    if (s <= 0) return [0, 0];
    if (s >= this.length) return [n - 2, 1];
    // Binary search; at most ~500 samples, but this runs per particle per frame.
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.s[mid] <= s) lo = mid;
      else hi = mid;
    }
    const span = this.s[lo + 1] - this.s[lo];
    return [lo, span > 0 ? (s - this.s[lo]) / span : 0];
  }

  pointAt(s: number): Vec3 {
    const [i, t] = this.locate(s);
    const a = this.pts[i].p;
    const b = this.pts[i + 1].p;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }

  radiusAt(s: number): number {
    const [i, t] = this.locate(s);
    return this.pts[i].r + (this.pts[i + 1].r - this.pts[i].r) * t;
  }

  tangentAt(s: number): Vec3 {
    const [i, t] = this.locate(s);
    const a = this.pts[i].t;
    const b = this.pts[i + 1].t;
    return normalize([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
  }

  /** Nearest sample to a world point, by brute force over the samples. */
  nearest(p: Vec3): { s: number; index: number; distMm: number } {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < this.pts.length; i++) {
      const d = dist(this.pts[i].p, p);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return { s: this.s[best], index: best, distMm: bestD };
  }

  /** Mean lumen diameter over [a, b], sampled every 1 mm. */
  meanDiameter(a: number, b: number): number {
    const lo = Math.max(0, Math.min(a, b));
    const hi = Math.min(this.length, Math.max(a, b));
    let sum = 0;
    let n = 0;
    for (let s = lo; s <= hi + 1e-9; s += 1) {
      sum += 2 * this.radiusAt(s);
      n++;
    }
    return n > 0 ? sum / n : 2 * this.radiusAt(lo);
  }
}
