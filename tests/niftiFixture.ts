/**
 * Writes small synthetic NIfTI-1 files for tests: a known shape in a known
 * orientation, so the reader's reorientation and HU handling can be checked
 * exactly. Shared by the unit tests and the upload end-to-end test.
 */

export interface FixtureOptions {
  dims: [number, number, number];
  /** pixdim / affine column lengths, mm. */
  spacing: [number, number, number];
  /** Signs of the sform diagonal (a -1 flips that axis, like LPS data). */
  signs?: [number, number, number];
  /** Value at voxel (i, j, k). */
  value: (i: number, j: number, k: number) => number;
  /** 4 = int16, 16 = float32, 2 = uint8. */
  datatype?: 2 | 4 | 16;
  slope?: number;
  inter?: number;
}

export function makeNifti(o: FixtureOptions): Uint8Array {
  const [nx, ny, nz] = o.dims;
  const dt = o.datatype ?? 4;
  const bytes = dt === 2 ? 1 : dt === 4 ? 2 : 4;
  const n = nx * ny * nz;
  const buf = new ArrayBuffer(352 + n * bytes);
  const dv = new DataView(buf);
  dv.setInt32(0, 348, true);
  [3, nx, ny, nz, 1, 1, 1, 1].forEach((v, i) => dv.setInt16(40 + 2 * i, v, true));
  dv.setInt16(70, dt, true);
  dv.setInt16(72, bytes * 8, true);
  [1, ...o.spacing, 1, 1, 1, 1].forEach((v, i) => dv.setFloat32(76 + 4 * i, v, true));
  dv.setFloat32(108, 352, true);
  dv.setFloat32(112, o.slope ?? 1, true);
  dv.setFloat32(116, o.inter ?? 0, true);
  dv.setInt16(254, 1, true); // sform_code
  const s = o.signs ?? [1, 1, 1];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) dv.setFloat32(280 + 16 * r + 4 * c, r === c ? s[r] * o.spacing[r] : 0, true);
  }
  dv.setUint8(344, 'n'.charCodeAt(0));
  dv.setUint8(345, '+'.charCodeAt(0));
  dv.setUint8(346, '1'.charCodeAt(0));
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const off = 352 + (i + nx * (j + ny * k)) * bytes;
        const v = o.value(i, j, k);
        if (dt === 2) dv.setUint8(off, v);
        else if (dt === 4) dv.setInt16(off, v, true);
        else dv.setFloat32(off, v, true);
      }
  return new Uint8Array(buf);
}
