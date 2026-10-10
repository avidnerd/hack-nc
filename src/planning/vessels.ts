/**
 * Which vessels the cut would divide.
 *
 *   vessels crossed = connected components of vessel voxels that straddle the
 *                     plane, counted inside the organ's bounding box
 *
 * Counting components rather than voxels is what makes the number meaningful:
 * a cut through one vein is "1", not "340 voxels". The bounding-box
 * restriction stops unrelated vasculature elsewhere in the torso (the aorta
 * passing behind the liver, say) from inflating the count.
 *
 * DECISION: only components of at least VESSEL_MIN_MM3 count. With the full
 * intrahepatic tree segmented, any cut divides a dozen millimetre twigs; what
 * a surgeon has to plan around is a vessel of 5 mm or more. 120 mm^3 is a
 * 5 mm vessel crossing the cut band (two voxel diagonals, ~6 mm) square on.
 * pipeline/run.py applies the same threshold.
 */

/** Smallest straddling component that counts as a vessel crossed. */
export const VESSEL_MIN_MM3 = 120;

import type { CoarseGrid } from './volume.ts';
import type { Plane, Vec3 } from '../types.ts';

export interface VesselResult {
  /** Number of distinct vessels divided by the cut. */
  crossed: number;
  /** Label id of the largest crossed vessel, or 0. */
  largestId: number;
  /** Voxel count of that largest component. */
  largestVoxels: number;
  /** Distance in mm from the cut surface to the nearest vessel voxel. */
  nearestMm: number;
  /** Label id of that nearest vessel voxel, or 0. */
  nearestId: number;
  /**
   * Where the cut divides each counted vessel: one point per divided vessel
   * (the centroid of its straddling voxels), world mm.
   */
  cuts: { p: Vec3; id: number }[];
}

export interface VesselOptions {
  /** Restrict counting to this voxel box, usually the organ's. */
  box?: { lo: [number, number, number]; hi: [number, number, number] } | null;
  /** Grow the box by this many voxels. */
  padVox?: number;
}

export function computeVessels(
  g: CoarseGrid,
  plane: Plane,
  opts: VesselOptions = {},
): VesselResult {
  const { n, d } = plane;
  const [n0, n1, n2] = n;
  const { nx, ny, nz, xs, ys, zs } = g;
  const nxy = nx * ny;
  const band = g.voxelDiag;
  const box = opts.box ?? null;
  const pad = opts.padVox ?? 3;

  // Mark the straddling vessel voxels, and track the closest approach of any
  // vessel to the cut surface while we are already walking the list.
  const straddling = new Set<number>();
  let nearestMm = Infinity;
  let nearestId = 0;

  for (let a = 0; a < g.vesselIdx.length; a++) {
    const idx = g.vesselIdx[a];
    const i = idx % nx;
    const j = ((idx - i) / nx) % ny;
    const k = (idx / nxy) | 0;

    if (box) {
      if (
        i < box.lo[0] - pad || i > box.hi[0] + pad ||
        j < box.lo[1] - pad || j > box.hi[1] + pad ||
        k < box.lo[2] - pad || k > box.hi[2] + pad
      ) {
        continue;
      }
    }

    const sd = n0 * xs[i] + n1 * ys[j] + n2 * zs[k] - d;
    const adist = Math.abs(sd);
    if (adist < nearestMm) {
      nearestMm = adist;
      nearestId = g.labels[idx];
    }
    if (adist < band) straddling.add(idx);
  }

  if (straddling.size === 0) {
    return { crossed: 0, largestId: 0, largestVoxels: 0, nearestMm, nearestId, cuts: [] };
  }

  // Flood fill over the straddling set with 6-connectivity. The set is small
  // (a few hundred voxels at most), so an explicit stack is plenty.
  const seen = new Set<number>();
  let crossed = 0;
  let largestVoxels = 0;
  let largestId = 0;
  const cuts: VesselResult['cuts'] = [];

  for (const start of straddling) {
    if (seen.has(start)) continue;

    let size = 0;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    const counts = new Map<number, number>();
    const stack = [start];
    seen.add(start);

    while (stack.length > 0) {
      const cur = stack.pop()!;
      size++;
      const id = g.labels[cur];
      counts.set(id, (counts.get(id) ?? 0) + 1);

      const i = cur % nx;
      const j = ((cur - i) / nx) % ny;
      const k = (cur / nxy) | 0;
      cx += xs[i];
      cy += ys[j];
      cz += zs[k];

      // 6-neighbourhood. Two vessels that merely touch at a corner are two
      // vessels, so face connectivity is the right choice here.
      if (i > 0) tryPush(cur - 1);
      if (i < nx - 1) tryPush(cur + 1);
      if (j > 0) tryPush(cur - nx);
      if (j < ny - 1) tryPush(cur + nx);
      if (k > 0) tryPush(cur - nxy);
      if (k < nz - 1) tryPush(cur + nxy);
    }

    if (size * g.voxelMm3 < VESSEL_MIN_MM3) continue;
    crossed++;

    // Name the component after whichever label contributes most of it.
    let compId = 0;
    let bestCount = 0;
    for (const [id, c] of counts) {
      if (c > bestCount) {
        bestCount = c;
        compId = id;
      }
    }
    cuts.push({ p: [cx / size, cy / size, cz / size], id: compId });
    if (size > largestVoxels) {
      largestVoxels = size;
      largestId = compId;
    }

    function tryPush(next: number): void {
      if (!seen.has(next) && straddling.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }

  return { crossed, largestId, largestVoxels, nearestMm, nearestId, cuts };
}
