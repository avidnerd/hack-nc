/**
 * Runs every metric for one plane and returns the numbers the HUD shows.
 *
 * Cheap enough to call on each frame while a palm moves: on the 128^3 planning
 * grid this walks ~55k organ voxels and ~10k vessel voxels, which is well
 * under a millisecond. That is why the numbers track the hand live instead of
 * settling a beat later.
 */

import { computeMargin } from './margin.ts';
import { computeRemnant } from './remnant.ts';
import { computeVessels } from './vessels.ts';
import type { CoarseGrid, PlanningGrid } from './volume.ts';
import type { PlanMetrics, Plane } from '../types.ts';

export interface EngineContext {
  grid: CoarseGrid;
  /** Organ bounding box, used to scope the vessel count. */
  box: { lo: [number, number, number]; hi: [number, number, number] } | null;
  /** Label id to human name, for "which vessel". */
  names: Map<number, string>;
}

export function contextFrom(grid: PlanningGrid): EngineContext {
  const names = new Map<number, string>();
  for (const [id, def] of grid.labelById) names.set(id, def.name);
  return {
    grid: grid as unknown as CoarseGrid,
    box: grid.organBox as EngineContext['box'],
    names,
  };
}

/**
 * `locate` also finds where the margin is (for the drawn line); the
 * optimizer's thousands of ranking evaluations turn it off.
 */
export function evaluatePlane(ctx: EngineContext, plane: Plane, locate = true): PlanMetrics {
  const g = ctx.grid;

  const r = computeRemnant(g, plane);
  const m = computeMargin(g, plane, r.tumorKeptVoxels, locate);
  const v = computeVessels(g, plane, { box: ctx.box });

  return {
    remnantPct: r.remnantPct,
    resectedMl: r.resectedMl,
    healthyRemnantMl: r.healthyRemnantMl,
    // A plane that misses the organ has no cut surface and therefore no
    // margin; report 0 rather than Infinity so the HUD has something to show.
    marginMm: Number.isFinite(m.marginMm) ? m.marginMm : 0,
    tumorIncomplete: m.tumorIncomplete,
    marginPath: m.closest,
    vesselsCrossed: v.crossed,
    vesselCuts: v.cuts,
    vesselName: v.largestId > 0 ? (ctx.names.get(v.largestId) ?? null) : null,
    vesselId: v.largestId,
    nearestVesselMm: Number.isFinite(v.nearestMm) ? v.nearestMm : Infinity,
    nearestVesselId: v.nearestId,
  };
}
