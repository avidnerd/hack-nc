/**
 * The plane optimizer (§6.5).
 *
 * Searches a cone of +-20 degrees around the surgeon's normal (121 directions
 * on a Fibonacci sphere cap) times offsets d0 +-15 mm in 1 mm steps: 3751
 * candidates, each scored with the same metric functions the HUD uses, on a
 * coarser 64^3 grid. The last two score terms keep the answer close to where
 * the surgeon put the plane: we assist, we do not overrule.
 */

import { angleDeg, cross, normalize, type Vec3 } from '../coords.ts';
import type { PlanMetrics, Plane, Thresholds } from '../types.ts';
import { evaluatePlane, type EngineContext } from './engine.ts';
import { vesselCrossingsAlong } from './vessels.ts';
import type { CoarseGrid } from './volume.ts';

export const CONE_DEG = 20;
export const DIRECTIONS = 121;
export const OFFSET_MM = 15;

/** Bounds on the local search (the agent's max_rotate_deg / max_offset_mm). */
export interface SearchBounds {
  /** Half-angle of the cone of normals, degrees (default CONE_DEG). */
  coneDeg?: number;
  /** Offsets run -offsetMm..offsetMm in 1 mm steps; an integer (default OFFSET_MM). */
  offsetMm?: number;
}

export interface OptimizeResult {
  plane: Plane;
  before: PlanMetrics;
  after: PlanMetrics;
  /** Rotation between the original and the chosen normal. */
  angleDeg: number;
  offsetMm: number;
  /** True when the chosen plane meets every hard constraint. */
  feasible: boolean;
  /** What the original plane violated, in priority order. */
  violated: ('tumor' | 'margin' | 'remnant' | 'vessels')[];
  /** The vessel the original plane crossed (or nearly crossed), if any. */
  vessel: string | null;
  candidates: number;
  ms: number;
}

/**
 * Score weights per priority. Balanced is the spec's formula. "Vessels"
 * makes one crossed vessel cost more than a missed margin target, keeps the
 * remnant floor untouchable, and grades the margin shortfall so the cut that
 * spares the vessels still keeps as much margin as it can. "Remnant" relaxes
 * the stay-near-the-surgeon terms so the search may roam for more liver.
 */
export function weights(th: Thresholds): { margin: number; shortfall: number; remnant: number; vessel: number; stay: number } {
  const p = th.priority ?? 'balanced';
  return {
    margin: 1000,
    shortfall: p === 'vessels' ? 20 : 0,
    remnant: p === 'vessels' ? 5000 : 1000,
    vessel: p === 'vessels' ? 1500 : th.vesselPenalty === 'hard' ? 200 : 20,
    stay: p === 'remnant' ? 0.05 : 0.3,
  };
}

export function score(m: PlanMetrics, n: Vec3, d: number, n0: Vec3, d0: number, th: Thresholds): number {
  const w = weights(th);
  return (
    m.remnantPct -
    // Leaving tumour behind is never a trade-off.
    10000 * (m.tumorIncomplete ? 1 : 0) -
    w.margin * (m.marginMm < th.marginMin ? 1 : 0) -
    w.shortfall * Math.max(0, th.marginMin - m.marginMm) -
    w.remnant * (m.remnantPct < th.remnantMin ? 1 : 0) -
    w.vessel * m.vesselsCrossed -
    w.stay * angleDeg(n, n0) -
    w.stay * Math.abs(d - d0)
  );
}

/** `count` unit vectors spread evenly over a cap of half-angle `deg` around `axis`. */
export function fibonacciCap(axis: Vec3, deg: number, count: number): Vec3[] {
  const a = normalize(axis);
  const seed: Vec3 = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize(cross(a, seed));
  const v = cross(a, u);
  const cosMax = Math.cos((deg * Math.PI) / 180);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const out: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    // i = 0 is exactly the axis, so the surgeon's own normal is always tried.
    const z = count === 1 ? 1 : 1 - (i / (count - 1)) * (1 - cosMax);
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const phi = i * golden;
    const x = r * Math.cos(phi);
    const y = r * Math.sin(phi);
    out.push(normalize([
      u[0] * x + v[0] * y + a[0] * z,
      u[1] * x + v[1] * y + a[1] * z,
      u[2] * x + v[2] * y + a[2] * z,
    ]));
  }
  return out;
}

