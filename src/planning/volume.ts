/**
 * The planning grid: a coarsened copy of the label volume with the per-voxel
 * indices and distance fields the metrics need.
 *
 * The renderer draws from the full 256^3 label texture, but the planning maths
 * runs on a majority-downsampled grid (128^3 or finer). That is ~55k liver
 * voxels instead of ~440k, which is what makes a full recomputation of every
 * number cheap enough to run on each frame while a palm moves, with no
 * perceptible lag and no worker round-trip.
 *
 * The Python pipeline builds its ground truth on an identically-constructed
 * grid, so `truth.json` and this module are directly comparable.
 */

import { edt3d, type Grid3 } from './edt.ts';
import type { CaseData, LabelDef, Vec3 } from '../types.ts';

/**
 * Coarsen until the grid holds at most this many voxels: the 128^3 budget,
 * doubled because a CT slab is far from cubic. A thin case (few slices)
 * keeps full resolution; a tall one is halved. pipeline/run.py uses the same
 * rule so its truth is computed on the identical grid.
 */
export const PLANNING_MAX_VOXELS = 2 * 128 ** 3;

export function planningFactor(shape: Vec3): number {
  let f = 1;
  while (Math.ceil(shape[0] / f) * Math.ceil(shape[1] / f) * Math.ceil(shape[2] / f) > PLANNING_MAX_VOXELS) f++;
  return f;
}

export class PlanningGrid {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly spacing: Vec3;
  readonly origin: Vec3;
  /** Downsampling factor applied to the source grid. */
  readonly factor: number;
  /** Volume of one planning voxel in mm^3. */
  readonly voxelMm3: number;
  /** Body diagonal of one voxel, the thickness of the "cut surface" band. */
  readonly voxelDiag: number;

  readonly labels: Uint8Array;

  /** Per-axis world-mm coordinate lookups, so a voxel centre is one index each. */
  readonly xs: Float32Array;
  readonly ys: Float32Array;
  readonly zs: Float32Array;

  /** Flat indices of organ voxels (organ label plus tumour, which sits inside). */
  readonly organIdx: Int32Array;
  readonly tumorIdx: Int32Array;
  readonly vesselIdx: Int32Array;

  /** Distance in mm from every voxel to the nearest tumour voxel. */
  readonly distTumor: Float32Array;

  /** Label ids by role, resolved from the case's label table. */
  readonly organId: number;
  readonly tumorId: number;
  readonly vesselIds: Set<number>;
  readonly labelById = new Map<number, LabelDef>();

  /** Inclusive voxel bounding box of the organ, used to scope vessel counting. */
  readonly organBox: { lo: Vec3; hi: Vec3 } | null;

  constructor(data: CaseData) {
    const meta = data.meta;
    for (const l of meta.labels) this.labelById.set(l.id, l);

    this.organId = meta.labels.find((l) => l.role === 'organ')?.id ?? 1;
    this.tumorId = meta.labels.find((l) => l.role === 'tumor')?.id ?? 2;
    this.vesselIds = new Set(
      meta.vesselIds?.length
        ? meta.vesselIds
        : meta.labels.filter((l) => l.role === 'vessel').map((l) => l.id),
    );

    this.factor = planningFactor(meta.shape);
    const f = this.factor;
    this.nx = Math.ceil(meta.shape[0] / f);
    this.ny = Math.ceil(meta.shape[1] / f);
    this.nz = Math.ceil(meta.shape[2] / f);
    this.spacing = [meta.spacing[0] * f, meta.spacing[1] * f, meta.spacing[2] * f];
    this.origin = [...meta.origin] as Vec3;
    this.voxelMm3 = this.spacing[0] * this.spacing[1] * this.spacing[2];
    this.voxelDiag = Math.hypot(...this.spacing);

    this.labels = majorityDownsample(data.labels, meta.shape, f, [this.nx, this.ny, this.nz]);

    this.xs = axisCoords(this.nx, this.spacing[0], this.origin[0]);
    this.ys = axisCoords(this.ny, this.spacing[1], this.origin[1]);
    this.zs = axisCoords(this.nz, this.spacing[2], this.origin[2]);

    // Collect the three index lists in one pass.
    const organ: number[] = [];
    const tumor: number[] = [];
    const vessel: number[] = [];
    let loX = Infinity, loY = Infinity, loZ = Infinity;
    let hiX = -Infinity, hiY = -Infinity, hiZ = -Infinity;

    const n = this.nx * this.ny * this.nz;
    for (let idx = 0; idx < n; idx++) {
      const id = this.labels[idx];
      if (id === 0) continue;
      if (id === this.organId || id === this.tumorId) {
        organ.push(idx);
        const i = idx % this.nx;
        const j = ((idx - i) / this.nx) % this.ny;
        const k = Math.floor(idx / (this.nx * this.ny));
        if (i < loX) loX = i;
        if (j < loY) loY = j;
        if (k < loZ) loZ = k;
        if (i > hiX) hiX = i;
        if (j > hiY) hiY = j;
        if (k > hiZ) hiZ = k;
        if (id === this.tumorId) tumor.push(idx);
      } else if (this.vesselIds.has(id)) {
        vessel.push(idx);
      }
    }

    this.organIdx = new Int32Array(organ);
    this.tumorIdx = new Int32Array(tumor);
    this.vesselIdx = new Int32Array(vessel);
    this.organBox =
      organ.length > 0 ? { lo: [loX, loY, loZ], hi: [hiX, hiY, hiZ] } : null;

    // The tumour distance field is the expensive part of setup (one EDT over
    // the whole planning grid) and the only thing `margin` needs at runtime.
    const seed = new Uint8Array(n);
    for (const i of this.tumorIdx) seed[i] = 1;
    const grid: Grid3 = { nx: this.nx, ny: this.ny, nz: this.nz, spacing: this.spacing };
    this.distTumor = edt3d(seed, grid);
  }

