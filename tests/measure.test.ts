/**
 * "Measure the <structure>": the geometry on shapes with known answers, then
 * the real cases against the sizes the pipeline and the literature give.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  axialDiameters,
  inscribedDiameter,
  measureStructure,
  principalLength,
  voxelsOf,
} from '../src/planning/anatomyMeasure.ts';
import type { CaseData, CaseMeta, CenterlineData, Vec3 } from '../src/types.ts';

const ROOT = resolve(__dirname, '..');

/** A 1 mm grid with label 1 wherever `inside` says so. */
function grid(n: Vec3, inside: (x: number, y: number, z: number) => boolean) {
  const labels = new Uint8Array(n[0] * n[1] * n[2]);
  for (let z = 0; z < n[2]; z++)
    for (let y = 0; y < n[1]; y++)
      for (let x = 0; x < n[0]; x++) if (inside(x, y, z)) labels[x + n[0] * (y + n[1] * z)] = 1;
  const v = { shape: n, spacing: [1, 1, 1] as Vec3, origin: [0, 0, 0] as Vec3, labels };
  return { v, idx: voxelsOf(v, [1]) };
}

describe('measurement geometry', () => {
  it('RECIST: longest axial diameter and short axis of an ellipse', () => {
    // Semi-axes 20 and 10 mm in one axial slice: 41 x 21 voxels edge to edge.
    const { v, idx } = grid([60, 40, 3], (x, y, z) => z === 1 && ((x - 30) / 20.4) ** 2 + ((y - 20) / 10.4) ** 2 <= 1);
    const d = axialDiameters(v, idx)!;
    expect(d.long).toBeCloseTo(41, 0);
    // The short axis is taken across the chosen long-axis pair, which can be
    // a voxel off the true major axis: allow that quantisation.
    expect(Math.abs(d.short - 21)).toBeLessThan(1.5);
  });

  it('principal length of a tilted rod', () => {
    // 60 voxels along the x = y diagonal.
    const { v, idx } = grid([60, 60, 3], (x, y, z) => z === 1 && x === y && x >= 10 && x < 52);
    const pl = principalLength(v, idx)!;
    expect(pl.len).toBeCloseTo(41 * Math.SQRT2 + 1, 0);
  });

  it('inscribed diameter of a 20 mm tube', () => {
    const { v, idx } = grid([40, 40, 30], (x, y) => (x - 20) ** 2 + (y - 20) ** 2 <= 100);
    const r = inscribedDiameter(v, idx)!;
    expect(r.d).toBeGreaterThan(19);
    expect(r.d).toBeLessThan(22);
  });
});

function loadCase(id: string): CaseData | null {
  const dir = resolve(ROOT, 'public/data', id);
  if (!existsSync(resolve(dir, 'meta.json'))) return null;
  const meta = JSON.parse(readFileSync(resolve(dir, 'meta.json'), 'utf8')) as CaseMeta;
  const centerlines = JSON.parse(readFileSync(resolve(dir, 'centerlines.json'), 'utf8')) as CenterlineData;
  return {
    meta,
    volume: new Uint8Array(0),
    labels: new Uint8Array(readFileSync(resolve(dir, 'labels.u8'))),
    centerlines,
    meshes: null,
  };
}

const liver = loadCase('liver');
const aorta = loadCase('aorta');

describe.skipIf(!liver || !aorta)('measuring the real cases', () => {
  it('the liver_36 tumour: RECIST diameter matches an independent numpy brute force', () => {
    // numpy, largest component, all pixel pairs per axial slice, + one voxel:
    // 66.6 mm. (Its 39 mL volume is a 42 mm equivalent sphere: the lesion is
    // long and flat, 30 mm top to bottom.)
    const m = measureStructure(liver!, 'tumor')!;
    const long = parseFloat(m.rows[0].value);
    expect(Math.abs(long - 66.6)).toBeLessThan(0.6);
    expect(m.caliper!.mm).toBeCloseTo(long, 1);
  });

  it('the liver volume matches the pipeline', () => {
    const m = measureStructure(liver!, 'liver')!;
    expect(parseFloat(m.rows[0].value)).toBeCloseTo(liver!.meta.truth?.organVolumeMl ?? 0, -1);
  });

  it('kidneys come out adult-sized, or flagged as cut off by the scan', () => {
    const m = measureStructure(aorta!, 'kidneys')!;
    for (const r of m.rows.filter((x) => /length/.test(x.label))) {
      const len = parseFloat(r.value);
      if (!/cut off/.test(r.value)) {
        expect(len).toBeGreaterThan(80);
        expect(len).toBeLessThan(150);
      }
    }
  });

  it('the aorta is normal calibre, not aneurysmal', () => {
    const m = measureStructure(aorta!, 'aorta')!;
    expect(m.speech).toMatch(/Not aneurysmal/);
    expect(parseFloat(m.rows[0].value)).toBeLessThan(30);
  });

  it('portal vein and IVC land in physiological ranges', () => {
    const pv = parseFloat(measureStructure(liver!, 'portal_vein')!.rows[0].value);
    expect(pv).toBeGreaterThan(8);
    expect(pv).toBeLessThan(25);
    const ivc = measureStructure(aorta!, 'ivc')!;
    const ap = parseFloat(ivc.rows[0].value);
    expect(ap).toBeGreaterThan(5);
    expect(ap).toBeLessThan(40);
  });
});
