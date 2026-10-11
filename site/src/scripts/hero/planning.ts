/**
 * Live planning numbers for the hero, from the app's own engine
 * (src/planning): the same remnant, margin and vessel code the app runs, on
 * the site's 2 mm copy of the liver scan. The engine coarsens that to its
 * planning grid (about 4 mm here), so figures can differ slightly from the
 * app, which plans on the full-resolution scan.
 */

import { contextFrom, evaluatePlane } from '@app/planning/engine.ts';
import { PlanningGrid } from '@app/planning/volume.ts';
import type { CaseData, PlanMetrics, Plane, Vec3 } from '@app/types.ts';

import type { HeroData } from './renderer.ts';

export interface LivePlanner {
  evaluate(n: Vec3, d: number): PlanMetrics;
  buildMs: number;
}

/** Builds the planning grid and tumour distance field. Call off the critical path. */
export function makePlanner(data: HeroData): LivePlanner {
  const t0 = performance.now();
  const meta = data.meta as unknown as CaseData['meta'];
  const grid = new PlanningGrid({ meta, volume: data.volume, labels: data.labels, centerlines: null, meshes: null });
  const ctx = contextFrom(grid);
  const buildMs = performance.now() - t0;
  return {
    buildMs,
    evaluate: (n, d) => evaluatePlane(ctx, { n, d } as Plane, false),
  };
}
