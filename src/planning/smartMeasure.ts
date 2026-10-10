/**
 * Measurement that knows the anatomy.
 *
 *   snapCaliper        a caliper endpoint within a few mm of a structure's wall,
 *                      or of a landmark (renal artery origin, tumour extreme),
 *                      lands exactly on it, and the reading names what was
 *                      measured: "Tumour · 41.2 mm", "Tumour ↔ Portal vein"
 *   structureDistance  closest wall-to-wall distance between two structures
 *                      ("how far is the tumour from the portal vein"), with the
 *                      two closest points to draw
 *   namedCut           a sagittal / coronal / axial plane through a structure,
 *                      or N mm clear of it, on the side that keeps more organ
 *
 * Everything runs on the full-resolution label grid, so it is exact to the
 * segmentation's voxel and deterministic.
 */

import { edt3d } from './edt.ts';
import { axialDiameters, largestComponent, voxelsOf } from './anatomyMeasure.ts';
import type { CaseData, Plane, Vec3 } from '../types.ts';

/** Snap radius for walls along the caliper line, mm. */
export const WALL_SNAP_MM = 6;
/** Snap radius for named landmarks, mm. */
export const LANDMARK_SNAP_MM = 4;

interface Landmark {
  p: Vec3;
  name: string;
}

export interface SnappedCaliper {
  a: Vec3;
  b: Vec3;
  mm: number;
  /** What the caliper spans, when it can tell. */
  label: string | null;
}

/* ----------------------------------------------------------- label lookup */

function voxelOf(d: CaseData, p: Vec3): number {
  const { shape, spacing, origin } = d.meta;
  const i = Math.round((p[0] - origin[0]) / spacing[0]);
  const j = Math.round((p[1] - origin[1]) / spacing[1]);
  const k = Math.round((p[2] - origin[2]) / spacing[2]);
  if (i < 0 || j < 0 || k < 0 || i >= shape[0] || j >= shape[1] || k >= shape[2]) return -1;
  return i + shape[0] * (j + shape[1] * k);
}

/** Label id at a world point (0 outside the grid). */
export function labelAt(d: CaseData, p: Vec3): number {
  const v = voxelOf(d, p);
  return v < 0 ? 0 : d.labels[v];
}

function nameOf(d: CaseData, id: number): string {
  return d.meta.labels.find((l) => l.id === id)?.name ?? 'structure';
}

/* -------------------------------------------------------------- landmarks */

const landmarkCache = new WeakMap<CaseData, Landmark[]>();

/** Named points a caliper end can snap to; computed once per case. */
export function landmarks(d: CaseData): Landmark[] {
  const hit = landmarkCache.get(d);
  if (hit) return hit;
  const out: Landmark[] = [];
  for (const o of d.centerlines?.renalOstia ?? []) {
    out.push({ p: o.p, name: `${o.side === 'left' ? 'L' : 'R'} renal artery` });
  }
  const tumorId = d.meta.labels.find((l) => l.role === 'tumor')?.id;
  if (tumorId) {
    const v = { shape: d.meta.shape, spacing: d.meta.spacing, origin: d.meta.origin, labels: d.labels };
    const ax = axialDiameters(v, largestComponent(v, voxelsOf(v, [tumorId])));
    if (ax) out.push({ p: ax.a, name: 'Tumour edge' }, { p: ax.b, name: 'Tumour edge' });
  }
  landmarkCache.set(d, out);
  return out;
}

/* -------------------------------------------------------------- snapping */

interface EndSnap {
  p: Vec3;
  /** Label id on the inside of the caliper at this end (0 if none). */
  inner: number;
  /** Label id just outside it: what this end rests against. */
  outer: number;
  landmark: string | null;
}

/**
 * Snap one end. `toward` points from this end to the other one. Candidates
 * are the nearest label boundary along the caliper line within WALL_SNAP_MM
 * and the nearest named landmark within LANDMARK_SNAP_MM; the closer wins.
 */
function snapEnd(d: CaseData, p: Vec3, toward: Vec3): EndSnap {
  let best: Landmark | null = null;
  let bd = LANDMARK_SNAP_MM;
  for (const l of landmarks(d)) {
    const dd = Math.hypot(l.p[0] - p[0], l.p[1] - p[1], l.p[2] - p[2]);
    if (dd < bd) [bd, best] = [dd, l];
  }

  const step = 0.5;
  const at = (t: number): Vec3 => [p[0] + toward[0] * t, p[1] + toward[1] * t, p[2] + toward[2] * t];
  let bestT: number | null = null;
  let inner = 0;
  let outer = 0;
  for (let t = -WALL_SNAP_MM; t < WALL_SNAP_MM; t += step) {
    const l0 = labelAt(d, at(t));
    const l1 = labelAt(d, at(t + step));
    if (l0 === l1) continue;
    const mid = t + step / 2;
    if (bestT === null || Math.abs(mid) < Math.abs(bestT)) {
      bestT = mid;
      inner = l1; // the side toward the other end
      outer = l0;
    }
  }
  if (best && (bestT === null || bd < Math.abs(bestT))) {
    const id = labelAt(d, best.p);
    return { p: best.p, inner: id, outer: id, landmark: best.name };
  }
  if (bestT === null) {
    const id = labelAt(d, p);
    return { p, inner: id, outer: id, landmark: null };
  }
  return { p: at(bestT), inner, outer, landmark: null };
}

