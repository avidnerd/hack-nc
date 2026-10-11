/**
 * Measurement that knows the anatomy: snapping, structure gaps, named cuts.
 * Synthetic volumes pin the geometry; the real liver case pins the clinically
 * meaningful readings.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { contextFrom, evaluatePlane } from '../src/planning/engine.ts';
import { idsFor, namedCut, snapCaliper, structureDistance } from '../src/planning/smartMeasure.ts';
import { PlanningGrid } from '../src/planning/volume.ts';
import type { CaseData, CaseMeta, LabelDef, Vec3 } from '../src/types.ts';

/** A 1 mm volume with two labelled boxes: 1 = "a" at x 10..19, 2 = "b" at x 30..39. */
function twoBoxes(): CaseData {
  const shape: Vec3 = [50, 20, 20];
  const labels = new Uint8Array(shape[0] * shape[1] * shape[2]);
  for (let z = 5; z < 15; z++)
    for (let y = 5; y < 15; y++)
      for (let x = 0; x < 50; x++) {
        const id = x >= 10 && x < 20 ? 1 : x >= 30 && x < 40 ? 2 : 0;
        if (id) labels[x + 50 * (y + 20 * z)] = id;
      }
  const L = (id: number, key: string, role: LabelDef['role']): LabelDef => ({ id, key, name: key, color: [1, 1, 1], role });
  const meta = {
    id: 't', name: 't', kind: 'liver', shape, spacing: [1, 1, 1], origin: [0, 0, 0],
    labels: [L(1, 'tumor', 'tumor'), L(2, 'portal_vein', 'vessel')],
  } as unknown as CaseMeta;
  return { meta, volume: new Uint8Array(labels.length), labels, centerlines: null, meshes: null };
}

describe('caliper snapping', () => {
  it('lands both ends on the walls of the box it spans and names it', () => {
    const d = twoBoxes();
    // Clicked 2 mm outside each wall of box "a" (walls at x = 9.5 and 19.5).
    const s = snapCaliper(d, [7.5, 10, 10], [21.5, 10, 10]);
    // Walls are found to the 0.5 mm search step.
    expect(Math.abs(s.a[0] - 9.5)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(s.b[0] - 19.5)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(s.mm - 10)).toBeLessThanOrEqual(1);
    expect(s.label).toBe('tumor');
  });

  it('names a span between two structures', () => {
    const s = snapCaliper(twoBoxes(), [21, 10, 10], [28, 10, 10]);
    expect(Math.abs(s.mm - 10)).toBeLessThanOrEqual(1);
    expect(s.label).toBe('tumor to portal_vein');
  });

  it('leaves ends alone when no wall is near', () => {
    // A line through empty space beside the boxes.
    const s = snapCaliper(twoBoxes(), [24, 18, 18], [26, 18, 18]);
    expect(s.mm).toBeCloseTo(2, 6);
  });
});

describe('structure distance', () => {
  it('is the wall-to-wall gap between two boxes', () => {
    const d = twoBoxes();
    const r = structureDistance(d, idsFor(d, 'tumor'), idsFor(d, 'portal_vein'))!;
    // Voxel centres 19 and 30 are 11 mm apart; the surfaces are 10 mm apart.
    expect(r.mm).toBeCloseTo(10, 6);
    expect(r.a[0]).toBe(19);
    expect(r.b[0]).toBe(30);
  });

  it('gives up beyond its reach', () => {
    const d = twoBoxes();
    expect(structureDistance(d, idsFor(d, 'tumor'), idsFor(d, 'portal_vein'), 5)).toBeNull();
  });
});

describe('named cuts', () => {
  it('puts the structure on the resected side, the asked distance clear of it', () => {
    const d = twoBoxes();
    const p = namedCut(d, 'sagittal', idsFor(d, 'tumor'), 5, (pl) => -pl.n[0])!;
    // Score prefers n = -x: the box (x 9.5..19.5 surface) is resected, cut 5 mm beyond its far wall.
    expect(p.n).toEqual([-1, 0, 0]);
    expect(-p.d).toBeCloseTo(24.5, 6);
  });
});

const dir = resolve(__dirname, '..', 'public/data/liver');
const liver: CaseData | null = existsSync(resolve(dir, 'meta.json'))
  ? {
      meta: JSON.parse(readFileSync(resolve(dir, 'meta.json'), 'utf8')) as CaseMeta,
      volume: new Uint8Array(0),
      labels: new Uint8Array(readFileSync(resolve(dir, 'labels.u8'))),
      centerlines: JSON.parse(readFileSync(resolve(dir, 'centerlines.json'), 'utf8')),
      meshes: null,
    }
  : null;

describe.skipIf(!liver)('on the real liver', () => {
  it('"sagittal cut 10 mm from the tumour" gives a ~10 mm margin and keeps the larger side', () => {
    const ctx = contextFrom(new PlanningGrid(liver!));
    const p = namedCut(liver!, 'sagittal', idsFor(liver!, 'tumor'), 10, (pl) => evaluatePlane(ctx, pl, { locate: false, vessels: false }).remnantPct)!;
    const m = evaluatePlane(ctx, p);
    expect(m.tumorIncomplete).toBe(false);
    // The planning grid is 2 mm, so the margin lands within a voxel of 10.
    expect(Math.abs(m.marginMm - 10)).toBeLessThanOrEqual(2.5);
    expect(m.remnantPct).toBeGreaterThan(50);
  });

  it('measures how far the tumour sits from the portal vein', () => {
    const r = structureDistance(liver!, idsFor(liver!, 'tumor'), idsFor(liver!, 'portal_vein'));
    // Either a real gap or "more than 6 cm"; when found it is a plausible distance.
    if (r) {
      expect(r.mm).toBeGreaterThanOrEqual(0);
      expect(r.mm).toBeLessThan(60);
    }
  });
});
