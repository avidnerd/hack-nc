/**
 * Writes tests/fixtures/parity.json: what the TS planning engine computes for a
 * fixed set of inputs, so backend/tests/test_engine_parity.py can hold the
 * Python port (backend/app/engine) to the same numbers.
 *
 *   node --experimental-transform-types scripts/parity_dump.ts    (make parity)
 *
 * Per case: grid stats, metrics for seeded planes around the organ and the
 * tumour, the optimizer (local and wide) from fixed starts, and on the aorta
 * case the stent at several seats, the default placement and optimizeStent.
 * Inputs are recorded alongside outputs; Python never regenerates them.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { normalize } from '../src/coords.ts';
import { Centerline } from '../src/devices/centerline.ts';
import { evaluateStent, optimizeStent, ostiaOnCenterline, placeStent, preferredStart, sizeAt } from '../src/devices/stent.ts';
import { contextFrom, evaluatePlane, type EngineContext } from '../src/planning/engine.ts';
import { coarseContext, optimizeAround, optimizePlane, score, type OptimizeResult } from '../src/planning/optimize.ts';
import { planeThrough } from '../src/planning/plane.ts';
import { PlanningGrid } from '../src/planning/volume.ts';
import { DEFAULT_THRESHOLDS } from '../src/state.ts';
import type { CaseData, CaseMeta, CenterlineData, PlanMetrics, Plane, Thresholds } from '../src/types.ts';

const ROOT = resolve(import.meta.dirname, '..');

function load(id: string): CaseData {
  const dir = resolve(ROOT, 'public/data', id);
  return {
    meta: JSON.parse(readFileSync(resolve(dir, 'meta.json'), 'utf8')) as CaseMeta,
    volume: new Uint8Array(0),
    labels: new Uint8Array(readFileSync(resolve(dir, 'labels.u8'))),
    centerlines: JSON.parse(readFileSync(resolve(dir, 'centerlines.json'), 'utf8')) as CenterlineData,
    meshes: null,
  };
}

// Seeded so the fixture is reproducible.
let seed = 20261020;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

const metricsOut = (m: PlanMetrics) => ({
  remnantPct: m.remnantPct,
  resectedMl: m.resectedMl,
  healthyRemnantMl: m.healthyRemnantMl,
  marginMm: m.marginMm,
  tumorIncomplete: m.tumorIncomplete,
  vesselsCrossed: m.vesselsCrossed,
  vesselId: m.vesselId,
  nearestVesselMm: Number.isFinite(m.nearestVesselMm) ? m.nearestVesselMm : null,
  nearestVesselId: m.nearestVesselId,
});

const optOut = (r: OptimizeResult, th: Thresholds, start: Plane | null) => ({
  plane: r.plane,
  after: metricsOut(r.after),
  before: metricsOut(r.before),
  angleDeg: r.angleDeg,
  offsetMm: r.offsetMm,
  feasible: r.feasible,
  violated: r.violated,
  candidates: r.candidates,
  ms: r.ms,
  // Score as the finalist round judged it (local: relative to the start; wide: quality).
  quality: score(r.after, r.plane.n, r.plane.d, r.plane.n, r.plane.d, th),
  start,
});

function planesFor(grid: PlanningGrid, count: number): Plane[] {
  const oc = grid.organCentroid()!;
  const tc = grid.tumorCentroid() ?? oc;
  const out: Plane[] = [planeThrough([1, 0, 0], oc), planeThrough([0, 0, 1], oc), planeThrough([0, 1, 0], tc)];
  while (out.length < count) {
    const n = normalize([rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1]);
    // Through the tumour, near it, or across the organ.
    const t = rnd();
    const at = t < 0.4 ? tc : oc;
    const off = (rnd() * 2 - 1) * (t < 0.4 ? 40 : 60);
    const p = planeThrough(n, at);
    out.push({ n: p.n, d: p.d + off });
  }
  return out;
}

const cases: Record<string, unknown> = {};
for (const id of ['liver', 'aorta']) {
  const data = load(id);
  const grid = new PlanningGrid(data);
  const fine: EngineContext = contextFrom(grid);
  const coarseGrid = grid.coarsen();
  const coarse = coarseContext(coarseGrid, fine.names);
  const th = { ...DEFAULT_THRESHOLDS };

  const planes = planesFor(grid, id === 'liver' ? 24 : 10).map((plane) => ({ plane, metrics: metricsOut(evaluatePlane(fine, plane)) }));

  const optimizer: unknown[] = [];
  if (grid.tumorIdx.length > 0) {
    const tc = grid.tumorCentroid()!;
    const oc = grid.organCentroid()!;
    const out = normalize([tc[0] - oc[0], tc[1] - oc[1], tc[2] - oc[2]]);
    const starts: Plane[] = [
      // Through the tumour along "out of the organ": incomplete, must move.
      planeThrough(out, tc),
      // 25 mm past the tumour centre, tilted: a margin-and-vessels problem.
      (() => { const p = planeThrough(normalize([out[0] + 0.3, out[1] - 0.2, out[2]]), tc); return { n: p.n, d: p.d - 25 }; })(),
      // The app's default cut through the organ centre.
      planeThrough([1, 0, 0], oc),
    ];
    for (const start of starts) {
      // Warm once (JIT), then time the second run.
      optimizePlane(coarse, start, th, undefined, fine);
      const local = optimizePlane(coarse, start, th, undefined, fine);
      optimizer.push({ mode: 'local', th, ...optOut(local, th, start) });
    }
    const wide = optimizeAround(coarse, starts[0], th, fine)!;
    optimizer.push({ mode: 'wide', th, ...optOut(wide, th, starts[0]) });
    const wideNone = optimizeAround(coarse, null, th, fine)!;
    optimizer.push({ mode: 'wide', th, ...optOut(wideNone, th, null) });
    const thV: Thresholds = { ...th, marginMin: 12, priority: 'vessels' };
    const vessels = optimizePlane(coarse, starts[1], thV, undefined, fine);
    optimizer.push({ mode: 'local', th: thV, ...optOut(vessels, thV, starts[1]) });
  }

  let stent: unknown = null;
  if (data.meta.kind === 'aorta') {
    const cl = new Centerline(data.centerlines!.vessels.aorta);
    const ostia = ostiaOnCenterline(cl, data.centerlines!.renalOstia);
    const seats = [0, 20, 50, preferredStart(ostia, 30), 90, 110, 140];
    const pick = (s: ReturnType<typeof evaluateStent>) => ({ ...s });
    stent = {
      length: cl.length,
      ostia,
      seats: seats.map((s0) => pick(evaluateStent(cl, ostia, s0, sizeAt(cl, s0)))),
      // A fixed diameter far from the native neck: the oversize rule must fail.
      fixedDiameter: [60, 100].map((s0) => pick(evaluateStent(cl, ostia, s0, 30))),
      placed: pick(placeStent(cl, ostia, preferredStart(ostia, 30))),
      optimized: [10, 60, 100, 115].map((s0) => {
        const cur = evaluateStent(cl, ostia, s0, sizeAt(cl, s0));
        const r = optimizeStent(cl, ostia, cur);
        return { from: s0, diameterMm: cur.diameterMm, stent: r.stent ? pick(r.stent) : null, movedMm: r.movedMm, blocker: r.blocker };
      }),
    };
  }

  cases[id] = {
    grid: {
      shape: [grid.nx, grid.ny, grid.nz],
      factor: grid.factor,
      organ: grid.organIdx.length,
      tumor: grid.tumorIdx.length,
      vessel: grid.vesselIdx.length,
      organBox: grid.organBox,
      coarseShape: [coarseGrid.nx, coarseGrid.ny, coarseGrid.nz],
      coarseOrgan: coarseGrid.organIdx.length,
      organCentroid: grid.organCentroid(),
      tumorCentroid: grid.tumorCentroid(),
    },
    planes,
    optimizer,
    stent,
  };
}

const out = resolve(ROOT, 'tests/fixtures/parity.json');
writeFileSync(out, JSON.stringify({ generatedBy: 'scripts/parity_dump.ts', cases }, null, 1) + '\n');
console.log(`wrote ${out}`);
