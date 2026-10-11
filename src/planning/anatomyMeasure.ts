/**
 * "Scrub, measure the <structure>": the measurement a radiologist or surgeon
 * actually reports for that structure, taken from its 3D mask, next to the
 * published reference range it is read against.
 *
 * Every method and range is sourced in docs/CLINICAL.md (§ Measurements). The
 * honest limits are part of each result's notes rather than buried: masks are
 * on a 1.5 mm grid, the aorta and veins are segmented lumen-like, and CT
 * normal ranges differ by population.
 *
 *   tumour       RECIST 1.1 longest axial diameter, perpendicular short axis,
 *                volume (edge to edge: centre distance + one voxel)
 *   liver        volume, healthy volume (minus tumour), craniocaudal extent
 *   aorta        inscribed diameter along the centerline, max and min, and
 *                the infrarenal segment's
 *   kidney       pole-to-pole length (principal axis), volume
 *   portal vein  inscribed diameter of the trunk near the liver hilum
 *   IVC          AP and transverse diameter at the renal level
 */

import { edt3d } from './edt.ts';
import type { CaseData, Vec3 } from '../types.ts';

export interface MeasureRow {
  label: string;
  value: string;
  /** Reference range or threshold, with where it comes from. */
  ref?: string;
  /** Outside the reference range. */
  flag?: boolean;
}

export interface Measurement {
  title: string;
  rows: MeasureRow[];
  /** Short caveats that change how the numbers should be read. */
  notes: string[];
  /** The one line spoken aloud. */
  speech: string;
  /** The headline dimension, drawn as a caliper. */
  caliper: { a: Vec3; b: Vec3; mm: number } | null;
}

interface Vox {
  shape: Vec3;
  spacing: Vec3;
  origin: Vec3;
  labels: Uint8Array;
}

/** Voxel index list of one label, or of several. */
export function voxelsOf(v: Vox, ids: number[]): Int32Array {
  const set = new Uint8Array(256);
  // Only real label ids (1..255): 0 is background, and a missing structure
  // (-1) must select nothing rather than every empty voxel.
  for (const id of ids) if (id > 0 && id < 256) set[id] = 1;
  let n = 0;
  for (let i = 0; i < v.labels.length; i++) if (set[v.labels[i]]) n++;
  const out = new Int32Array(n);
  n = 0;
  for (let i = 0; i < v.labels.length; i++) if (set[v.labels[i]]) out[n++] = i;
  return out;
}

/**
 * The largest 6-connected component: RECIST measures a lesion, and a stray
 * few-voxel speck elsewhere in the label (liver_36 has one) is not part of it.
 */
export function largestComponent(v: Vox, idx: Int32Array): Int32Array {
  const [nx, ny] = v.shape;
  const nxy = nx * ny;
  const inSet = new Set<number>(idx);
  const seen = new Set<number>();
  let best: number[] = [];
  for (const start of idx) {
    if (seen.has(start)) continue;
    const comp: number[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const c = stack.pop()!;
      comp.push(c);
      const i = c % nx;
      const j = ((c - i) / nx) % ny;
      for (const nb of [i > 0 ? c - 1 : -1, i < nx - 1 ? c + 1 : -1, j > 0 ? c - nx : -1, j < ny - 1 ? c + nx : -1, c - nxy, c + nxy]) {
        if (nb >= 0 && inSet.has(nb) && !seen.has(nb)) {
          seen.add(nb);
          stack.push(nb);
        }
      }
    }
    if (comp.length > best.length) best = comp;
  }
  return Int32Array.from(best);
}

function ijk(v: Vox, idx: number): [number, number, number] {
  const [nx, ny] = v.shape;
  const i = idx % nx;
  const j = ((idx - i) / nx) % ny;
  return [i, j, Math.floor(idx / (nx * ny))];
}

function world(v: Vox, i: number, j: number, k: number): Vec3 {
  return [v.origin[0] + i * v.spacing[0], v.origin[1] + j * v.spacing[1], v.origin[2] + k * v.spacing[2]];
}

