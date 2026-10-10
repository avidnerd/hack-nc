/**
 * The 1€ filter (Casiez, Roussel & Vogel, CHI 2012).
 *
 * A low-pass filter whose cutoff rises with speed: a still hand is smoothed
 * hard (no jitter), a fast hand barely at all (no lag). That trade is exactly
 * what a hand-driven cutting plane needs, which is why every landmark and every
 * derived quantity in the gesture layer goes through one of these.
 */

export interface OneEuroParams {
  /** Cutoff in Hz at zero speed. Lower = smoother when still. */
  minCutoff: number;
  /** How fast the cutoff rises with speed. Higher = less lag when moving. */
  beta: number;
  /** Cutoff for the derivative estimate. */
  dCutoff: number;
}

function alpha(cutoffHz: number, dtS: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtS);
}

export class OneEuro {
  private x: number | null = null;
  private dx = 0;
  private tPrev = 0;

  constructor(private readonly p: OneEuroParams) {}

  /** Filter one sample taken at time `tMs` (milliseconds). */
  filter(value: number, tMs: number): number {
    if (this.x === null) {
      this.x = value;
      this.tPrev = tMs;
      return value;
    }
    // Duplicate timestamps happen when the video frame has not advanced; treat
    // them as one 60 Hz tick rather than dividing by zero.
    const dt = Math.max((tMs - this.tPrev) / 1000, 1 / 240);
    this.tPrev = tMs;

    const rawDx = (value - this.x) / dt;
    this.dx += alpha(this.p.dCutoff, dt) * (rawDx - this.dx);
    const cutoff = this.p.minCutoff + this.p.beta * Math.abs(this.dx);
    this.x += alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }

  reset(): void {
    this.x = null;
    this.dx = 0;
  }
}

/** A bank of independent filters for a fixed-length vector (landmarks, normals). */
export class OneEuroVec {
  private readonly fs: OneEuro[];

  constructor(n: number, p: OneEuroParams) {
    this.fs = Array.from({ length: n }, () => new OneEuro(p));
  }

  filter(values: ArrayLike<number>, tMs: number, out: number[] = []): number[] {
    for (let i = 0; i < this.fs.length; i++) out[i] = this.fs[i].filter(values[i], tMs);
    return out;
  }

  reset(): void {
    for (const f of this.fs) f.reset();
  }
}
