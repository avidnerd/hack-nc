import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { Centerline } from '../src/devices/centerline.ts';
import { flowProfile } from '../src/devices/flow1d.ts';
import {
  evaluateStent,
  optimizeStent,
  ostiaOnCenterline,
  placeStent,
  sizeAt,
  STENT_LENGTH_MM,
} from '../src/devices/stent.ts';
import type { CenterlineData, CenterlinePoint } from '../src/types.ts';

// The real aorta centerline written by pipeline/run.py.
const data = JSON.parse(
  readFileSync(new URL('../public/data/aorta/centerlines.json', import.meta.url), 'utf8'),
) as CenterlineData;
const cl = new Centerline(data.vessels.aorta);
const ostia = ostiaOnCenterline(cl, data.renalOstia);

/** A straight synthetic tube with a given radius function. */
function tube(r: (s: number) => number, len = 200): Centerline {
  const pts: CenterlinePoint[] = [];
  for (let s = 0; s <= len; s += 2) pts.push({ p: [0, 0, -s], r: r(s), t: [0, 0, -1] });
  return new Centerline(pts);
}

describe('centerline', () => {
  it('parameterises by arc length', () => {
    const t = tube(() => 10);
    expect(t.length).toBeCloseTo(200, 6);
    expect(t.pointAt(51)).toEqual([0, 0, -51]);
    expect(t.radiusAt(77)).toBeCloseTo(10, 6);
    expect(t.nearest([3, 0, -40.4]).s).toBeCloseTo(40, 6);
  });

  it('loads the real aorta', () => {
    expect(cl.length).toBeGreaterThan(150);
    expect(ostia).toHaveLength(2);
  });
});

describe('stent rules', () => {
  it('sizes 15 % over the neck', () => {
    const t = tube(() => 10);
    expect(sizeAt(t, 20)).toBeCloseTo(23, 6);
    const st = evaluateStent(t, [], 20, sizeAt(t, 20));
    expect(st.oversizePct).toBeCloseTo(15, 6);
    expect(st.seals).toBe(true);
    expect(st.verdict).toBe('Seals.');
  });

  it('fails when a renal ostium is covered', () => {
    const t = tube(() => 10);
    const st = evaluateStent(t, [{ s: 30, side: 'left' }], 20, sizeAt(t, 20));
    expect(st.seals).toBe(false);
    expect(st.failReason).toBe('Left renal artery covered');
  });

  it('fails on a short neck', () => {
    // Uniform for 6 mm past s0 = 20, then flaring.
    const t = tube((s) => (s < 26 ? 10 : 14));
    const st = evaluateStent(t, [], 20, 23);
    expect(st.neckMm).toBeLessThan(10);
    expect(st.failReason).toMatch(/^Neck too short/);
  });

  it('fails when the device is far too big for where it sits', () => {
    const t = tube(() => 10);
    const st = evaluateStent(t, [], 20, 30);
    expect(st.failReason).toMatch(/^Oversized/);
  });

  it('fails when it sits entirely above the renals', () => {
    // Covers nothing we segment, but an infrarenal graft above the renals
    // would cover the visceral arteries: still not a seal.
    const t = tube(() => 10);
    const st = evaluateStent(t, [{ s: 120, side: 'right' }], 20, sizeAt(t, 20));
    expect(st.failReason).toBe('Above the renal arteries');
  });

  it('places a sealing stent just below the lowest renal on the real aorta', () => {
    const st = placeStent(cl, ostia);
    expect(st.seals).toBe(true);
    expect(st.oversizePct).toBeCloseTo(15, 0);
    expect(st.neckMm).toBeGreaterThanOrEqual(10);
    // Infrarenal: every ostium is proximal to the covered graft, close by.
    const lowest = Math.max(...ostia.map((o) => o.s));
    expect(st.s0).toBeGreaterThanOrEqual(lowest);
    expect(st.s0 - lowest).toBeLessThanOrEqual(5);
    expect(st.s0 + STENT_LENGTH_MM).toBeLessThanOrEqual(cl.length);
  });

  it('dragging the placed stent higher covers the renals (Moment 2)', () => {
    const placed = placeStent(cl, ostia);
    const higher = evaluateStent(cl, ostia, placed.s0 - 12, placed.diameterMm);
    expect(higher.seals).toBe(false);
    expect(higher.failReason).toMatch(/renal arter/i);
  });

  it('optimize slides a failing stent back to a sealing position', () => {
    const placed = placeStent(cl, ostia);
    const moved = evaluateStent(cl, ostia, placed.s0 - 12, placed.diameterMm);
    const res = optimizeStent(cl, ostia, moved);
    expect(res.stent?.seals).toBe(true);
    expect(Math.abs(res.movedMm)).toBeLessThanOrEqual(40);
  });
});

describe('1D flow', () => {
  it('is 100 for the native vessel', () => {
    expect(flowProfile(cl, null).dpRel).toBeCloseTo(100, 6);
  });

  it('a stenosis is fast and a stent over it relieves the pressure drop', () => {
    const t = tube((s) => (s > 90 && s < 110 ? 5 : 10));
    const native = flowProfile(t, null);
    expect(native.stenosis[100]).toBe(1);
    expect(native.vRel[100]).toBeCloseTo(4, 1);
    const stented = flowProfile(t, { s0: 60, lengthMm: 100, diameterMm: 23 });
    expect(stented.stenosis[100]).toBe(0);
    expect(stented.dpRel).toBeLessThan(native.dpRel);
  });

  it('an oversized graft never widens a healthy vessel', () => {
    // Oversize buys wall apposition, not lumen: on a uniform tube a 15 %
    // oversized stent leaves the pressure drop where it was.
    const t = tube(() => 10);
    const stented = flowProfile(t, { s0: 60, lengthMm: 100, diameterMm: 23 });
    expect(stented.dpRel).toBeCloseTo(100, 6);
    expect(stented.r[100]).toBeCloseTo(10, 6);
  });
});