const mm = (x: number) => `${x.toFixed(1)} mm`;
const ml = (x: number) => `${Math.round(x)} mL`;
const volumeMl = (v: Vox, n: number) => (n * v.spacing[0] * v.spacing[1] * v.spacing[2]) / 1000;

/**
 * RECIST 1.1: the longest diameter in any axial slice, and the widest extent
 * perpendicular to it in that slice. Brute force over each slice's boundary
 * voxels (a 4 cm lesion is a few hundred per slice). Distances are between
 * voxel centres, so one voxel is added to read edge to edge.
 */
export function axialDiameters(v: Vox, idx: Int32Array): { long: number; short: number; a: Vec3; b: Vec3 } | null {
  if (idx.length === 0) return null;
  const [nx, ny] = v.shape;
  const [sx, sy] = v.spacing;
  const inMask = new Set<number>(idx);
  const bySlice = new Map<number, [number, number][]>();
  for (const id of idx) {
    const [i, j, k] = ijk(v, id);
    // Boundary voxels only: an interior voxel can never be an extreme point.
    const interior =
      i > 0 && i < nx - 1 && j > 0 && j < ny - 1 &&
      inMask.has(id - 1) && inMask.has(id + 1) && inMask.has(id - nx) && inMask.has(id + nx);
    if (interior) continue;
    let s = bySlice.get(k);
    if (!s) bySlice.set(k, (s = []));
    s.push([i, j]);
  }
  let best = { d2: -1, k: 0, p: [0, 0] as [number, number], q: [0, 0] as [number, number] };
  for (const [k, pts] of bySlice) {
    for (let a = 0; a < pts.length; a++) {
      for (let b = a + 1; b < pts.length; b++) {
        const dx = (pts[a][0] - pts[b][0]) * sx;
        const dy = (pts[a][1] - pts[b][1]) * sy;
        const d2 = dx * dx + dy * dy;
        if (d2 > best.d2) best = { d2, k, p: pts[a], q: pts[b] };
      }
    }
  }
  if (best.d2 < 0) return null;
  const long = Math.sqrt(best.d2);
  // Short axis: extent across the long axis, same slice.
  const ux = ((best.q[0] - best.p[0]) * sx) / (long || 1);
  const uy = ((best.q[1] - best.p[1]) * sy) / (long || 1);
  let lo = Infinity;
  let hi = -Infinity;
  for (const [i, j] of bySlice.get(best.k) ?? []) {
    const t = -uy * i * sx + ux * j * sy;
    lo = Math.min(lo, t);
    hi = Math.max(hi, t);
  }
  const vox = (sx + sy) / 2;
  return {
    long: long + vox,
    short: hi - lo + vox,
    a: world(v, best.p[0], best.p[1], best.k),
    b: world(v, best.q[0], best.q[1], best.k),
  };
}

/** Top-to-bottom extent along z, edge to edge. */
function zExtent(v: Vox, idx: Int32Array): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const id of idx) {
    const k = ijk(v, id)[2];
    lo = Math.min(lo, k);
    hi = Math.max(hi, k);
  }
  return (hi - lo + 1) * v.spacing[2];
}