  /** World-mm centre of a flat index. */
  worldAt(idx: number): Vec3 {
    const i = idx % this.nx;
    const j = ((idx - i) / this.nx) % this.ny;
    const k = Math.floor(idx / (this.nx * this.ny));
    return [this.xs[i], this.ys[j], this.zs[k]];
  }

  /** Total organ volume in mL (organ plus tumour). */
  get organMl(): number {
    return (this.organIdx.length * this.voxelMm3) / 1000;
  }

  get tumorMl(): number {
    return (this.tumorIdx.length * this.voxelMm3) / 1000;
  }

  /** Centroid of the tumour in world mm, or null when there is none. */
  tumorCentroid(): Vec3 | null {
    if (this.tumorIdx.length === 0) return null;
    let sx = 0, sy = 0, sz = 0;
    for (const idx of this.tumorIdx) {
      const p = this.worldAt(idx);
      sx += p[0];
      sy += p[1];
      sz += p[2];
    }
    const n = this.tumorIdx.length;
    return [sx / n, sy / n, sz / n];
  }

  /** Centroid of the organ in world mm — the default pivot for a cut plane. */
  organCentroid(): Vec3 | null {
    if (this.organIdx.length === 0) return null;
    let sx = 0, sy = 0, sz = 0;
    for (const idx of this.organIdx) {
      const p = this.worldAt(idx);
      sx += p[0];
      sy += p[1];
      sz += p[2];
    }
    const n = this.organIdx.length;
    return [sx / n, sy / n, sz / n];
  }

  /** True when `idx` lies inside the organ's bounding box, grown by `padVox`. */
  inOrganBox(idx: number, padVox = 3): boolean {
    const b = this.organBox;
    if (!b) return true;
    const i = idx % this.nx;
    const j = ((idx - i) / this.nx) % this.ny;
    const k = Math.floor(idx / (this.nx * this.ny));
    return (
      i >= b.lo[0] - padVox && i <= b.hi[0] + padVox &&
      j >= b.lo[1] - padVox && j <= b.hi[1] + padVox &&
      k >= b.lo[2] - padVox && k <= b.hi[2] + padVox
    );
  }

