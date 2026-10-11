/**
 * Turn a scan held in memory into the same CaseData the shipped cases load
 * from public/data, so everything downstream (renderer, planning engine,
 * caliper, copilot) works on it unchanged.
 *
 *   resampleToCase  reorient to RAS+, resample to an isotropic grid that fits
 *                   the GPU, and encode HU with the pipeline's exact curve
 *                   (pipeline/run.py HU_CURVE / hu_to_u8)
 *   labelTable      what an optional label map's values mean: the MSD liver
 *                   convention (1 liver, 2 tumour) is recognised; any other
 *                   values become generic "Structure k" labels rather than a
 *                   guessed anatomical name
 */

import type { CaseData, CaseMeta, LabelDef, PresetName, Vec3, WindowLevel } from '../types.ts';
import { orientation, type NiftiImage } from './nifti.ts';

/** pipeline/run.py HU_CURVE: [u8, HU] breakpoints. */
export const HU_CURVE: [number, number][] = [
  [0, -1000],
  [40, -200],
  [215, 300],
  [255, 2000],
];

export const WINDOW_PRESETS: Record<PresetName, WindowLevel> = {
  soft: { w: 400, l: 40 },
  bone: { w: 1800, l: 400 },
  lung: { w: 1500, l: -600 },
  liver: { w: 150, l: 30 },
};

/** pipeline/run.py hu_to_u8, for one value. */
export function huToU8(hu: number): number {
  const c = HU_CURVE;
  if (hu <= c[0][1]) return 0;
  for (let i = 1; i < c.length; i++) {
    if (hu <= c[i][1]) {
      const t = (hu - c[i - 1][1]) / (c[i][1] - c[i - 1][1]);
      return Math.round(c[i - 1][0] + t * (c[i][0] - c[i - 1][0]));
    }
  }
  return 255;
}

/** Texture budget: at most this many voxels on any axis, and in total. */
export const MAX_DIM = 384;
export const MAX_VOXELS = 40_000_000;

export interface Grid {
  shape: Vec3;
  spacing: number;
}

/** The isotropic output grid for a reoriented extent (mm per axis). */
export function outputGrid(extentMm: Vec3, nativeMin: number): Grid {
  const vol = extentMm[0] * extentMm[1] * extentMm[2];
  const s = Math.max(nativeMin, Math.max(...extentMm) / MAX_DIM, Math.cbrt(vol / MAX_VOXELS));
  return { shape: extentMm.map((e) => Math.max(1, Math.round(e / s))) as Vec3, spacing: s };
}

/**
 * Reorient and resample `img` onto `grid`. `mode` 'linear' writes encoded CT
 * bytes; 'nearest' writes label values (0..255). Yields to the event loop
 * every few slices so a progress bar can repaint.
 */