/** Length along the principal axis (pole to pole for a kidney), edge to edge. */
export function principalLength(v: Vox, idx: Int32Array): { len: number; a: Vec3; b: Vec3 } | null {
  if (idx.length < 2) return null;
  const pts: Vec3[] = [];
  const c: Vec3 = [0, 0, 0];
  for (const id of idx) {
    const p = world(v, ...ijk(v, id));
    pts.push(p);
    c[0] += p[0] / idx.length;
    c[1] += p[1] / idx.length;
    c[2] += p[2] / idx.length;
  }
  const C = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const p of pts) {
    const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) C[r * 3 + s] += d[r] * d[s];
  }
  // Power iteration: the dominant eigenvector of the covariance.
  let u: Vec3 = [0.3, 0.4, 0.86];
  for (let it = 0; it < 50; it++) {
    const w: Vec3 = [
      C[0] * u[0] + C[1] * u[1] + C[2] * u[2],
      C[3] * u[0] + C[4] * u[1] + C[5] * u[2],
      C[6] * u[0] + C[7] * u[1] + C[8] * u[2],
    ];
    const n = Math.hypot(...w) || 1;
    u = [w[0] / n, w[1] / n, w[2] / n];
  }
  let lo = Infinity;
  let hi = -Infinity;
  let a = pts[0];
  let b = pts[0];
  for (const p of pts) {
    const t = (p[0] - c[0]) * u[0] + (p[1] - c[1]) * u[1] + (p[2] - c[2]) * u[2];
    if (t < lo) [lo, a] = [t, p];
    if (t > hi) [hi, b] = [t, p];
  }
  const vox = (v.spacing[0] + v.spacing[1] + v.spacing[2]) / 3;
  return { len: hi - lo + vox, a, b };
}

/**
 * Largest inscribed diameter of a tubular structure, optionally only where
 * `keep` accepts the voxel. The EDT is run on the structure's bounding box;
 * the distance to the nearest outside voxel centre overstates the radius by
 * about half a voxel, hence the correction.
 */
export function inscribedDiameter(
  v: Vox,
  idx: Int32Array,
  keep: (i: number, j: number, k: number) => boolean = () => true,
): { d: number; at: Vec3 } | null {
  if (idx.length === 0) return null;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const id of idx) {
    const p = ijk(v, id);
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], p[a] - 1);
      hi[a] = Math.max(hi[a], p[a] + 1);
    }
  }
  const [bx, by, bz] = [hi[0] - lo[0] + 1, hi[1] - lo[1] + 1, hi[2] - lo[2] + 1];
  const seed = new Uint8Array(bx * by * bz).fill(1);
  for (const id of idx) {
    const [i, j, k] = ijk(v, id);
    seed[i - lo[0] + bx * (j - lo[1] + by * (k - lo[2]))] = 0;
  }
  const dist = edt3d(seed, { nx: bx, ny: by, nz: bz, spacing: [...v.spacing] as [number, number, number] });
  let best = -1;
  let at: Vec3 = [0, 0, 0];
  for (const id of idx) {
    const [i, j, k] = ijk(v, id);
    if (!keep(i, j, k)) continue;
    const d = dist[i - lo[0] + bx * (j - lo[1] + by * (k - lo[2]))];
    if (d > best) {
      best = d;
      at = world(v, i, j, k);
    }
  }
  if (best < 0) return null;
  const vox = (v.spacing[0] + v.spacing[1] + v.spacing[2]) / 3;
  return { d: Math.max(0, 2 * best - vox), at };
}

/* ----------------------------------------------------------- per structure */

/** Structure keys this module can measure, for the voice grammar and help. */
export const MEASURABLE = ['tumor', 'liver', 'aorta', 'kidneys', 'kidney_left', 'kidney_right', 'portal_vein', 'ivc'];