  /**
   * A coarser copy for the optimizer, which evaluates thousands of candidate
   * planes and only needs the ranking to be right (its top candidates are
   * re-scored on this full grid).
   *
   * DECISION: sized by organ voxel count, not by axis length, because that is
   * what each candidate costs. A thin slab and a tall CT then get the same
   * search time, where a fixed 64^3 cap left a 63-slice case with 16 slices.
   */
  coarsen(targetOrganVoxels = 8000): CoarseGrid {
    const extra = Math.max(1, Math.ceil(Math.cbrt(this.organIdx.length / targetOrganVoxels)));
    const nx = Math.ceil(this.nx / extra);
    const ny = Math.ceil(this.ny / extra);
    const nz = Math.ceil(this.nz / extra);
    const spacing: Vec3 = [
      this.spacing[0] * extra,
      this.spacing[1] * extra,
      this.spacing[2] * extra,
    ];
    const labels = majorityDownsample(
      this.labels,
      [this.nx, this.ny, this.nz],
      extra,
      [nx, ny, nz],
    );

    const organ: number[] = [];
    const tumor: number[] = [];
    const vessel: number[] = [];
    for (let idx = 0; idx < labels.length; idx++) {
      const id = labels[idx];
      if (id === 0) continue;
      if (id === this.organId || id === this.tumorId) {
        organ.push(idx);
        if (id === this.tumorId) tumor.push(idx);
      } else if (this.vesselIds.has(id)) vessel.push(idx);
    }

    const seed = new Uint8Array(labels.length);
    for (const i of tumor) seed[i] = 1;

    return {
      nx, ny, nz, spacing,
      origin: [...this.origin] as Vec3,
      voxelMm3: spacing[0] * spacing[1] * spacing[2],
      voxelDiag: Math.hypot(...spacing),
      xs: axisCoords(nx, spacing[0], this.origin[0]),
      ys: axisCoords(ny, spacing[1], this.origin[1]),
      zs: axisCoords(nz, spacing[2], this.origin[2]),
      organIdx: new Int32Array(organ),
      tumorIdx: new Int32Array(tumor),
      vesselIdx: new Int32Array(vessel),
      distTumor: edt3d(seed, { nx, ny, nz, spacing }),
      labels,
    };
  }
}

/** The subset of PlanningGrid the metric functions actually read. */
export interface CoarseGrid {
  nx: number;
  ny: number;
  nz: number;
  spacing: Vec3;
  origin: Vec3;
  voxelMm3: number;
  voxelDiag: number;
  xs: Float32Array;
  ys: Float32Array;
  zs: Float32Array;
  organIdx: Int32Array;
  tumorIdx: Int32Array;
  vesselIdx: Int32Array;
  distTumor: Float32Array;
  labels: Uint8Array;
}

function axisCoords(n: number, spacing: number, origin: number): Float32Array {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = origin + i * spacing;
  return a;
}

/**
 * Block-reduce a label grid, taking the most common non-zero id in each block.
 *
 * Ties go to the HIGHER label id. The label table is ordered so that thin or
 * clinically important structures sit above the bulk organ containing them
 * (tumour 2 and vessels 3-5 above liver 1), so this is what stops a 4 mm
 * vessel from being averaged out of existence by the parenchyma around it.
 * `pipeline/run.py` implements the identical rule.
 */
export function majorityDownsample(
  src: Uint8Array,
  srcShape: Vec3,
  factor: number,
  dstShape: [number, number, number],
): Uint8Array {
  const [sx, sy, sz] = srcShape;
  const [dx, dy, dz] = dstShape;
  if (factor === 1 && sx === dx && sy === dy && sz === dz) return src.slice();

  const out = new Uint8Array(dx * dy * dz);
  const counts = new Uint16Array(256);

  for (let k = 0; k < dz; k++) {
    const k0 = k * factor;
    const k1 = Math.min(k0 + factor, sz);
    for (let j = 0; j < dy; j++) {
      const j0 = j * factor;
      const j1 = Math.min(j0 + factor, sy);
      for (let i = 0; i < dx; i++) {
        const i0 = i * factor;
        const i1 = Math.min(i0 + factor, sx);

        counts.fill(0);
        let seen = false;
        for (let kk = k0; kk < k1; kk++) {
          for (let jj = j0; jj < j1; jj++) {
            const base = sx * (jj + sy * kk);
            for (let ii = i0; ii < i1; ii++) {
              const id = src[base + ii];
              if (id !== 0) {
                counts[id]++;
                seen = true;
              }
            }
          }
        }

        if (!seen) continue;
        // Scan downward so the highest id wins a tie.
        let best = 0;
        let bestCount = 0;
        for (let id = 255; id >= 1; id--) {
          if (counts[id] > bestCount) {
            bestCount = counts[id];
            best = id;
          }
        }
        out[i + dx * (j + dy * k)] = best;
      }
    }
  }
  return out;
}
