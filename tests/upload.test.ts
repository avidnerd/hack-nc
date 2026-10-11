/**
 * Uploaded scans and the practice object: the NIfTI reader, reorientation,
 * HU encoding, label handling, and that the result runs through the same
 * planning engine as the shipped cases.
 */

import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { orientation, readNifti, NiftiError } from '../src/io/nifti.ts';
import { looksLikeLabels } from '../src/io/upload.ts';
import { HU_CURVE, MAX_DIM, caseFromNifti, huToU8, labelTable, outputGrid } from '../src/io/volumeCase.ts';
import { measureStructure } from '../src/planning/anatomyMeasure.ts';
import { contextFrom, evaluatePlane } from '../src/planning/engine.ts';
import { PlanningGrid } from '../src/planning/volume.ts';
import { makePhantom } from '../src/tutorial/phantom.ts';
import { makeNifti } from './niftiFixture.ts';

const buf = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

describe('NIfTI reader', () => {
  it('reads int16 voxels with slope and intercept, plain or gzipped', async () => {
    const file = makeNifti({ dims: [4, 3, 2], spacing: [0.8, 0.8, 2.5], value: (i, j, k) => i + 10 * j + 100 * k, slope: 2, inter: -1024 });
    for (const bytes of [file, new Uint8Array(gzipSync(file))]) {
      const img = await readNifti(buf(bytes));
      expect(img.dims).toEqual([4, 3, 2]);
      expect(img.data[0]).toBe(-1024);
      expect(img.data[1 + 4 * 2 + 12 * 1]).toBe((1 + 20 + 100) * 2 - 1024);
      expect(img.affine[2][2]).toBeCloseTo(2.5, 6);
    }
  });

  it('rejects what it cannot read, with a reason', async () => {
    await expect(readNifti(new ArrayBuffer(400))).rejects.toBeInstanceOf(NiftiError);
  });

  it('reorients like nibabel as_closest_canonical (LPS data -> RAS)', () => {
    const o = orientation([
      [-0.7, 0, 0, 0],
      [0, -0.7, 0, 0],
      [0, 0, 3, 0],
    ]);
    expect(o.srcAxis).toEqual([0, 1, 2]);
    expect(o.flip).toEqual([true, true, false]);
    expect(o.spacing[2]).toBeCloseTo(3, 9);
    // Axes swapped in the file: still a permutation.
    expect(orientation([[0, 1, 0, 0], [1, 0, 0, 0], [0, 0, 1, 0]]).srcAxis).toEqual([1, 0, 2]);
  });
});

