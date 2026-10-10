/**
 * Writes docs/VALIDATION.json: the three measured numbers the website's
 * Validation section shows. Same modules, fixtures and setups as the vitest
 * suites (tests/gestures.test.ts, tests/optimize.test.ts,
 * tests/planning.test.ts); the tests assert tolerances, this records values.
 *
 *   node --experimental-transform-types scripts/validation.ts   (on an idle machine)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { dot, normalize, sub } from '../src/coords.ts';
import { OneEuro } from '../src/input/oneEuro.ts';
import { TUNING } from '../src/input/tuning.ts';
import { contextFrom, evaluatePlane } from '../src/planning/engine.ts';
import { coarseContext, optimizePlane } from '../src/planning/optimize.ts';
import { PlanningGrid } from '../src/planning/volume.ts';
import { DEFAULT_THRESHOLDS } from '../src/state.ts';
import type { CaseData, CaseMeta, Vec3 } from '../src/types.ts';

const ROOT = resolve(import.meta.dirname, '..');

/* ---------- plane jitter: +-1 deg noise on a still normal, 1€ filtered */

const f = new OneEuro(TUNING.normalFilter);
let seed = 1;
const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
const settled: number[] = [];
for (let i = 0; i < 300; i++) {
  const y = f.filter(30 + noise(), i * 33);
  if (i > 60) settled.push(y - 30);
}
const mean = settled.reduce((a, b) => a + b, 0) / settled.length;
const jitterSd = Math.sqrt(settled.reduce((a, b) => a + (b - mean) ** 2, 0) / settled.length);
const jitterMax = Math.max(...settled.map(Math.abs));

/* ---------- liver case, as the planning and optimizer suites load it */

const dir = resolve(ROOT, 'public/data/liver');
const meta = JSON.parse(readFileSync(resolve(dir, 'meta.json'), 'utf8')) as CaseMeta;
const data: CaseData = {
  meta,
  volume: new Uint8Array(readFileSync(resolve(dir, 'volume.u8'))),
  labels: new Uint8Array(readFileSync(resolve(dir, 'labels.u8'))),
  centerlines: null,
  meshes: null,
};
const truth = JSON.parse(readFileSync(resolve(ROOT, 'tests/fixtures/liver.truth.json'), 'utf8')) as {
  testPlane: { n: Vec3; d: number };
  full: { remnantPct: number; marginMm: number };
};
const grid = new PlanningGrid(data);
const fine = contextFrom(grid);
const coarse = coarseContext(grid.coarsen(), fine.names);

/* ---------- remnant error vs numpy at full resolution (the test plane) */

const got = evaluatePlane(fine, truth.testPlane);
const remnantErr = Math.abs(got.remnantPct - truth.full.remnantPct);
const marginErr = Math.abs(got.marginMm - truth.full.marginMm);

/* ---------- optimizer: the Moment 3 wedge, median of 5 runs */

const toward = normalize(sub(grid.tumorCentroid()!, grid.organCentroid()!));
const n = normalize([toward[0] - 0.25, toward[1], toward[2]]);
let tmin = Infinity;
for (const i of grid.tumorIdx) tmin = Math.min(tmin, dot(n, grid.worldAt(i)));
const start = { n, d: tmin - 6 };
optimizePlane(coarse, start, DEFAULT_THRESHOLDS, undefined, fine); // warm-up
const runs = Array.from({ length: 5 }, () => optimizePlane(coarse, start, DEFAULT_THRESHOLDS, undefined, fine).ms).sort(
  (a, b) => a - b,
);

const out = {
  measuredAt: new Date().toISOString(),
  planeJitterDeg: +jitterSd.toFixed(3),
  planeJitterMaxDeg: +jitterMax.toFixed(3),
  planeJitterMethod: 'Synthetic: +-1 deg uniform noise on a still palm normal, through the app 1-euro filter, 300 frames at 30 fps.',
  optimizerMs: Math.round(runs[2]),
  optimizerRunsMs: runs.map((r) => Math.round(r)),
  optimizerMethod: 'Moment 3 wedge on the liver case, 3,751 candidates, median of 5 runs in Node on the dev laptop.',
  remnantErrorPct: +remnantErr.toFixed(3),
  marginErrorMm: +marginErr.toFixed(3),
  remnantMethod: 'Fixture test plane: TypeScript planning grid vs numpy at full 1.0 mm resolution.',
};
writeFileSync(resolve(ROOT, 'docs/VALIDATION.json'), JSON.stringify(out, null, 2) + '\n');
console.log(out);
