/**
 * The EDT is the only exact-geometry primitive the margin number depends on,
 * so it is checked against brute force rather than against itself.
 */

import { describe, expect, it } from 'vitest';

import { edt3d, type Grid3 } from '../src/planning/edt.ts';

/** O(n^2) reference: for every voxel, scan every seed. */
function bruteForce(seed: Uint8Array, g: Grid3): Float32Array {
  const { nx, ny, nz, spacing } = g;
  const seeds: [number, number, number][] = [];
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (seed[i + nx * (j + ny * k)]) seeds.push([i, j, k]);
      }
    }
  }
  const out = new Float32Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        let best = Infinity;
        for (const [a, b, c] of seeds) {
          const dx = (i - a) * spacing[0];
          const dy = (j - b) * spacing[1];
          const dz = (k - c) * spacing[2];
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < best) best = d2;
        }
        out[i + nx * (j + ny * k)] = Math.sqrt(best);
      }
    }
  }
  return out;
}

/** Deterministic pseudo-random, so a failure is always reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('edt3d', () => {
  it('measures a single seed at the origin', () => {
    const g: Grid3 = { nx: 4, ny: 3, nz: 2, spacing: [1, 1, 1] };
    const seed = new Uint8Array(24);
    seed[0] = 1;
    const d = edt3d(seed, g);
    expect(d[0]).toBeCloseTo(0, 6);
    expect(d[1]).toBeCloseTo(1, 6);
    expect(d[1 + 4]).toBeCloseTo(Math.SQRT2, 6);
    // Far corner (3, 2, 1).
    expect(d[3 + 4 * (2 + 3 * 1)]).toBeCloseTo(Math.sqrt(9 + 4 + 1), 6);
  });

  it('honours anisotropic spacing', () => {
    const g: Grid3 = { nx: 5, ny: 5, nz: 5, spacing: [0.5, 2, 3] };
    const seed = new Uint8Array(125);
    seed[0] = 1;
    const d = edt3d(seed, g);
    expect(d[1]).toBeCloseTo(0.5, 6); // one step in x
    expect(d[5]).toBeCloseTo(2, 6); // one step in y
    expect(d[25]).toBeCloseTo(3, 6); // one step in z
    expect(d[1 + 5]).toBeCloseTo(Math.hypot(0.5, 2), 6);
  });

  it('returns zero inside the seed region', () => {
    const g: Grid3 = { nx: 8, ny: 8, nz: 8, spacing: [1, 1, 1] };
    const seed = new Uint8Array(512);
    for (let k = 2; k < 6; k++) {
      for (let j = 2; j < 6; j++) {
        for (let i = 2; i < 6; i++) seed[i + 8 * (j + 8 * k)] = 1;
      }
    }
    const d = edt3d(seed, g);
    expect(d[3 + 8 * (3 + 8 * 3)]).toBe(0);
    // Immediately outside the slab in x.
    expect(d[1 + 8 * (3 + 8 * 3)]).toBeCloseTo(1, 6);
  });

  it('matches brute force on random fields, isotropic and anisotropic', () => {
    const cases: Grid3[] = [
      { nx: 11, ny: 9, nz: 7, spacing: [1, 1, 1] },
      { nx: 9, ny: 11, nz: 8, spacing: [1.5, 1.5, 1.5] },
      { nx: 10, ny: 7, nz: 9, spacing: [0.7, 1.3, 2.9] },
    ];
    for (const [ci, g] of cases.entries()) {
      const rnd = mulberry32(1234 + ci);
      const n = g.nx * g.ny * g.nz;
      const seed = new Uint8Array(n);
      // Sparse seeds exercise the parabola envelope much harder than a blob.
      for (let i = 0; i < n; i++) seed[i] = rnd() < 0.04 ? 1 : 0;
      seed[Math.floor(rnd() * n)] = 1; // guarantee at least one

      const got = edt3d(seed, g);
      const want = bruteForce(seed, g);
      for (let i = 0; i < n; i++) {
        expect(got[i]).toBeCloseTo(want[i], 5);
      }
    }
  });

  it('reports infinity when there is nothing to measure from', () => {
    const g: Grid3 = { nx: 4, ny: 4, nz: 4, spacing: [1, 1, 1] };
    const d = edt3d(new Uint8Array(64), g);
    expect(d.every((v) => v === Infinity)).toBe(true);
  });

  it('rejects a seed array that does not match the grid', () => {
    const g: Grid3 = { nx: 4, ny: 4, nz: 4, spacing: [1, 1, 1] };
    expect(() => edt3d(new Uint8Array(10), g)).toThrow(/voxels/);
  });
});
