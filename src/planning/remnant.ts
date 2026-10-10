/**
 * Remnant volume: how much of the organ the surgeon is leaving behind.
 *
 *   remnant %   = kept organ voxels / total organ voxels x 100
 *   resected mL = resected organ voxels x voxel volume / 1000
 *
 * "Organ" means the organ label plus the tumour label, because the tumour
 * occupies liver that would otherwise be parenchyma and has to count toward
 * the total for the percentage to mean anything.
 */

import type { CoarseGrid } from './volume.ts';
import type { Plane } from '../types.ts';

export interface RemnantResult {
  remnantPct: number;
  resectedMl: number;
  keptMl: number;
  /** Kept organ minus any tumour left behind: the functional remnant. */
  healthyRemnantMl: number;
  tumorKeptVoxels: number;
}

export function computeRemnant(g: CoarseGrid, plane: Plane): RemnantResult {
  const { n, d } = plane;
  const [nx0, ny0, nz0] = n;
  const { nx, ny, xs, ys, zs } = g;
  const nxy = nx * ny;

  let kept = 0;
  const total = g.organIdx.length;

  for (let a = 0; a < total; a++) {
    const idx = g.organIdx[a];
    const i = idx % nx;
    const j = ((idx - i) / nx) % ny;
    const k = (idx / nxy) | 0;
    const sd = nx0 * xs[i] + ny0 * ys[j] + nz0 * zs[k] - d;
    if (sd <= 0) kept++;
  }

  let tumorKept = 0;
  for (let a = 0; a < g.tumorIdx.length; a++) {
    const idx = g.tumorIdx[a];
    const i = idx % nx;
    const j = ((idx - i) / nx) % ny;
    const k = (idx / nxy) | 0;
    const sd = nx0 * xs[i] + ny0 * ys[j] + nz0 * zs[k] - d;
    if (sd <= 0) tumorKept++;
  }

  const mlPerVoxel = g.voxelMm3 / 1000;
  return {
    remnantPct: total > 0 ? (100 * kept) / total : 0,
    resectedMl: (total - kept) * mlPerVoxel,
    keptMl: kept * mlPerVoxel,
    healthyRemnantMl: (kept - tumorKept) * mlPerVoxel,
    tumorKeptVoxels: tumorKept,
  };
}