export function measureStructure(data: CaseData, what: string): Measurement | null {
  const v: Vox = { shape: data.meta.shape, spacing: data.meta.spacing, origin: data.meta.origin, labels: data.labels };
  // -1 when the structure is not in this segmentation: it selects no voxels.
  const id = (key: string) => data.meta.labels.find((l) => l.key === key)?.id ?? -1;

  switch (what) {
    case 'tumor': {
      // Outside a liver case (a lung or colon tumour, say) the liver-surgery
      // rows do not apply: the generic tumour measurement does.
      if (data.meta.kind !== 'liver') return measureGeneric(data, v, 'tumor');
      const t = largestComponent(v, voxelsOf(v, [id('tumor')]));
      const ax = axialDiameters(v, t);
      if (!ax) return null;
      const vol = volumeMl(v, t.length);
      return {
        title: 'Tumour',
        rows: [
          { label: 'Longest axial diameter', value: mm(ax.long), ref: 'RECIST 1.1 target lesion: ≥10 mm on CT' },
          { label: 'Short axis (same slice)', value: mm(ax.short) },
          { label: 'Volume', value: `${vol.toFixed(1)} mL` },
          { label: 'Craniocaudal extent', value: mm(zExtent(v, t)) },
          { label: 'Resection goal', value: 'R0 margin', ref: '≥1 mm floor; ≥10 mm associated with better survival' },
        ],
        notes: ['Edge to edge on a 1.5 mm grid (±1.5 mm).'],
        speech: `Tumor ${Math.round(ax.long)} by ${Math.round(ax.short)} millimeters, ${vol.toFixed(0)} milliliters.`,
        caliper: { a: ax.a, b: ax.b, mm: ax.long },
      };
    }

    case 'liver': {
      const liver = voxelsOf(v, [id('liver'), id('tumor')]);
      if (liver.length === 0) return null;
      const tumorN = voxelsOf(v, [id('tumor')]).length;
      let zlo = Infinity;
      let zhi = -Infinity;
      let pa: Vec3 = [0, 0, 0];
      let pb: Vec3 = [0, 0, 0];
      for (const i of liver) {
        const p = ijk(v, i);
        if (p[2] < zlo) [zlo, pa] = [p[2], world(v, ...p)];
        if (p[2] > zhi) [zhi, pb] = [p[2], world(v, ...p)];
      }
      const cc = (zhi - zlo + 1) * v.spacing[2];
      const total = volumeMl(v, liver.length);
      return {
        title: 'Liver',
        rows: [
          { label: 'Total volume', value: ml(total) },
          { label: 'Healthy volume (minus tumour)', value: ml(total - volumeMl(v, tumorN)) },
          {
            label: 'Craniocaudal extent',
            value: mm(cc),
            ref: 'Enlarged above ~160 mm (midclavicular span, which reads shorter)',
            flag: cc > 160,
          },
          { label: 'Safe remnant', value: '≥20 / 30 / 40 %', ref: 'normal / after chemotherapy / cirrhosis' },
        ],
        notes: ['Standardized liver volume needs height and weight, which a CT does not carry.'],
        speech: `Liver ${Math.round(total)} milliliters, ${Math.round(cc / 10)} centimeters top to bottom.`,
        caliper: { a: pa, b: [pa[0], pa[1], pb[2]], mm: cc },
      };
    }

    case 'kidneys':
    case 'kidney_left':
    case 'kidney_right': {
      const sides = what === 'kidneys' ? ['kidney_left', 'kidney_right'] : [what];
      const rows: MeasureRow[] = [];
      const said: string[] = [];
      let caliper: Measurement['caliper'] = null;
      for (const key of sides) {
        const k = voxelsOf(v, [id(key)]);
        const pl = principalLength(v, k);
        if (!pl) continue;
        const side = key === 'kidney_left' ? 'Left' : 'Right';
        // A kidney cut off by the scan's edge would read short.
        const zs = Array.from(k, (i) => ijk(v, i)[2]);
        const clipped = Math.min(...zs) === 0 || Math.max(...zs) === v.shape[2] - 1;
        rows.push({
          label: `${side} kidney length`,
          value: mm(pl.len) + (clipped ? ' (cut off by scan)' : ''),
          ref: 'Normal 100–130 mm',
          flag: !clipped && (pl.len < 100 || pl.len > 130),
        });
        rows.push({ label: `${side} kidney volume`, value: ml(volumeMl(v, k.length)) });
        said.push(clipped ? `${side.toLowerCase()} cut off by the scan` : `${side.toLowerCase()} ${Math.round(pl.len / 10)} centimeters`);
        caliper ??= { a: pl.a, b: pl.b, mm: pl.len };
      }
      if (rows.length === 0) return null;
      return {
        title: sides.length > 1 ? 'Kidneys' : `${what === 'kidney_left' ? 'Left' : 'Right'} kidney`,
        rows,
        notes: ['Pole-to-pole along the principal axis; the label may include renal sinus fat.'],
        speech: `Kidney length ${said.join(', ')}.`,
        caliper,
      };
    }

    case 'aorta': {
      const pts = data.centerlines?.vessels.aorta;
      if (!pts || pts.length < 2) return null;
      const ostia = data.centerlines?.renalOstia ?? [];
      // The lowest renal ostium splits the aorta into supra- and infrarenal.
      const zRenal = ostia.length ? Math.min(...ostia.map((o) => o.p[2])) : -Infinity;
      const d = pts.map((p) => ({ z: p.p[2], d: 2 * p.r, p: p.p }));
      const infra = d.filter((x) => x.z < zRenal);
      const max = d.reduce((a, b) => (b.d > a.d ? b : a));
      const iMax = infra.length ? infra.reduce((a, b) => (b.d > a.d ? b : a)) : null;
      const iMin = infra.length ? infra.reduce((a, b) => (b.d < a.d ? b : a)) : null;
      const rows: MeasureRow[] = [
        {
          label: 'Max diameter (whole segment)',
          value: mm(max.d),
          ref: 'Aneurysm ≥30 mm; repair 55 mm men / 50 mm women (ESVS 2024)',
          flag: max.d >= 30,
        },
      ];
      if (iMax && iMin) {
        rows.push({
          label: 'Infrarenal diameter',
          value: `${iMin.d.toFixed(1)}–${iMax.d.toFixed(1)} mm`,
          ref: 'Normal ~15–20 mm',
          flag: iMax.d >= 30,
        });
      }
      return {
        title: 'Abdominal aorta',
        rows,
        notes: [
          'Inscribed (lumen-like) diameter; planners measure outer wall, which reads 3–6 mm larger.',
          'A ~17 mm neck is at the lower limit of several devices’ IFU range (17–32 mm).',
        ],
        speech: `Aorta ${Math.round(max.d)} millimeters at its widest. ${max.d >= 30 ? 'Aneurysmal.' : 'Not aneurysmal.'}`,
        caliper: null,
      };
    }

    case 'portal_vein': {
      const pv = voxelsOf(v, [id('portal_vein')]);
      const liverId = id('liver');
      if (pv.length === 0 || liverId < 0) return null;
      // The trunk near the hilum: portal voxels within ~20 mm of the liver,
      // which leaves out the splenic vein that shares the label.
      const liver = voxelsOf(v, [liverId]);
      const near = new Uint8Array(v.labels.length);
      const [nx, ny, nz] = v.shape;
      const r = Math.round(20 / v.spacing[0]);
      const rz = Math.round(20 / v.spacing[2]);
      // Mark the liver's bounding neighbourhood cheaply: dilate in a box.
      const liverSet = new Uint8Array(v.labels.length);
      for (const i of liver) liverSet[i] = 1;
      for (const id0 of pv) {
        const [i, j, k] = ijk(v, id0);
        let hit = false;
        for (let dk = -rz; dk <= rz && !hit; dk += 2)
          for (let dj = -r; dj <= r && !hit; dj += 3)
            for (let di = -r; di <= r && !hit; di += 3) {
              const a = i + di, b = j + dj, c = k + dk;
              if (a < 0 || b < 0 || c < 0 || a >= nx || b >= ny || c >= nz) continue;
              if (liverSet[a + nx * (b + ny * c)]) hit = true;
            }
        if (hit) near[id0] = 1;
      }
      const res = inscribedDiameter(v, pv, (i, j, k) => near[i + nx * (j + ny * k)] === 1);
      if (!res) return null;
      return {
        title: 'Portal vein',
        rows: [
          {
            label: 'Trunk diameter near hilum',
            value: mm(res.d),
            ref: '>13 mm suggests portal hypertension (ultrasound rule); CT normal ~15.5 ± 1.9 mm',
            flag: res.d > 17.4,
          },
        ],
        notes: ['A 13 mm vein is ~9 voxels across: expect ±1.5 mm.', 'Portal hypertension lowers the safe remnant.'],
        speech: `Portal vein about ${Math.round(res.d)} millimeters.`,
        caliper: null,
      };
    }

    case 'ivc': {
      const ivc = voxelsOf(v, [id('ivc')]);
      if (ivc.length === 0) return null;
      // Renal level: the slice of the lowest renal ostium, else mid-IVC.
      const ostia = data.centerlines?.renalOstia ?? [];
      const zs = Array.from(ivc, (i) => ijk(v, i)[2]);
      const kMid = Math.round((Math.min(...zs) + Math.max(...zs)) / 2);
      const k0 = ostia.length
        ? Math.round((Math.min(...ostia.map((o) => o.p[2])) - v.origin[2]) / v.spacing[2])
        : kMid;
      const kSlice = zs.includes(k0) ? k0 : kMid;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const id0 of ivc) {
        const [i, j, k] = ijk(v, id0);
        if (k !== kSlice) continue;
        x0 = Math.min(x0, i); x1 = Math.max(x1, i);
        y0 = Math.min(y0, j); y1 = Math.max(y1, j);
      }
      const ap = (y1 - y0 + 1) * v.spacing[1];
      const tr = (x1 - x0 + 1) * v.spacing[0];
      return {
        title: 'Inferior vena cava',
        rows: [
          { label: 'AP diameter', value: mm(ap), ref: '16.3 ± 2.9 mm (CT, n = 200)' },
          { label: 'Transverse diameter', value: mm(tr), ref: '25.8 ± 3.5 mm' },
        ],
        notes: [
          ostia.length ? 'Axial slice at the lowest renal artery level.' : 'Axial slice at mid-IVC.',
          'Collapsibility needs ultrasound over breathing; a static CT cannot give it.',
        ],
        speech: `I V C ${Math.round(ap)} by ${Math.round(tr)} millimeters.`,
        caliper: null,
      };
    }

    default:
      return measureGeneric(data, v, what);
  }
}