describe('scan to case', () => {
  it('encodes HU with the pipeline curve exactly', () => {
    for (const [u, hu] of HU_CURVE) expect(huToU8(hu)).toBe(u);
    expect(huToU8(50)).toBe(Math.round(40 + ((50 + 200) / 500) * 175));
    expect(huToU8(-5000)).toBe(0);
    expect(huToU8(9000)).toBe(255);
  });

  it('fits the GPU budget on large scans and keeps fine native spacing on small ones', () => {
    const big = outputGrid([358, 358, 600], 0.7);
    expect(Math.max(...big.shape)).toBeLessThanOrEqual(MAX_DIM);
    expect(outputGrid([100, 100, 100], 1).spacing).toBe(1);
  });

  it('names only the MSD liver convention; anything else stays generic', () => {
    expect(labelTable([0, 1, 2]).kind).toBe('liver');
    expect(labelTable([0, 1, 2]).labels.map((l) => l.key)).toEqual(['liver', 'tumor']);
    const g = labelTable([0, 3, 7]);
    expect(g.kind).toBe('scan');
    expect(g.labels.map((l) => l.name)).toEqual(['Structure 3', 'Structure 7']);
  });

  it('tells a label map from a CT by its voxels', async () => {
    const ct = await readNifti(buf(makeNifti({ dims: [8, 8, 8], spacing: [1, 1, 1], value: (i) => -1000 + 37 * i })));
    const lab = await readNifti(buf(makeNifti({ dims: [8, 8, 8], spacing: [1, 1, 1], datatype: 2, value: (i) => (i > 4 ? 1 : 0) })));
    expect(looksLikeLabels(ct)).toBe(false);
    expect(looksLikeLabels(lab)).toBe(true);
  });

  it('puts a flipped (LPS) scan the right way round', async () => {
    // A bright slab at file x = 0..2. With a negative x axis, file x = 0 is
    // the most positive (right-most) world x, so it lands at the high end.
    const img = await readNifti(buf(makeNifti({ dims: [10, 6, 6], spacing: [2, 2, 2], signs: [-1, 1, 1], value: (i) => (i < 3 ? 300 : -1000) })));
    const c = await caseFromNifti('t', img, null);
    const [nx, ny] = c.meta.shape;
    const at = (x: number) => c.volume[x + nx * (Math.floor(ny / 2) + ny * 2)];
    expect(at(nx - 1)).toBeGreaterThan(200);
    expect(at(0)).toBe(0);
    expect(c.meta.kind).toBe('scan');
    expect(c.meta.labels).toEqual([]);
  });

  it('a CT with a liver label map runs through the planning engine', async () => {
    const dims: [number, number, number] = [40, 40, 30];
    const inLiver = (i: number, j: number, k: number) => (i - 20) ** 2 + (j - 20) ** 2 + ((k - 15) * 1.3) ** 2 < 15 ** 2;
    const inTumor = (i: number, j: number, k: number) => (i - 26) ** 2 + (j - 20) ** 2 + (k - 15) ** 2 < 4 ** 2;
    const ct = await readNifti(buf(makeNifti({ dims, spacing: [1.5, 1.5, 1.5], value: (i, j, k) => (inLiver(i, j, k) ? 60 : -1000) })));
    const lab = await readNifti(buf(makeNifti({ dims, spacing: [1.5, 1.5, 1.5], datatype: 2, value: (i, j, k) => (inTumor(i, j, k) ? 2 : inLiver(i, j, k) ? 1 : 0) })));
    const c = await caseFromNifti('liver test', ct, lab);
    expect(c.meta.kind).toBe('liver');
    const g = new PlanningGrid(c);
    expect(g.organIdx.length).toBeGreaterThan(0);
    const m = evaluatePlane(contextFrom(g), { n: [1, 0, 0], d: 28 * 1.5 });
    expect(m.remnantPct).toBeGreaterThan(0);
    expect(m.remnantPct).toBeLessThan(100);
  });
});

describe('practice object', () => {
  const p = makePhantom();

  it('is labelled as practice and carries organ, tumour, vessel and meshes', () => {
    expect(p.meta.name).toMatch(/practice/i);
    expect(p.meshes!.entries.map((e) => e.key)).toEqual(['liver', 'tumor', 'portal_vein']);
    for (const id of [1, 2, 4]) expect(p.labels.includes(id)).toBe(true);
  });

  it('works with the real engine and measurements (tumour 26 mm across)', () => {
    const g = new PlanningGrid(p);
    // Tumour centre x = 83.25 + 24 mm, radius 13: a cut through the centre
    // leaves tumour behind; one 4 mm short of its near edge clears it.
    const ctx = contextFrom(g);
    expect(evaluatePlane(ctx, { n: [1, 0, 0], d: 107.25 }).tumorIncomplete).toBe(true);
    const clear = evaluatePlane(ctx, { n: [1, 0, 0], d: 107.25 - 13 - 4 });
    expect(clear.tumorIncomplete).toBe(false);
    expect(clear.marginMm).toBeGreaterThan(2);
    const t = measureStructure(p, 'tumor')!;
    expect(Math.abs(parseFloat(t.rows[0].value) - 26)).toBeLessThan(2);
  });
});