export function snapCaliper(d: CaseData, a: Vec3, b: Vec3): SnappedCaliper {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  if (len < 1e-6) return { a, b, mm: 0, label: null };
  const u: Vec3 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len, (b[2] - a[2]) / len];
  const sa = snapEnd(d, a, u);
  const sb = snapEnd(d, b, [-u[0], -u[1], -u[2]]);
  const mm = Math.hypot(sb.p[0] - sa.p[0], sb.p[1] - sa.p[1], sb.p[2] - sa.p[2]);
  // Each end is named by what it rests against (or sits in).
  const end = (s: EndSnap) => s.landmark ?? (s.outer ? nameOf(d, s.outer) : s.inner ? nameOf(d, s.inner) : null);
  let label: string | null = null;
  if (sa.landmark === 'Tumour edge' && sb.landmark === 'Tumour edge') label = 'Tumour, longest axial';
  else if (!sa.landmark && !sb.landmark && sa.inner && sa.inner === sb.inner) label = nameOf(d, sa.inner);
  else if (end(sa) && end(sb)) label = `${end(sa)} ↔ ${end(sb)}`;
  return { a: sa.p, b: sb.p, mm, label };
}

/* --------------------------------------------------- structure distances */

export interface StructureDistance {
  /** Closest wall-to-wall gap, mm (0 when they touch). */
  mm: number;
  a: Vec3;
  b: Vec3;
  touching: boolean;
}

/** Label ids for a spoken structure key, including group words. */
export function idsFor(d: CaseData, key: string): number[] {
  const L = d.meta.labels;
  if (key === 'vessels') return L.filter((l) => l.role === 'vessel' && l.key !== 'aorta').map((l) => l.id);
  if (key === 'kidneys') return L.filter((l) => l.key.startsWith('kidney')).map((l) => l.id);
  return L.filter((l) => l.key === key).map((l) => l.id);
}

/** A distance field from structure A over its bounding box grown by `reachMm`. */
interface Field {
  dist: Float32Array;
  lo: number[];
  hi: number[];
  local: (p: number[]) => number;
  ijk: (id: number) => number[];
  world: (p: number[]) => Vec3;
  vox: number;
  A: Int32Array;
}

function fieldFrom(d: CaseData, A: Int32Array, reachMm: number): Field {
  const [nx, ny, nz] = d.meta.shape;
  const sp = d.meta.spacing;
  const o = d.meta.origin;
  const ijk = (id: number) => {
    const i = id % nx;
    const j = ((id - i) / nx) % ny;
    return [i, j, Math.floor(id / (nx * ny))];
  };
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const id of A) {
    const p = ijk(id);
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], p[k]);
      hi[k] = Math.max(hi[k], p[k]);
    }
  }
  const dims = [nx, ny, nz];
  for (let k = 0; k < 3; k++) {
    const r = Math.ceil(reachMm / sp[k]);
    lo[k] = Math.max(0, lo[k] - r);
    hi[k] = Math.min(dims[k] - 1, hi[k] + r);
  }
  const [bx, by, bz] = [hi[0] - lo[0] + 1, hi[1] - lo[1] + 1, hi[2] - lo[2] + 1];
  const local = (p: number[]) => p[0] - lo[0] + bx * (p[1] - lo[1] + by * (p[2] - lo[2]));
  const seed = new Uint8Array(bx * by * bz);
  for (const id of A) seed[local(ijk(id))] = 1;
  const dist = edt3d(seed, { nx: bx, ny: by, nz: bz, spacing: [...sp] as [number, number, number] });
  const world = (p: number[]): Vec3 => [o[0] + p[0] * sp[0], o[1] + p[1] * sp[1], o[2] + p[2] * sp[2]];
  return { dist, lo, hi, local, ijk, world, vox: (sp[0] + sp[1] + sp[2]) / 3, A };
}

