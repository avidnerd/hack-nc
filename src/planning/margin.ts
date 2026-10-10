/**
 * Oncologic margin: how much healthy tissue sits between the cut and the
 * tumour.
 *
 *   margin mm = min over organ voxels ON THE KEPT SIDE and within one voxel
 *               diagonal of the plane, of distance-to-tumour
 *
 * That band of voxels is the cut surface. Taking the minimum of the tumour
 * distance transform over it gives the closest approach of the blade to the
 * lesion, which is the number a surgeon actually cares about.
 *
 * If any tumour voxel is left on the kept side the resection is incomplete,
 * and the margin is reported as 0 rather than as some positive distance that
 * would read as safe.
 */

import type { CoarseGrid } from './volume.ts';
import type { Plane, Vec3 } from '../types.ts';

export interface MarginResult {
  marginMm: number;
  /** True when part of the tumour would be left in the patient. */
  tumorIncomplete: boolean;
  /** No tumour in this case, so the margin is undefined rather than zero. */
  noTumor: boolean;
  /**
   * Where that closest approach is: the cut-surface voxel and the tumour voxel
   * nearest to it, in world mm, so the view can draw the margin it reports.
   */
  closest: [Vec3, Vec3] | null;
}

export function computeMargin(
  g: CoarseGrid,
  plane: Plane,
  tumorKeptVoxels: number,
  /** Also locate the closest approach (for drawing); the optimizer skips it. */
  locate = true,
): MarginResult {
  if (g.tumorIdx.length === 0) {
    return { marginMm: Infinity, tumorIncomplete: false, noTumor: true, closest: null };
  }
  if (tumorKeptVoxels > 0) {
    return { marginMm: 0, tumorIncomplete: true, noTumor: false, closest: null };
  }

  const { n, d } = plane;
  const [n0, n1, n2] = n;
  const { nx, ny, xs, ys, zs, distTumor } = g;
  const nxy = nx * ny;
  // One voxel diagonal: thin enough to be a surface, thick enough that the
  // plane cannot slip between two voxel layers and find nothing.
  const band = g.voxelDiag;

  let best = Infinity;
  let bestIdx = -1;
  for (let a = 0; a < g.organIdx.length; a++) {
    const idx = g.organIdx[a];
    const i = idx % nx;
    const j = ((idx - i) / nx) % ny;
    const k = (idx / nxy) | 0;
    const sd = n0 * xs[i] + n1 * ys[j] + n2 * zs[k] - d;
    // Kept side only, and only the layer right against the cut.
    if (sd > 0 || sd < -band) continue;
    const dt = distTumor[idx];
    if (dt < best) {
      best = dt;
      bestIdx = idx;
    }
  }

  // The plane misses the organ entirely: nothing is being cut, so there is no
  // margin to report.
  return {
    marginMm: best,
    tumorIncomplete: false,
    noTumor: false,
    closest: bestIdx < 0 || !locate ? null : closestPair(g, bestIdx),
  };
}

/** The cut voxel and its nearest tumour voxel (brute force; tumours are small). */
function closestPair(g: CoarseGrid, from: number): [Vec3, Vec3] {
  const { nx, ny, xs, ys, zs } = g;
  const at = (idx: number): Vec3 => {
    const i = idx % nx;
    const j = ((idx - i) / nx) % ny;
    const k = (idx / (nx * ny)) | 0;
    return [xs[i], ys[j], zs[k]];
  };
  const a = at(from);
  let b = a;
  let bd = Infinity;
  for (let t = 0; t < g.tumorIdx.length; t++) {
    const q = at(g.tumorIdx[t]);
    const d = (q[0] - a[0]) ** 2 + (q[1] - a[1]) ** 2 + (q[2] - a[2]) ** 2;
    if (d < bd) {
      bd = d;
      b = q;
    }
  }
  return [a, b];
}
