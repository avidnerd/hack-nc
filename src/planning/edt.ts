/**
 * Exact 3D Euclidean distance transform with anisotropic voxel spacing.
 *
 * Felzenszwalb & Huttenlocher's separable algorithm: the squared distance
 * transform of a 3D field is three passes of a 1D transform, one per axis, and
 * each 1D pass is the lower envelope of a set of parabolas, computed in linear
 * time. Exact, not an approximation like a chamfer mask, which matters because
 * the margin number is a clinical quantity we print to a tenth of a
 * millimetre.
 *
 * Written here rather than pulled from a library because it is 60 lines and the
 * anisotropic-spacing variant is not what most implementations give you.
 */

const INF = 1e20;

/**
 * In-place 1D squared-distance transform along a strided line.
 *
 * Solves  d[q] = min_p ( (q - p)^2 * spacing^2 + f[p] )  for every q.
 *
 * Scratch arrays are passed in so the 3D driver can allocate once per axis
 * instead of once per line.
 */
function dt1d(
  f: Float64Array,
  n: number,
  spacing: number,
  v: Int32Array,
  z: Float64Array,
  out: Float64Array,
): void {
  const s2 = spacing * spacing;
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;

  // Build the lower envelope: v holds the parabola vertices still visible,
  // z the boundaries between them.
  for (let q = 1; q < n; q++) {
    // Intersection of the parabolas rooted at q and at v[k].
    let s = (f[q] + s2 * q * q - (f[v[k]] + s2 * v[k] * v[k])) / (2 * s2 * (q - v[k]));
    while (s <= z[k]) {
      // The parabola at v[k] is entirely hidden; drop it and retry.
      k--;
      s = (f[q] + s2 * q * q - (f[v[k]] + s2 * v[k] * v[k])) / (2 * s2 * (q - v[k]));
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }

  // Walk the envelope once, reading off the minimum at each sample.
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    out[q] = s2 * dq * dq + f[v[k]];
  }
}

export interface Grid3 {
  nx: number;
  ny: number;
  nz: number;
  /** Millimetres per voxel along each axis. */
  spacing: [number, number, number];
}

/**
 * Distance in millimetres from every voxel to the nearest voxel where
 * `seed` is true.
 *
 * Index order is x-fastest: `i + nx * (j + ny * k)`, matching the layout of
 * `volume.u8` and `labels.u8`.
 */
export function edt3d(seed: Uint8Array, grid: Grid3): Float32Array {
  const { nx, ny, nz, spacing } = grid;
  const n = nx * ny * nz;
  if (seed.length !== n) {
    throw new Error(`edt3d: seed has ${seed.length} voxels, grid implies ${n}`);
  }

  // Squared distances live in a Float64Array during the passes: the
  // intermediate values reach (extent in mm)^2, which overflows the precision
  // of Float32 for a 400 mm torso well before the final sqrt.
  const d = new Float64Array(n);
  let anySeed = false;
  for (let i = 0; i < n; i++) {
    if (seed[i]) {
      d[i] = 0;
      anySeed = true;
    } else {
      d[i] = INF;
    }
  }

  // With nothing to measure from, every distance is infinite. Returning a
  // large finite value keeps callers from having to special-case NaN.
  if (!anySeed) {
    const out = new Float32Array(n);
    out.fill(Number.POSITIVE_INFINITY);
    return out;
  }

  const maxDim = Math.max(nx, ny, nz);
  const f = new Float64Array(maxDim);
  const line = new Float64Array(maxDim);
  const v = new Int32Array(maxDim);
  const z = new Float64Array(maxDim + 1);

  // --- pass along x (contiguous) ------------------------------------------
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      const base = nx * (j + ny * k);
      for (let i = 0; i < nx; i++) f[i] = d[base + i];
      dt1d(f, nx, spacing[0], v, z, line);
      for (let i = 0; i < nx; i++) d[base + i] = line[i];
    }
  }

  // --- pass along y -------------------------------------------------------
  for (let k = 0; k < nz; k++) {
    for (let i = 0; i < nx; i++) {
      const base = i + nx * ny * k;
      for (let j = 0; j < ny; j++) f[j] = d[base + nx * j];
      dt1d(f, ny, spacing[1], v, z, line);
      for (let j = 0; j < ny; j++) d[base + nx * j] = line[j];
    }
  }

  // --- pass along z -------------------------------------------------------
  const strideZ = nx * ny;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const base = i + nx * j;
      for (let k = 0; k < nz; k++) f[k] = d[base + strideZ * k];
      dt1d(f, nz, spacing[2], v, z, line);
      for (let k = 0; k < nz; k++) d[base + strideZ * k] = line[k];
    }
  }

  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sqrt(d[i]);
  return out;
}