/** Closest voxel of B to the field's structure, then its partner in A. */
function closestIn(f: Field, B: Int32Array, reachMm: number): StructureDistance | null {
  let best = Infinity;
  let bestB = -1;
  for (const id of B) {
    const p = f.ijk(id);
    if (p[0] < f.lo[0] || p[0] > f.hi[0] || p[1] < f.lo[1] || p[1] > f.hi[1] || p[2] < f.lo[2] || p[2] > f.hi[2]) continue;
    const dd = f.dist[f.local(p)];
    if (dd < best) [best, bestB] = [dd, id];
  }
  if (bestB < 0 || best > reachMm) return null;
  const wb = f.world(f.ijk(bestB));
  let wa: Vec3 = wb;
  let ad = Infinity;
  for (const id of f.A) {
    const q = f.world(f.ijk(id));
    const dd = (q[0] - wb[0]) ** 2 + (q[1] - wb[1]) ** 2 + (q[2] - wb[2]) ** 2;
    if (dd < ad) [ad, wa] = [dd, q];
  }
  // Centre-to-centre distance overstates the gap between the two surfaces by
  // about one voxel (each surface sits half a voxel out from its centres).
  return { mm: Math.max(0, best - f.vox), a: wa, b: wb, touching: best <= f.vox * 1.01 };
}

function voxOf(d: CaseData, ids: number[]): Int32Array {
  return voxelsOf({ shape: d.meta.shape, spacing: d.meta.spacing, origin: d.meta.origin, labels: d.labels }, ids);
}

/**
 * Closest approach of structure B to structure A. The EDT runs from the
 * smaller structure over its bounding box grown by `reachMm`; null when B is
 * further than that.
 */
export function structureDistance(d: CaseData, aIds: number[], bIds: number[], reachMm = 60): StructureDistance | null {
  let A = voxOf(d, aIds);
  let B = voxOf(d, bIds);
  if (A.length === 0 || B.length === 0) return null;
  const swapped = A.length > B.length;
  if (swapped) [A, B] = [B, A];
  const r = closestIn(fieldFrom(d, A, reachMm), B, reachMm);
  if (!r || !swapped) return r;
  return { ...r, a: r.b, b: r.a };
}

export interface NearestCandidate extends StructureDistance {
  /** Label id of the candidate structure. */
  id: number;
}

/**
 * "Where is the tumour closest to a vessel": one distance field from A, read
 * off for every candidate label; candidates sorted nearest first (those
 * beyond `reachMm` are left out).
 */
export function nearestAmong(d: CaseData, aIds: number[], candidateIds: number[], reachMm = 80): NearestCandidate[] {
  const A = voxOf(d, aIds);
  if (A.length === 0) return [];
  const f = fieldFrom(d, A, reachMm);
  const out: NearestCandidate[] = [];
  for (const id of candidateIds) {
    const B = voxOf(d, [id]);
    if (B.length === 0) continue;
    const r = closestIn(f, B, reachMm);
    if (r) out.push({ ...r, id });
  }
  return out.sort((x, y) => x.mm - y.mm);
}

/* -------------------------------------------------------------- named cut */

export type Orientation = 'sagittal' | 'coronal' | 'axial';

const AXIS: Record<Orientation, Vec3> = {
  sagittal: [1, 0, 0],
  coronal: [0, 1, 0],
  axial: [0, 0, 1],
};

/**
 * A plane of the named orientation. Through the structure's centroid, or
 * `offsetMm` clear of it (the structure entirely on the resected side, the
 * cut `offsetMm` from its nearest voxel). Of the two sides, the one `score`
 * rates higher wins (the caller passes remnant %, so the smaller piece goes).
 */
export function namedCut(
  d: CaseData,
  orientation: Orientation,
  ids: number[],
  offsetMm: number | null,
  score: (p: Plane) => number,
): Plane | null {
  const v = { shape: d.meta.shape, spacing: d.meta.spacing, origin: d.meta.origin, labels: d.labels };
  const vox = voxelsOf(v, ids);
  if (vox.length === 0) return null;
  const [nx, ny] = v.shape;
  const axisIdx = orientation === 'sagittal' ? 0 : orientation === 'coronal' ? 1 : 2;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const id of vox) {
    const i = id % nx;
    const j = ((id - i) / nx) % ny;
    const k = Math.floor(id / (nx * ny));
    const c = v.origin[axisIdx] + [i, j, k][axisIdx] * v.spacing[axisIdx];
    min = Math.min(min, c);
    max = Math.max(max, c);
    sum += c;
  }
  const centre = sum / vox.length;
  const a = AXIS[orientation];
  const neg: Vec3 = [a[0] ? -a[0] : 0, a[1] ? -a[1] : 0, a[2] ? -a[2] : 0];
  const half = v.spacing[axisIdx] / 2;
  const candidates: Plane[] =
    offsetMm === null
      ? [
          { n: a, d: centre },
          { n: neg, d: -centre },
        ]
      : [
          // Structure on the positive (resected) side of n.x = d.
          { n: a, d: min - half - offsetMm },
          { n: neg, d: -(max + half + offsetMm) },
        ];
  return candidates.reduce((best, p) => (score(p) > score(best) ? p : best));
}

/** "At the renal arteries": an axial plane at the lowest renal ostium. */
export function renalLevelCut(d: CaseData): Plane | null {
  const o = d.centerlines?.renalOstia ?? [];
  if (o.length === 0) return null;
  const z = Math.min(...o.map((x) => x.p[2]));
  return { n: [0, 0, -1], d: -z };
}
