/**
 * Does "optimize" actually spare vessels?
 *
 *   npm run audit:vessels [starts]      (default 24; ~8 s per start)
 *
 * For seeded starting cuts around the tumour (through it, tight, and at a
 * comfortable distance, at varied angles), runs the optimizer and then an
 * exhaustive search of the same 3751 candidates on the full-resolution grid.
 * A start counts as a miss when some plane meeting the margin and remnant
 * thresholds crosses fewer vessels than the optimizer's answer.
 */
import { readFileSync } from 'node:fs';
import { normalize, sub, type Vec3 } from '../src/coords.ts';
import { contextFrom, evaluatePlane } from '../src/planning/engine.ts';
import { coarseContext, CONE_DEG, DIRECTIONS, fibonacciCap, OFFSET_MM, optimizePlane, score } from '../src/planning/optimize.ts';
import { PlanningGrid } from '../src/planning/volume.ts';
import { DEFAULT_THRESHOLDS } from '../src/state.ts';
import type { CaseData, CaseMeta, PlanMetrics } from '../src/types.ts';

const dir = 'public/data/liver';
const data: CaseData = {
  meta: JSON.parse(readFileSync(`${dir}/meta.json`, 'utf8')) as CaseMeta,
  volume: new Uint8Array(readFileSync(`${dir}/volume.u8`)),
  labels: new Uint8Array(readFileSync(`${dir}/labels.u8`)),
  centerlines: null,
  meshes: null,
};
const grid = new PlanningGrid(data);
const fine = contextFrom(grid);
const coarse = coarseContext(grid.coarsen(), fine.names);
const th = DEFAULT_THRESHOLDS;
const tumorC = grid.tumorCentroid()!;
const organC = grid.organCentroid()!;
const toward = normalize(sub(tumorC, organC));

// Seeded RNG so the audit is reproducible.
let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

const tumorPts: Vec3[] = Array.from(grid.tumorIdx, (i) => grid.worldAt(i));
const feasible = (m: PlanMetrics) => !m.tumorIncomplete && m.marginMm >= th.marginMin && m.remnantPct >= th.remnantMin;

const rows: string[] = [];
const times: number[] = [];
let spared = 0, optimal = 0, missed = 0, noFeasible = 0, crossedBefore = 0;
const N = Number(process.argv[2] ?? 24);
for (let s = 0; s < N; s++) {
  // A normal up to 35 degrees off the tumour direction, a plane a set distance from it.
  const jitter: Vec3 = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
  const n0 = normalize([toward[0] + jitter[0] * 1.3, toward[1] + jitter[1] * 1.3, toward[2] + jitter[2] * 1.3]);
  const gap = [-4, 3, 6, 9, 13][s % 5];
  let tmin = Infinity;
  for (const p of tumorPts) tmin = Math.min(tmin, n0[0] * p[0] + n0[1] * p[1] + n0[2] * p[2]);
  const start = { n: n0, d: tmin - gap };

  const opt = optimizePlane(coarse, start, th, DIRECTIONS, fine);
  times.push(opt.ms);

  // Exhaustive: the same candidate set, every one judged on the fine grid.
  const c = organC;
  const sAnc = n0[0] * c[0] + n0[1] * c[1] + n0[2] * c[2] - start.d;
  const anchor: Vec3 = [c[0] - n0[0] * sAnc, c[1] - n0[1] * sAnc, c[2] - n0[2] * sAnc];
  let minV = Infinity;
  let bestScore = -Infinity;
  let bestScoreV = 0;
  for (const n of fibonacciCap(n0, CONE_DEG, DIRECTIONS)) {
    const base = n[0] * anchor[0] + n[1] * anchor[1] + n[2] * anchor[2];
    for (let k = -OFFSET_MM; k <= OFFSET_MM; k++) {
      const m = evaluatePlane(fine, { n, d: base + k }, false);
      if (feasible(m)) minV = Math.min(minV, m.vesselsCrossed);
      const sc = score(m, n, base + k, n0, base, th);
      if (sc > bestScore) [bestScore, bestScoreV] = [sc, m.vesselsCrossed];
    }
  }
  const b = opt.before;
  const a = opt.after;
  if (b.vesselsCrossed > 0) crossedBefore++;
  let verdict: string;
  if (!Number.isFinite(minV)) {
    noFeasible++;
    verdict = 'no feasible plane in reach';
  } else if (!feasible(a)) {
    missed++;
    verdict = `MISSED: optimizer broke margin/remnant, exhaustive found a plane with ${minV} vessel(s)`;
  } else if (a.vesselsCrossed > minV) {
    missed++;
    verdict = `MISSED: ${a.vesselsCrossed} vessel(s), ${minV} possible`;
  } else {
    optimal++;
    if (a.vesselsCrossed === 0) spared++;
    verdict = a.vesselsCrossed === 0 ? 'spared all' : `best possible (${minV})`;
  }
  rows.push(
    `#${String(s).padStart(2)} gap ${String(gap).padStart(3)} mm | before: margin ${b.tumorIncomplete ? 'tumour' : b.marginMm.toFixed(1).padStart(4)} vessels ${b.vesselsCrossed} | after: margin ${a.marginMm.toFixed(1).padStart(4)} vessels ${a.vesselsCrossed} remnant ${a.remnantPct.toFixed(0)}% | exhaustive best-score plane crosses ${bestScoreV} | ${verdict}`,
  );
}
console.log(rows.join('\n'));
console.log(`\n${N} starts: ${crossedBefore} began crossing vessels. Optimizer matched the fewest-vessel feasible plane in ${optimal}/${N - noFeasible} (spared every vessel in ${spared}); missed a better plane in ${missed}; ${noFeasible} had no feasible plane in reach.`);