/** Engine context for a coarse grid: its own organ box, the shared names. */
export function coarseContext(g: CoarseGrid, names: Map<number, string>): EngineContext {
  let lo: Vec3 = [Infinity, Infinity, Infinity];
  let hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const idx of g.organIdx) {
    const i = idx % g.nx;
    const j = ((idx - i) / g.nx) % g.ny;
    const k = Math.floor(idx / (g.nx * g.ny));
    lo = [Math.min(lo[0], i), Math.min(lo[1], j), Math.min(lo[2], k)];
    hi = [Math.max(hi[0], i), Math.max(hi[1], j), Math.max(hi[2], k)];
  }
  return { grid: g, box: g.organIdx.length ? { lo, hi } : null, names };
}

export function violations(m: PlanMetrics, th: Thresholds): OptimizeResult['violated'] {
  const out: OptimizeResult['violated'] = [];
  if (m.tumorIncomplete) out.push('tumor');
  else if (m.marginMm < th.marginMin) out.push('margin');
  if (m.remnantPct < th.remnantMin) out.push('remnant');
  if (m.vesselsCrossed > 0) out.push('vessels');
  return out;
}

/** How many of the coarse grid's best candidates are re-scored on the fine grid. */
export const RESCORE = 24;
/**
 * Near misses also re-scored: candidates the plane-to-tumour proxy puts up
 * to MARGIN_SLACK_MM short of the margin target. The proxy is a lower bound
 * on the true cut-surface margin (the cut face may not reach the tumour's
 * nearest point); on the liver case it read 7.4 mm for a plane whose true
 * margin is 10.2 mm, which ranked the only one-vessel acceptable plane
 * 1091st and left the optimizer on a two-vessel one.
 */
export const NEAR_MISSES = 16;
export const MARGIN_SLACK_MM = 4;

/**
 * Rank every candidate on `ctx` (the coarse grid). When `fine` is given, the
 * top RESCORE candidates are re-scored there and the winner is chosen on the
 * fine numbers, so a vessel or margin the coarse grid blurred cannot win.
 */
export function optimizePlane(
  ctx: EngineContext,
  start: Plane,
  th: Thresholds,
  directions = DIRECTIONS,
  fine: EngineContext | null = null,
  bounds: SearchBounds = {},
): OptimizeResult {
  const t0 = performance.now();
  const cone = bounds.coneDeg ?? CONE_DEG;
  const off = bounds.offsetMm ?? OFFSET_MM;
  const n0 = normalize(start.n);
  const d0 = start.d;
  const judge = fine ?? ctx;
  const before = evaluatePlane(judge, { n: n0, d: d0 });

  // Rotations pivot about the anchor, and each candidate's d is re-expressed
  // through it, so "offset" means sliding along the new normal from where the
  // cut was rather than swinging the plane off the organ.
  const anchor = pointOn(n0, d0, ctx);
  const baseFor = (n: Vec3) => n[0] * anchor[0] + n[1] * anchor[1] + n[2] * anchor[2];

  // Coarse-grid margins are quantised to its ~5 mm voxels, too coarse to rank
  // on. For a planar cut the distance from the plane to the nearest tumour
  // voxel, min(n.t) - d over the full-resolution tumour, is an exact and cheap
  // stand-in (negative means tumour is kept). The fine re-score below then
  // applies the real cut-surface margin rule.
  const tumor = tumorPoints(judge.grid);
  // Vessels likewise: the coarse grid's majority vote erases thin vessels
  // (on the liver case it keeps ~5 % of the vessel voxels), so ranking on it
  // called planes vessel-free that cut one to three vessels and could leave a
  // truly vessel-free plane out of the finalists. With the fine grid at hand,
  // every candidate's crossings are counted there, exactly.
  const fineVessels = fine !== null;
  const ranked: { n: Vec3; d: number; base: number; s: number }[] = [];
  const nearMiss: { n: Vec3; d: number; base: number; s: number }[] = [];
  let candidates = 0;
  for (const n of fibonacciCap(n0, cone, directions)) {
    const base = baseFor(n);
    const ds: number[] = [];
    for (let k = -off; k <= off; k++) ds.push(base + k);
    const crossings = fineVessels ? vesselCrossingsAlong(judge.grid, n, ds, { box: judge.box }) : null;
    // The tumour's nearest extent along n does not depend on the offset:
    // once per direction, not once per candidate.
    let tmin = Infinity;
    for (let i = 0; i < tumor.length; i += 3) {
      const v = n[0] * tumor[i] + n[1] * tumor[i + 1] + n[2] * tumor[i + 2];
      if (v < tmin) tmin = v;
    }
    for (let k = -off; k <= off; k++) {
      const d = base + k;
      const exact = tumor.length > 0;
      const m = evaluatePlane(ctx, { n, d }, { locate: false, margin: !exact, vessels: !fineVessels });
      if (crossings) m.vesselsCrossed = crossings[k + off];
      if (exact) {
        m.marginMm = Math.max(0, tmin - d);
        m.tumorIncomplete = tmin - d <= 0;
      }
      const sc = score(m, n, d, n0, base, th);
      ranked.push({ n, d, base, s: sc });
      if (exact && !m.tumorIncomplete && m.marginMm < th.marginMin && m.marginMm >= th.marginMin - MARGIN_SLACK_MM) {
        // Scored as if the margin held; the fine grid decides whether it does.
        nearMiss.push({ n, d, base, s: sc + weights(th).margin });
      }
      candidates++;
    }
  }
  ranked.sort((a, b) => b.s - a.s);

  // The surgeon's own plane is always in the final round, so the optimizer
  // can never return something that scores worse than doing nothing.
  nearMiss.sort((a, b) => b.s - a.s);
  const finalists = [
    { n: n0, d: d0, base: baseFor(n0) },
    ...ranked.slice(0, fine ? RESCORE : 1),
    ...(fine ? nearMiss.slice(0, NEAR_MISSES) : []),
  ];
  let best = { n: n0, d: d0, s: -Infinity, m: before };
  for (const c of finalists) {
    const m = evaluatePlane(judge, { n: c.n, d: c.d });
    const s = score(m, c.n, c.d, n0, c.base, th);
    if (s > best.s) best = { n: c.n, d: c.d, s, m };
  }

  const after = best.m;
  return {
    plane: { n: best.n, d: best.d },
    before,
    after,
    angleDeg: angleDeg(best.n, n0),
    offsetMm: Math.abs(best.d - baseFor(best.n)),
    feasible: violations(after, th).length === 0,
    violated: violations(before, th),
    vessel: before.vesselName ?? (before.nearestVesselMm < 5 ? (ctx.names.get(before.nearestVesselId) ?? null) : null),
    candidates,
    ms: performance.now() - t0,
  };
}

