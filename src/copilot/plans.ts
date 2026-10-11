/**
 * Saved planning views: "Scrub, save this plan", "show me the original
 * plan", "compare this cut to the original", "go back to the previous view".
 *
 * A snapshot is everything needed to reproduce a view and its numbers: the
 * plane, camera, visible structures, highlight and focus, measurement,
 * thresholds, window and device. Restoring it puts the same plane back
 * through the same deterministic engine, so the numbers come back identical.
 *
 * The comparison is pure arithmetic over two `PlanMetrics` from the engine;
 * the sentence it produces states changes, never a judgement ("safer",
 * "better").
 */

import { angleDeg } from '../coords.ts';
import type { AppState, CameraState } from '../state.ts';
import type { PlanMetrics, Plane, PresetName, StentState, Thresholds, Vec3 } from '../types.ts';

export interface PlanSnapshot {
  caseId: string;
  plane: AppState['plane'];
  camera: CameraState;
  visible: Record<string, boolean>;
  highlight: number;
  focus: number[];
  viewSection: boolean;
  caliper: AppState['caliper'];
  thresholds: Thresholds;
  preset: PresetName;
  stent: StentState | null;
  savedAt: number;
}

/** A deep copy of the parts of state a view consists of. */
export function snapshot(s: AppState): PlanSnapshot {
  return structuredClone({
    caseId: s.caseId,
    plane: s.plane,
    camera: s.camera,
    visible: s.visible,
    highlight: s.highlight,
    focus: s.focus,
    viewSection: s.viewSection,
    caliper: s.caliper,
    thresholds: s.thresholds,
    preset: s.preset,
    stent: s.stent,
    savedAt: Date.now(),
  });
}

/**
 * The baseline ("original plan") per case plus a short history of views to
 * step back through. The baseline is never replaced without an explicit
 * confirmation within `confirmMs`.
 */
export class PlanStore {
  private baselines = new Map<string, PlanSnapshot>();
  private history: PlanSnapshot[] = [];
  private pending: { snap: PlanSnapshot; until: number } | null = null;

  constructor(
    private readonly confirmMs = 10_000,
    private readonly maxHistory = 20,
  ) {}

  baseline(caseId: string): PlanSnapshot | null {
    return this.baselines.get(caseId) ?? null;
  }

  /**
   * Save `snap` as the baseline. Returns 'saved', or 'confirm' when a
   * baseline already exists: the snapshot is held until confirm() or expiry.
   */
  save(snap: PlanSnapshot, now = Date.now()): 'saved' | 'confirm' {
    if (this.baselines.has(snap.caseId)) {
      this.pending = { snap, until: now + this.confirmMs };
      return 'confirm';
    }
    this.baselines.set(snap.caseId, snap);
    return 'saved';
  }

  /** Replace the baseline with the held snapshot; false if nothing is held. */
  confirm(now = Date.now()): boolean {
    const p = this.pending;
    this.pending = null;
    if (!p || now > p.until) return false;
    this.baselines.set(p.snap.caseId, p.snap);
    return true;
  }

  /** True while an overwrite waits for "confirm". */
  hasPending(now = Date.now()): boolean {
    return this.pending !== null && now <= this.pending.until;
  }

  /** Drop a held overwrite (cancel). */
  cancelPending(): boolean {
    const had = this.pending !== null;
    this.pending = null;
    return had;
  }

  pushView(snap: PlanSnapshot): void {
    this.history.push(snap);
    if (this.history.length > this.maxHistory) this.history.shift();
  }

  popView(caseId: string): PlanSnapshot | null {
    while (this.history.length) {
      const s = this.history.pop()!;
      if (s.caseId === caseId) return s;
    }
    return null;
  }

  clearHistory(): void {
    this.history = [];
  }
}

/* -------------------------------------------------------------- compare */

export interface PlanSide {
  plane: Plane;
  metrics: PlanMetrics;
}

export interface Comparison {
  remnantPts: number;
  marginMm: number;
  resectedMl: number;
  vessels: number;
  /** Angle between the two plane normals, degrees. */
  angleDeg: number;
  /** How far the plane moved along its normal at `anchor`, mm (signed). */
  shiftMm: number;
  /** Either side leaves tumour behind, so a margin delta would mislead. */
  marginComparable: boolean;
}

/** Signed distance of `p` from a plane. */
function sd(p: Vec3, pl: Plane): number {
  return pl.n[0] * p[0] + pl.n[1] * p[1] + pl.n[2] * p[2] - pl.d;
}

/**
 * Current minus baseline. `anchor` (the tumour or organ centroid) is where
 * the shift is measured: how much nearer to or further from it the cut sits.
 */
export function comparePlans(base: PlanSide, cur: PlanSide, anchor: Vec3): Comparison {
  return {
    remnantPts: cur.metrics.remnantPct - base.metrics.remnantPct,
    marginMm: cur.metrics.marginMm - base.metrics.marginMm,
    resectedMl: cur.metrics.resectedMl - base.metrics.resectedMl,
    vessels: cur.metrics.vesselsCrossed - base.metrics.vesselsCrossed,
    angleDeg: angleDeg(base.plane.n, cur.plane.n),
    shiftMm: Math.abs(sd(anchor, cur.plane)) - Math.abs(sd(anchor, base.plane)),
    marginComparable: !base.metrics.tumorIncomplete && !cur.metrics.tumorIncomplete,
  };
}

const r1 = (x: number) => Math.abs(x).toFixed(1);

/** One factual sentence: what changed, with no judgement attached. */
export function comparisonSentence(c: Comparison): string {
  const parts: string[] = [];
  parts.push(
    Math.abs(c.remnantPts) < 0.05
      ? 'keeps the same liver remnant'
      : `keeps ${r1(c.remnantPts)} percentage points ${c.remnantPts > 0 ? 'more' : 'less'} liver`,
  );
  if (!c.marginComparable) parts.push('leaves tumor on the kept side in one of the two plans, so the margins are not comparable');
  else if (Math.abs(c.marginMm) < 0.05) parts.push('has the same measured margin');
  else parts.push(`changes the measured margin by ${c.marginMm > 0 ? 'plus' : 'minus'} ${r1(c.marginMm)} millimeters`);
  const v = Math.abs(c.vessels);
  parts.push(
    c.vessels === 0
      ? 'intersects the same number of segmented vessel components'
      : `intersects ${v} ${c.vessels > 0 ? 'more' : 'fewer'} segmented vessel component${v === 1 ? '' : 's'}`,
  );
  const last = parts.pop();
  return `Compared with the saved plan, the current plane ${parts.join(', ')}, and ${last}.`;
}