/**
 * Any other named structure (an uploaded spleen, pancreas, lung tumour...):
 * tumours get the RECIST diameters, organs their volume and dimensions. No
 * reference range is shown, because none has been checked for it here.
 */
function measureGeneric(data: CaseData, v: Vox, key: string): Measurement | null {
  const label = data.meta.labels.find((l) => l.key === key);
  if (!label) return null;
  const idx = largestComponent(v, voxelsOf(v, [label.id]));
  if (idx.length === 0) return null;
  const vol = volumeMl(v, idx.length);
  if (label.role === 'tumor') {
    const ax = axialDiameters(v, idx);
    if (!ax) return null;
    return {
      title: label.name,
      rows: [
        { label: 'Longest axial diameter', value: mm(ax.long), ref: 'RECIST 1.1 target lesion: ≥10 mm on CT' },
        { label: 'Short axis (same slice)', value: mm(ax.short) },
        { label: 'Volume', value: `${vol.toFixed(1)} mL` },
      ],
      notes: [`Edge to edge on a ${v.spacing[0].toFixed(1)} mm grid.`],
      speech: `${label.name} ${Math.round(ax.long)} by ${Math.round(ax.short)} millimeters, ${vol.toFixed(vol < 10 ? 1 : 0)} milliliters.`,
      caliper: { a: ax.a, b: ax.b, mm: ax.long },
    };
  }
  const pl = principalLength(v, idx);
  const z = zExtent(v, idx);
  return {
    title: label.name,
    rows: [
      { label: 'Volume', value: ml(vol) },
      ...(pl ? [{ label: 'Longest dimension', value: mm(pl.len) }] : []),
      { label: 'Top-to-bottom extent', value: mm(z) },
    ],
    notes: ['No reference range is shown for this structure.'],
    speech: `${label.name} ${Math.round(vol)} milliliters${pl ? `, ${Math.round(pl.len / 10)} centimeters long` : ''}.`,
    caliper: pl ? { a: pl.a, b: pl.b, mm: pl.len } : null,
  };
}