/** World-mm centres of a grid's tumour voxels, flattened, cached per grid. */
const tumorCache = new WeakMap<object, Float32Array>();
function tumorPoints(g: EngineContext['grid']): Float32Array {
  let pts = tumorCache.get(g);
  if (!pts) {
    pts = new Float32Array(g.tumorIdx.length * 3);
    g.tumorIdx.forEach((idx, a) => {
      const i = idx % g.nx;
      const j = ((idx - i) / g.nx) % g.ny;
      const k = Math.floor(idx / (g.nx * g.ny));
      pts!.set([g.xs[i], g.ys[j], g.zs[k]], a * 3);
    });
    tumorCache.set(g, pts);
  }
  return pts;
}

/** The organ's centre of mass on `ctx`'s grid, cached per context. */
const pivotCache = new WeakMap<EngineContext, Vec3>();
function organCentre(ctx: EngineContext): Vec3 {
  let c = pivotCache.get(ctx);
  if (!c) {
    const g = ctx.grid;
    let sx = 0, sy = 0, sz = 0;
    for (const idx of g.organIdx) {
      const i = idx % g.nx;
      const j = ((idx - i) / g.nx) % g.ny;
      const k = Math.floor(idx / (g.nx * g.ny));
      sx += g.xs[i];
      sy += g.ys[j];
      sz += g.zs[k];
    }
    const cnt = Math.max(1, g.organIdx.length);
    c = [sx / cnt, sy / cnt, sz / cnt];
    pivotCache.set(ctx, c);
  }
  return c;
}

/**
 * The point of the plane nearest the organ's centre: the pivot rotations are
 * taken about, so tilting the cut does not swing it off the liver.
 */
function pointOn(n: Vec3, d: number, ctx: EngineContext): Vec3 {
  const c = organCentre(ctx);
  const s = n[0] * c[0] + n[1] * c[1] + n[2] * c[2] - d;
  return [c[0] - n[0] * s, c[1] - n[1] * s, c[2] - n[2] * s];
}

/** Half-angle of the wide search around the tumour, degrees. */
export const WIDE_CONE_DEG = 75;
export const WIDE_DIRECTIONS = 145;
/** Offsets tried per direction: margins from (target - 2) to (target + 12) mm. */
const WIDE_BELOW = 2;
const WIDE_ABOVE = 12;

