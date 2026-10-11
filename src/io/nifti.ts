/**
 * A small NIfTI reader for scans uploaded in the browser (.nii / .nii.gz).
 *
 * NIfTI-1 and NIfTI-2, little or big endian, gzip via the browser's own
 * DecompressionStream (no dependency), the common voxel types, scl_slope /
 * scl_inter, and the sform (preferred) or qform orientation. The voxel axes
 * are then reoriented to RAS+ exactly like the pipeline's
 * nibabel.as_closest_canonical, so an uploaded scan lands in the same frame
 * as the shipped cases.
 *
 * Separate .hdr/.img pairs and DICOM are not read here; convert DICOM with
 * dcm2niix first (docs/EXTRAS.md).
 */

import type { Vec3 } from '../types.ts';

export interface NiftiImage {
  /** Voxel grid size along the file's own axes. */
  dims: [number, number, number];
  /** Voxel values after scl_slope / scl_inter (HU for CT), x fastest. */
  data: Float32Array;
  /** 3x4 voxel-to-world (RAS+ mm) affine, row-major. */
  affine: number[][];
}

export class NiftiError extends Error {}

/** Gunzip if the bytes start with the gzip magic; otherwise return them. */
export async function maybeGunzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const b = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
  if (b[0] !== 0x1f || b[1] !== 0x8b) return buf;
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

export async function readNifti(input: ArrayBuffer): Promise<NiftiImage> {
  const buf = await maybeGunzip(input);
  if (buf.byteLength < 348) throw new NiftiError('File is too small to be NIfTI.');
  const dv = new DataView(buf);
  let le = true;
  let size = dv.getInt32(0, true);
  if (size !== 348 && size !== 540) {
    le = false;
    size = dv.getInt32(0, false);
  }
  if (size === 348) return parse1(dv, le);
  if (size === 540) return parse2(dv, le);
  throw new NiftiError('Not a NIfTI file (bad header size).');
}

function parse1(dv: DataView, le: boolean): NiftiImage {
  const magic = String.fromCharCode(dv.getUint8(344), dv.getUint8(345), dv.getUint8(346));
  if (magic === 'ni1') throw new NiftiError('Separate .hdr/.img NIfTI is not supported; save as a single .nii or .nii.gz.');
  if (magic !== 'n+1') throw new NiftiError('Not a NIfTI-1 file (bad magic).');
  const dim = Array.from({ length: 8 }, (_, i) => dv.getInt16(40 + 2 * i, le));
  const pixdim = Array.from({ length: 8 }, (_, i) => dv.getFloat32(76 + 4 * i, le));
  const h: Header = {
    dim,
    pixdim,
    datatype: dv.getInt16(70, le),
    voxOffset: dv.getFloat32(108, le),
    slope: dv.getFloat32(112, le),
    inter: dv.getFloat32(116, le),
    qformCode: dv.getInt16(252, le),
    sformCode: dv.getInt16(254, le),
    quatern: [dv.getFloat32(256, le), dv.getFloat32(260, le), dv.getFloat32(264, le)],
    qoffset: [dv.getFloat32(268, le), dv.getFloat32(272, le), dv.getFloat32(276, le)],
    srow: [0, 1, 2].map((r) => [0, 1, 2, 3].map((c) => dv.getFloat32(280 + 16 * r + 4 * c, le))),
  };
  return finish(dv, le, h);
}

function parse2(dv: DataView, le: boolean): NiftiImage {
  const magic = String.fromCharCode(dv.getUint8(4), dv.getUint8(5), dv.getUint8(6));
  if (magic !== 'n+2') throw new NiftiError('Separate-file NIfTI-2 is not supported; save as a single .nii or .nii.gz.');
  const i64 = (o: number) => Number(dv.getBigInt64(o, le));
  const dim = Array.from({ length: 8 }, (_, i) => i64(16 + 8 * i));
  const pixdim = Array.from({ length: 8 }, (_, i) => dv.getFloat64(104 + 8 * i, le));
  const h: Header = {
    dim,
    pixdim,
    datatype: dv.getInt16(12, le),
    voxOffset: i64(168),
    slope: dv.getFloat64(176, le),
    inter: dv.getFloat64(184, le),
    qformCode: dv.getInt32(344, le),
    sformCode: dv.getInt32(348, le),
    quatern: [dv.getFloat64(352, le), dv.getFloat64(360, le), dv.getFloat64(368, le)],
    qoffset: [dv.getFloat64(376, le), dv.getFloat64(384, le), dv.getFloat64(392, le)],
    srow: [0, 1, 2].map((r) => [0, 1, 2, 3].map((c) => dv.getFloat64(400 + 32 * r + 8 * c, le))),
  };
  return finish(dv, le, h);
}

