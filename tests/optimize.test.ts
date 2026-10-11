/**
 * The optimizer on the real liver case, from three starting planes (the M5
 * acceptance check): it must never make a plan worse, must stay inside its
 * search cone, and must be fast enough to feel instant.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { angleDeg, dot, normalize, sub, type Vec3 } from '../src/coords.ts';
import { contextFrom, evaluatePlane } from '../src/planning/engine.ts';
import {
  coarseContext,
  CONE_DEG,
  DIRECTIONS,
  fibonacciCap,
  OFFSET_MM,
  optimizePlane,
  score,
} from '../src/planning/optimize.ts';
import { computeVessels, vesselCrossingsAlong } from '../src/planning/vessels.ts';
import { PlanningGrid } from '../src/planning/volume.ts';
import { DEFAULT_THRESHOLDS } from '../src/state.ts';
import type { CaseData, CaseMeta } from '../src/types.ts';

const ROOT = resolve(__dirname, '..');
const dir = resolve(ROOT, 'public/data/liver');
const truthPath = resolve(ROOT, 'tests/fixtures/liver.truth.json');
const present = existsSync(resolve(dir, 'meta.json')) && existsSync(truthPath);

describe('fibonacci cap', () => {
  it('includes the axis and stays inside the cone', () => {
    const axis = normalize([0.3, -0.2, 0.9]);
    const dirs = fibonacciCap(axis, CONE_DEG, DIRECTIONS);
    expect(dirs).toHaveLength(DIRECTIONS);
    expect(angleDeg(dirs[0], axis)).toBeLessThan(1e-6);
    for (const d of dirs) expect(angleDeg(d, axis)).toBeLessThanOrEqual(CONE_DEG + 1e-6);
  });
});

describe.skipIf(!present)('plane optimizer on the liver case', () => {
  const meta = JSON.parse(readFileSync(resolve(dir, 'meta.json'), 'utf8')) as CaseMeta;
  const data: CaseData = {
    meta,
    volume: new Uint8Array(readFileSync(resolve(dir, 'volume.u8'))),
    labels: new Uint8Array(readFileSync(resolve(dir, 'labels.u8'))),
    centerlines: null,
    meshes: null,
  };
  const truth = JSON.parse(readFileSync(truthPath, 'utf8')) as { tumorCentroidMm: Vec3; testPlane: { d: number } };
  const grid = new PlanningGrid(data);
  const fine = contextFrom(grid);
  const coarse = coarseContext(grid.coarsen(), fine.names);
  const th = DEFAULT_THRESHOLDS;
  // The worker builds the fine-grid vessel tables when a case loads (see
  // optimize.worker.ts); do the same so the timings are what a user sees.
  vesselCrossingsAlong(fine.grid, [1, 0, 0], [0], { box: fine.box });

  // Three starts around the lesion: just too tight, tilted, and from above.
  const c = truth.tumorCentroidMm;
  const starts: { name: string; n: Vec3; through: Vec3 }[] = [
    { name: 'tight sagittal', n: [1, 0, 0], through: [truth.testPlane.d + 8, c[1], c[2]] },
    { name: 'tilted', n: normalize([0.9, 0.3, 0.2]), through: [c[0] - 18, c[1], c[2]] },
    { name: 'oblique', n: normalize([0.8, -0.2, 0.55]), through: [c[0] - 16, c[1], c[2]] },
  ];

  for (const s of starts) {
    it(`improves the "${s.name}" start in under 500 ms`, () => {
      const start = { n: s.n, d: s.n[0] * s.through[0] + s.n[1] * s.through[1] + s.n[2] * s.through[2] };
      const res = optimizePlane(coarse, start, th, undefined, fine);

      const beforeFine = evaluatePlane(fine, start);
      const afterFine = evaluatePlane(fine, res.plane);
      console.log(
        `${s.name.padEnd(15)} ${res.ms.toFixed(0).padStart(4)} ms  ` +
          `remnant ${beforeFine.remnantPct.toFixed(1)} -> ${afterFine.remnantPct.toFixed(1)} %  ` +
          `margin ${beforeFine.marginMm.toFixed(1)} -> ${afterFine.marginMm.toFixed(1)} mm  ` +
          `vessels ${beforeFine.vesselsCrossed} -> ${afterFine.vesselsCrossed}  ` +
          `moved ${res.angleDeg.toFixed(1)} deg / ${res.offsetMm.toFixed(0)} mm  feasible=${res.feasible}`,
      );

      expect(res.candidates).toBe(DIRECTIONS * 31);
      // Chosen on the fine grid, so the reported numbers are the fine numbers.
      expect(res.after).toEqual(afterFine);
      expect(res.angleDeg).toBeLessThanOrEqual(CONE_DEG + 1e-6);
      expect(score(res.after, res.plane.n, res.plane.d, start.n, start.d, th)).toBeGreaterThanOrEqual(
        score(res.before, start.n, start.d, start.n, start.d, th) - 1e-9,
      );
      expect(res.ms).toBeLessThan(500);
    });
  }

  // Moment 3: a wedge cut aimed from the liver centre at the tumour, placed
  // 6 mm from it and tilted onto a hepatic vessel. The optimizer must clear
  // the vessel and restore the 10 mm margin.
  it('fixes the Moment 3 wedge cut: margin restored, vessel cleared', () => {
    const toward = normalize(sub(grid.tumorCentroid()!, grid.organCentroid()!));
    const n = normalize([toward[0] - 0.25, toward[1], toward[2]]);
    let tmin = Infinity;
    for (const i of grid.tumorIdx) tmin = Math.min(tmin, dot(n, grid.worldAt(i)));
    const start = { n, d: tmin - 6 };

    const res = optimizePlane(coarse, start, th, undefined, fine);
    console.log(
      `moment 3        ${res.ms.toFixed(0).padStart(4)} ms  margin ${res.before.marginMm.toFixed(1)} -> ${res.after.marginMm.toFixed(1)} mm  ` +
        `vessels ${res.before.vesselsCrossed} -> ${res.after.vesselsCrossed}  ` +
        `remnant ${res.before.remnantPct.toFixed(1)} -> ${res.after.remnantPct.toFixed(1)} %  moved ${res.angleDeg.toFixed(1)} deg`,
    );
    expect(res.before.vesselsCrossed).toBeGreaterThan(0);
    expect(res.before.marginMm).toBeLessThan(th.marginMin);
    expect(res.feasible).toBe(true);
    expect(res.after.vesselsCrossed).toBe(0);
    expect(res.after.marginMm).toBeGreaterThanOrEqual(th.marginMin);
    expect(res.after.remnantPct).toBeGreaterThanOrEqual(th.remnantMin);
  });

  // The ranking counts vessels on the fine grid with a batched counter; it
  // must give exactly the same answer as the HUD's own vessel metric.
  it('counts vessel crossings exactly like the vessel metric', () => {
    const c = grid.organCentroid()!;
    let seed = 3;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let s = 0; s < 6; s++) {
      const n = normalize([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]);
      const base = dot(n, c) + (rnd() - 0.5) * 60;
      const ds = Array.from({ length: 31 }, (_, k) => base - 15 + k);
      const batch = vesselCrossingsAlong(fine.grid, n, ds, { box: fine.box });
      expect(batch).toEqual(ds.map((d) => computeVessels(fine.grid, { n, d }, { box: fine.box }).crossed));
    }
  });

  // Regression: ranking on the coarse grid once missed a vessel-free plane
  // (thin vessels vanish there) and returned one crossing a vessel. Against
  // an exhaustive search of the same candidates on the fine grid, the
  // optimizer must reach the fewest vessels any acceptable plane allows.
  it('crosses no more vessels than the best acceptable plane in its search space', () => {
    const toward = normalize(sub(grid.tumorCentroid()!, grid.organCentroid()!));
    const organC = grid.organCentroid()!;
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const tumorPts = Array.from(grid.tumorIdx, (i) => grid.worldAt(i));
    const acceptable = (m: { tumorIncomplete: boolean; marginMm: number; remnantPct: number }) =>
      !m.tumorIncomplete && m.marginMm >= th.marginMin && m.remnantPct >= th.remnantMin;
    const checked: number[] = [];
    for (let s = 0; s < 20; s++) {
      const j = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
      const n0 = normalize([toward[0] + j[0] * 1.3, toward[1] + j[1] * 1.3, toward[2] + j[2] * 1.3]);
      const gap = [-4, 3, 6, 9, 13][s % 5];
      if (s !== 3 && s !== 17 && s !== 19) continue; // 19 is the start that used to fail
      let tmin = Infinity;
      for (const p of tumorPts) tmin = Math.min(tmin, dot(n0, p));
      const start = { n: n0, d: tmin - gap };
      const res = optimizePlane(coarse, start, th, undefined, fine);

      const k0 = dot(n0, organC) - start.d;
      const anchor: Vec3 = [organC[0] - n0[0] * k0, organC[1] - n0[1] * k0, organC[2] - n0[2] * k0];
      let fewest = Infinity;
      for (const n of fibonacciCap(n0, CONE_DEG, DIRECTIONS)) {
        const base = dot(n, anchor);
        for (let k = -OFFSET_MM; k <= OFFSET_MM; k++) {
          const m = evaluatePlane(fine, { n, d: base + k }, { locate: false });
          if (acceptable(m)) fewest = Math.min(fewest, m.vesselsCrossed);
        }
      }
      expect(acceptable(res.after)).toBe(true);
      expect(res.after.vesselsCrossed).toBe(fewest);
      checked.push(fewest);
    }
    // Start 19 has a vessel-free acceptable plane, and the optimizer finds it.
    expect(checked).toEqual([0, 1, 0]);

    // The oblique start: its one-vessel acceptable plane has a true margin of
    // 10.2 mm but a plane-to-tumour proxy of 7.4 mm, so it is only reachable
    // through the near-miss re-score.
    const ob = starts.find((x) => x.name === 'oblique')!;
    const start = { n: ob.n, d: dot(ob.n, ob.through) };
    const res = optimizePlane(coarse, start, th, undefined, fine);
    const k0 = dot(start.n, organC) - start.d;
    const anchor: Vec3 = [organC[0] - start.n[0] * k0, organC[1] - start.n[1] * k0, organC[2] - start.n[2] * k0];
    let fewest = Infinity;
    for (const n of fibonacciCap(start.n, CONE_DEG, DIRECTIONS)) {
      for (let k = -OFFSET_MM; k <= OFFSET_MM; k++) {
        const m = evaluatePlane(fine, { n, d: dot(n, anchor) + k }, { locate: false });
        if (acceptable(m)) fewest = Math.min(fewest, m.vesselsCrossed);
      }
    }
    expect(acceptable(res.after)).toBe(true);
    expect(res.after.vesselsCrossed).toBe(fewest);
  }, 180_000);
});