/**
 * The search for when the surgeon's cut is far off (or there is none): the
 * best cut anywhere around the tumour, with no pull back toward the start.
 *
 * Every direction within WIDE_CONE_DEG of "straight out of the organ through
 * the tumour" is tried, each at offsets that put its plane just around the
 * margin target from the tumour's near face, so all 3615 candidates are
 * plausible cuts rather than planes that miss the liver. Ranked like the
 * local search (exact plane-to-tumour margin, fine-grid vessel counts,
 * near-miss and top candidates re-scored on the fine grid), but on quality
 * alone: the stay-near-the-start terms are dropped. `start` is used only to
 * report how far the answer moved.
 */
export function optimizeAround(
  ctx: EngineContext,
  start: Plane | null,
  th: Thresholds,
  fine: EngineContext | null = null,
): OptimizeResult | null {
  const t0 = performance.now();
  const judge = fine ?? ctx;
  const tumor = tumorPoints(judge.grid);
  if (tumor.length === 0) return null;
  let tc: Vec3 = [0, 0, 0];
  for (let i = 0; i < tumor.length; i += 3) tc = [tc[0] + tumor[i], tc[1] + tumor[i + 1], tc[2] + tumor[i + 2]];
  tc = [(tc[0] * 3) / tumor.length, (tc[1] * 3) / tumor.length, (tc[2] * 3) / tumor.length];
  const organC = organCentre(ctx);
  const axis = normalize([tc[0] - organC[0], tc[1] - organC[1], tc[2] - organC[2]]);

  // Quality only: scored as if every candidate were its own start.
  const quality = (m: PlanMetrics, n: Vec3, d: number) => score(m, n, d, n, d, th);
  const fineVessels = fine !== null;
  const ranked: { n: Vec3; d: number; s: number }[] = [];
  const nearMiss: { n: Vec3; d: number; s: number }[] = [];
  let candidates = 0;
  for (const n of fibonacciCap(axis, WIDE_CONE_DEG, WIDE_DIRECTIONS)) {
    let tmin = Infinity;
    for (let i = 0; i < tumor.length; i += 3) {
      const v = n[0] * tumor[i] + n[1] * tumor[i + 1] + n[2] * tumor[i + 2];
      if (v < tmin) tmin = v;
    }
    const ds: number[] = [];
    for (let m = th.marginMin - WIDE_BELOW; m <= th.marginMin + WIDE_ABOVE; m++) ds.push(tmin - Math.max(0.5, m));
    const crossings = fineVessels ? vesselCrossingsAlong(judge.grid, n, ds, { box: judge.box }) : null;
    ds.forEach((d, k) => {
      const m = evaluatePlane(ctx, { n, d }, { locate: false, margin: false, vessels: !fineVessels });
      if (crossings) m.vesselsCrossed = crossings[k];
      m.marginMm = tmin - d;
      m.tumorIncomplete = false;
      const s = quality(m, n, d);
      ranked.push({ n, d, s });
      if (m.marginMm < th.marginMin && m.marginMm >= th.marginMin - MARGIN_SLACK_MM) nearMiss.push({ n, d, s: s + weights(th).margin });
      candidates++;
    });
  }
  ranked.sort((a, b) => b.s - a.s);
  nearMiss.sort((a, b) => b.s - a.s);
  const finalists = [...ranked.slice(0, fine ? RESCORE : 1), ...(fine ? nearMiss.slice(0, NEAR_MISSES) : [])];
  if (start) finalists.push({ n: normalize(start.n), d: start.d, s: 0 });

  let best: { n: Vec3; d: number; s: number; m: PlanMetrics } | null = null;
  for (const c of finalists) {
    const m = evaluatePlane(judge, { n: c.n, d: c.d });
    const s = quality(m, c.n, c.d);
    if (!best || s > best.s) best = { n: c.n, d: c.d, s, m };
  }
  if (!best) return null;
  const before = start ? evaluatePlane(judge, { n: normalize(start.n), d: start.d }) : best.m;
  const n0 = start ? normalize(start.n) : best.n;
  return {
    plane: { n: best.n, d: best.d },
    before,
    after: best.m,
    angleDeg: angleDeg(best.n, n0),
    offsetMm: start ? Math.abs(best.d - start.d) : 0,
    feasible: violations(best.m, th).length === 0,
    violated: violations(before, th),
    vessel: before.vesselName ?? (before.nearestVesselMm < 5 ? (ctx.names.get(before.nearestVesselId) ?? null) : null),
    candidates,
    ms: performance.now() - t0,
  };
}