export async function resample(
  img: NiftiImage,
  grid: Grid,
  mode: 'linear' | 'nearest',
  onProgress?: (f: number) => void,
): Promise<Uint8Array> {
  const o = orientation(img.affine);
  const [sx, sy, sz] = img.dims;
  const stride = [1, sx, sx * sy];
  const n = img.dims;
  const [nx, ny, nz] = grid.shape;
  const out = new Uint8Array(nx * ny * nz);
  const src = img.data;
  // Continuous source index along the file axis that feeds output axis w.
  const coord = (w: number, outIdx: number) => {
    const u = ((outIdx + 0.5) * grid.spacing) / o.spacing[w] - 0.5;
    const len = n[o.srcAxis[w]];
    return o.flip[w] ? len - 1 - u : u;
  };
  const clampI = (v: number, len: number) => (v < 0 ? 0 : v > len - 1 ? len - 1 : v);
  for (let z = 0; z < nz; z++) {
    const cz = coord(2, z);
    for (let y = 0; y < ny; y++) {
      const cy = coord(1, y);
      for (let x = 0; x < nx; x++) {
        const cx = coord(0, x);
        // Back to the file's (i, j, k) order.
        const c = [0, 0, 0];
        c[o.srcAxis[0]] = cx;
        c[o.srcAxis[1]] = cy;
        c[o.srcAxis[2]] = cz;
        let v: number;
        if (mode === 'nearest') {
          const i = clampI(Math.round(c[0]), sx);
          const j = clampI(Math.round(c[1]), sy);
          const k = clampI(Math.round(c[2]), sz);
          v = src[i + sx * (j + sy * k)];
          out[x + nx * (y + ny * z)] = v < 0 ? 0 : v > 255 ? 255 : v;
        } else {
          const i0 = clampI(Math.floor(c[0]), sx);
          const j0 = clampI(Math.floor(c[1]), sy);
          const k0 = clampI(Math.floor(c[2]), sz);
          const i1 = Math.min(i0 + 1, sx - 1);
          const j1 = Math.min(j0 + 1, sy - 1);
          const k1 = Math.min(k0 + 1, sz - 1);
          const fx = clampI(c[0], sx) - i0;
          const fy = clampI(c[1], sy) - j0;
          const fz = clampI(c[2], sz) - k0;
          const at = (i: number, j: number, k: number) => src[i * stride[0] + j * stride[1] + k * stride[2]];
          const c00 = at(i0, j0, k0) * (1 - fx) + at(i1, j0, k0) * fx;
          const c10 = at(i0, j1, k0) * (1 - fx) + at(i1, j1, k0) * fx;
          const c01 = at(i0, j0, k1) * (1 - fx) + at(i1, j0, k1) * fx;
          const c11 = at(i0, j1, k1) * (1 - fx) + at(i1, j1, k1) * fx;
          v = (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz;
          out[x + nx * (y + ny * z)] = huToU8(v);
        }
      }
    }
    if (z % 8 === 7) {
      onProgress?.((z + 1) / nz);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  return out;
}

const GENERIC_COLORS: Vec3[] = [
  [0.36, 0.74, 0.98], [0.62, 0.55, 0.85], [0.34, 0.82, 0.78], [0.93, 0.33, 0.42],
  [0.95, 0.75, 0.3], [0.5, 0.85, 0.45], [0.85, 0.5, 0.75], [0.6, 0.7, 0.75],
];

/**
 * What the label values mean. Only the MSD liver convention is named; we do
 * not guess which organ an arbitrary id is.
 */
export function labelTable(present: number[]): { labels: LabelDef[]; kind: CaseMeta['kind'] } {
  const ids = present.filter((v) => v > 0);
  if (ids.length > 0 && ids.every((v) => v === 1 || v === 2) && ids.includes(1)) {
    return {
      kind: 'liver',
      labels: [
        { id: 1, key: 'liver', name: 'Liver', color: [0.74, 0.42, 0.36], role: 'organ' },
        ...(ids.includes(2) ? [{ id: 2, key: 'tumor', name: 'Tumour', color: [1.0, 0.36, 0.2] as Vec3, role: 'tumor' as const }] : []),
      ],
    };
  }
  return {
    kind: 'scan',
    labels: ids.slice(0, 32).map((id, i) => ({
      id,
      key: `structure_${id}`,
      name: `Structure ${id}`,
      color: GENERIC_COLORS[i % GENERIC_COLORS.length],
      role: 'context' as const,
    })),
  };
}

/** Distinct values in a label volume, ascending. */
export function distinctValues(a: Uint8Array): number[] {
  const seen = new Uint8Array(256);
  for (let i = 0; i < a.length; i++) seen[a[i]] = 1;
  const out: number[] = [];
  for (let v = 0; v < 256; v++) if (seen[v]) out.push(v);
  return out;
}

/** An uploaded CT (and optional label map) as a loadable case. */
export async function caseFromNifti(
  name: string,
  ct: NiftiImage,
  labelImg: NiftiImage | null,
  onProgress?: (label: string, f: number) => void,
): Promise<CaseData> {
  if (labelImg && labelImg.dims.some((d, i) => d !== ct.dims[i])) {
    throw new Error('The label map has a different grid size from the CT.');
  }
  const o = orientation(ct.affine);
  const extent = [0, 1, 2].map((w) => ct.dims[o.srcAxis[w]] * o.spacing[w]) as Vec3;
  const grid = outputGrid(extent, Math.min(...o.spacing));
  const volume = await resample(ct, grid, 'linear', (f) => onProgress?.('Resampling CT', f));
  let labels: Uint8Array = new Uint8Array(volume.length);
  let table = labelTable([]);
  if (labelImg) {
    labels = await resample(labelImg, grid, 'nearest', (f) => onProgress?.('Resampling labels', f));
    table = labelTable(distinctValues(labels));
    // Values beyond the 32 named ones are cleared rather than drawn unnamed.
    const keep = new Uint8Array(256);
    for (const l of table.labels) keep[l.id] = 1;
    for (let i = 0; i < labels.length; i++) if (!keep[labels[i]]) labels[i] = 0;
  }
  const meta: CaseMeta = {
    id: 'upload',
    name,
    kind: table.kind,
    shape: grid.shape,
    spacing: [grid.spacing, grid.spacing, grid.spacing],
    origin: [0, 0, 0],
    huRange: [-1000, 2000],
    huCurve: HU_CURVE,
    labels: table.labels,
    vesselIds: [],
    windowPresets: WINDOW_PRESETS,
    defaultPreset: 'soft',
  };
  return { meta, volume, labels, centerlines: null, meshes: null };
}
