/**
 * The planning engine against the numpy ground truth.
 *
 * `tests/fixtures/<case>.truth.json` is written by pipeline/run.py from the
 * same packed volumes the browser loads, using the same formulas implemented
 * independently in numpy. If these two disagree, one of them is wrong — that
 * is the whole point of keeping both.
 *
 * The fixture is only present once the pipeline has run, so the suite skips
 * itself rather than failing on a fresh clone with no data.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { contextFrom, evaluatePlane } from '../src/planning/engine.ts';
import { PlanningGrid } from '../src/planning/volume.ts';
import type { CaseData, CaseMeta, Vec3 } from '../src/types.ts';

const ROOT = resolve(__dirname, '..');

interface PlaneMetricsTruth {
  remnantPct: number;
  resectedMl: number;
  marginMm: number;
  tumorIncomplete: boolean;
  vesselsCrossed: number;
}

interface Truth {
  case: string;
  shape: Vec3;
  spacing: Vec3;
  organVolumeMl: number;
  tumorVolumeMl: number;
  tumorCentroidMm?: Vec3;
  testPlane?: { n: Vec3; d: number };
  testPlaneThroughTumor?: { n: Vec3; d: number };
  full?: PlaneMetricsTruth;
  planning?: PlaneMetricsTruth;
  planningThroughTumor?: PlaneMetricsTruth;
  planningFactor?: number;
  planningShape?: Vec3;
}

function loadCaseFromDisk(id: string): { data: CaseData; truth: Truth } | null {
  const truthPath = resolve(ROOT, 'tests/fixtures', `${id}.truth.json`);
  const dataDir = resolve(ROOT, 'public/data', id);
  if (!existsSync(truthPath) || !existsSync(resolve(dataDir, 'meta.json'))) return null;

  const truth = JSON.parse(readFileSync(truthPath, 'utf8')) as Truth;
  const meta = JSON.parse(readFileSync(resolve(dataDir, 'meta.json'), 'utf8')) as CaseMeta;
  const volume = new Uint8Array(readFileSync(resolve(dataDir, 'volume.u8')));
  const labels = new Uint8Array(readFileSync(resolve(dataDir, 'labels.u8')));
  return { data: { meta, volume, labels, centerlines: null, meshes: null }, truth };
}

const loaded = loadCaseFromDisk('liver');

describe.skipIf(!loaded)('planning engine vs numpy ground truth (liver)', () => {
  const { data, truth } = loaded!;
  const grid = new PlanningGrid(data);
  const ctx = contextFrom(grid);

  it('builds the same planning grid the pipeline did', () => {
    expect(grid.factor).toBe(truth.planningFactor);
    expect([grid.nx, grid.ny, grid.nz]).toEqual(truth.planningShape);
  });

  it('agrees on organ and tumour volume', () => {
    // Majority downsampling moves a little tissue at the boundary, so this is
    // a tolerance on the grid, not on the formula.
    expect(grid.organMl).toBeGreaterThan(truth.organVolumeMl * 0.9);
    expect(grid.organMl).toBeLessThan(truth.organVolumeMl * 1.1);
    expect(grid.tumorMl).toBeGreaterThan(0);
  });

  it('matches the tumour centroid to within a voxel', () => {
    const c = grid.tumorCentroid();
    expect(c).not.toBeNull();
    const want = truth.tumorCentroidMm!;
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(c![i] - want[i])).toBeLessThan(grid.spacing[i]);
    }
  });

  it('reproduces the clean test plane: remnant, margin, vessels', () => {
    const want = truth.planning!;
    const got = evaluatePlane(ctx, truth.testPlane!);

    // Same grid, same formula, independent implementations: these should agree
    // far more tightly than the +/-1% the brief allows.
    expect(got.remnantPct).toBeCloseTo(want.remnantPct, 1);
    expect(got.marginMm).toBeCloseTo(want.marginMm, 1);
    expect(got.tumorIncomplete).toBe(want.tumorIncomplete);
    expect(got.vesselsCrossed).toBe(want.vesselsCrossed);
    expect(got.resectedMl).toBeCloseTo(want.resectedMl, 0);
  });

  it('draws the margin it reports: the closest-approach segment is the margin', () => {
    const got = evaluatePlane(ctx, truth.testPlane!);
    const [a, b] = got.marginPath!;
    const len = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    // The EDT is exact, so the drawn segment and the number agree to float noise.
    expect(len).toBeCloseTo(got.marginMm, 3);
    // Its cut end lies on the kept side, against the plane.
    const { n, d } = truth.testPlane!;
    const sd = n[0] * a[0] + n[1] * a[1] + n[2] * a[2] - d;
    expect(sd).toBeLessThanOrEqual(0);
    expect(sd).toBeGreaterThan(-ctx.grid.voxelDiag - 1e-6);
  });

  it('marks one location per vessel crossed', () => {
    const got = evaluatePlane(ctx, truth.testPlane!);
    expect(got.vesselCuts!.length).toBe(got.vesselsCrossed);
  });

  it('reproduces a plane that cuts through the tumour', () => {
    const want = truth.planningThroughTumor!;
    const got = evaluatePlane(ctx, truth.testPlaneThroughTumor!);

    expect(got.remnantPct).toBeCloseTo(want.remnantPct, 1);
    expect(got.tumorIncomplete).toBe(true);
    expect(got.marginMm).toBe(0);
    expect(got.vesselsCrossed).toBe(want.vesselsCrossed);
  });

  it('stays within the brief tolerance against the FULL-resolution truth', () => {
    // The brief allows remnant +/-1% and margin +/-1 mm. The planning grid is
    // coarser than the grid numpy measured here, so this is the honest
    // end-to-end check of what the HUD shows against the best available truth.
    const want = truth.full!;
    const got = evaluatePlane(ctx, truth.testPlane!);
    expect(Math.abs(got.remnantPct - want.remnantPct)).toBeLessThanOrEqual(1);
    expect(Math.abs(got.marginMm - want.marginMm)).toBeLessThanOrEqual(1);
  });

  it('puts the whole organ on the kept side when the plane is clear of it', () => {
    // A plane far outside the body resects nothing.
    const far = { n: [1, 0, 0] as Vec3, d: 1e5 };
    const got = evaluatePlane(ctx, far);
    expect(got.remnantPct).toBeCloseTo(100, 5);
    expect(got.resectedMl).toBeCloseTo(0, 5);
    expect(got.vesselsCrossed).toBe(0);
  });

  it('resects everything when the plane is on the other side', () => {
    const far = { n: [1, 0, 0] as Vec3, d: -1e5 };
    const got = evaluatePlane(ctx, far);
    expect(got.remnantPct).toBeCloseTo(0, 5);
    expect(got.tumorIncomplete).toBe(false);
  });

  it('is monotonic: sliding the plane one way only keeps more', () => {
    // The resected side is dot(n, x) > d, so sweeping d upward moves the cut
    // across the organ and the remnant must never go back down.
    const n: Vec3 = [1, 0, 0];
    let prev = -1;
    let sawEmpty = false;
    let sawFull = false;
    for (let d = -200; d <= 500; d += 25) {
      const r = evaluatePlane(ctx, { n, d });
      expect(r.remnantPct).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = r.remnantPct;
      if (r.remnantPct < 1e-6) sawEmpty = true;
      if (r.remnantPct > 100 - 1e-6) sawFull = true;
    }
    // The sweep has to actually cross the organ for the check to mean anything.
    expect(sawEmpty).toBe(true);
    expect(sawFull).toBe(true);
  });

  it('evaluates a plane fast enough to run every frame', () => {
    const t0 = performance.now();
    const N = 50;
    for (let i = 0; i < N; i++) {
      evaluatePlane(ctx, { n: [1, 0, 0], d: 100 + i });
    }
    const ms = (performance.now() - t0) / N;
    console.log(`    evaluatePlane: ${ms.toFixed(2)} ms/call on ${grid.nx}x${grid.ny}x${grid.nz}`);
    // 16 ms is one frame; the metrics must not be the thing that costs it.
    expect(ms).toBeLessThan(8);
  });
});

describe.skipIf(loaded)('planning engine', () => {
  it('skipped: run `python pipeline/run.py liver ...` to generate fixtures', () => {
    expect(true).toBe(true);
  });
});