interface Header {
  dim: number[];
  pixdim: number[];
  datatype: number;
  voxOffset: number;
  slope: number;
  inter: number;
  qformCode: number;
  sformCode: number;
  quatern: number[];
  qoffset: number[];
  srow: number[][];
}

function finish(dv: DataView, le: boolean, h: Header): NiftiImage {
  if (h.dim[0] < 3) throw new NiftiError('Expected a 3D volume.');
  if (h.dim[0] > 3 && h.dim.slice(4, h.dim[0] + 1).some((d) => d > 1)) {
    throw new NiftiError('4D volumes are not supported; upload a single 3D CT.');
  }
  const dims: [number, number, number] = [h.dim[1], h.dim[2], h.dim[3]];
  const n = dims[0] * dims[1] * dims[2];
  const slope = h.slope === 0 || !Number.isFinite(h.slope) ? 1 : h.slope;
  const inter = Number.isFinite(h.inter) ? h.inter : 0;
  const off = Math.round(h.voxOffset);
  const read = reader(dv, le, h.datatype);
  if (off + n * read.bytes > dv.byteLength) throw new NiftiError('File ends before the voxel data does.');
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = read.at(off + i * read.bytes) * slope + inter;
  return { dims, data, affine: affineOf(h) };
}

function reader(dv: DataView, le: boolean, type: number): { bytes: number; at: (o: number) => number } {
  switch (type) {
    case 2: return { bytes: 1, at: (o) => dv.getUint8(o) };
    case 256: return { bytes: 1, at: (o) => dv.getInt8(o) };
    case 4: return { bytes: 2, at: (o) => dv.getInt16(o, le) };
    case 512: return { bytes: 2, at: (o) => dv.getUint16(o, le) };
    case 8: return { bytes: 4, at: (o) => dv.getInt32(o, le) };
    case 768: return { bytes: 4, at: (o) => dv.getUint32(o, le) };
    case 16: return { bytes: 4, at: (o) => dv.getFloat32(o, le) };
    case 64: return { bytes: 8, at: (o) => dv.getFloat64(o, le) };
    default: throw new NiftiError(`Unsupported NIfTI voxel type ${type}.`);
  }
}

/** sform if set, else qform (quaternion), else plain pixdim scaling. */
function affineOf(h: Header): number[][] {
  if (h.sformCode > 0) return h.srow.map((r) => [...r]);
  const [px, py, pz] = [h.pixdim[1] || 1, h.pixdim[2] || 1, h.pixdim[3] || 1];
  if (h.qformCode > 0) {
    const [b, c, d] = h.quatern;
    const a = Math.sqrt(Math.max(0, 1 - b * b - c * c - d * d));
    const R = [
      [a * a + b * b - c * c - d * d, 2 * (b * c - a * d), 2 * (b * d + a * c)],
      [2 * (b * c + a * d), a * a + c * c - b * b - d * d, 2 * (c * d - a * b)],
      [2 * (b * d - a * c), 2 * (c * d + a * b), a * a + d * d - c * c - b * b],
    ];
    const qfac = h.pixdim[0] < 0 ? -1 : 1;
    const s = [px, py, pz * qfac];
    return R.map((row, i) => [row[0] * s[0], row[1] * s[1], row[2] * s[2], h.qoffset[i]]);
  }
  return [
    [px, 0, 0, 0],
    [0, py, 0, 0],
    [0, 0, pz, 0],
  ];
}

/* ------------------------------------------------------------ orientation */

/**
 * For each RAS+ output axis: which file axis feeds it, whether it runs
 * backwards, and its spacing (the affine column norm), like
 * nibabel's io_orientation / as_closest_canonical.
 */
export interface Orientation {
  srcAxis: [number, number, number];
  flip: [boolean, boolean, boolean];
  spacing: Vec3;
}

export function orientation(affine: number[][]): Orientation {
  const cols = [0, 1, 2].map((j) => [affine[0][j], affine[1][j], affine[2][j]]);
  const srcAxis: [number, number, number] = [-1, -1, -1];
  const flip: [boolean, boolean, boolean] = [false, false, false];
  const spacing: Vec3 = [1, 1, 1];
  // Assign the strongest axis first so an oblique scan still gets a permutation.
  const order = [0, 1, 2].sort((a, b) => Math.max(...cols[b].map(Math.abs)) - Math.max(...cols[a].map(Math.abs)));
  for (const j of order) {
    const c = cols[j];
    let w = -1;
    for (let k = 0; k < 3; k++) if (srcAxis[k] === -1 && (w === -1 || Math.abs(c[k]) > Math.abs(c[w]))) w = k;
    srcAxis[w] = j;
    flip[w] = c[w] < 0;
    spacing[w] = Math.hypot(c[0], c[1], c[2]) || 1;
  }
  return { srcAxis, flip, spacing };
}
