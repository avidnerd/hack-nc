import { describe, expect, it } from 'vitest';

import { classify, features, GestureTracker, type HandObs } from '../src/input/gestures.ts';
import { OneEuro } from '../src/input/oneEuro.ts';
import { synthHand, type SynthOpts } from '../src/input/synthHand.ts';
import { TUNING } from '../src/input/tuning.ts';

const base: SynthOpts = { center: [0.6, 0.5], size: 0.18 };

function pose(o: Partial<SynthOpts>): string {
  return classify(features(synthHand({ ...base, ...o })), false);
}

function obs(side: 'left' | 'right', o: Partial<SynthOpts>): HandObs {
  return { side, lm: synthHand({ ...base, ...o }), uv: [0.5, 0.5], indexUv: [0.5, 0.4], pinchUv: [0.5, 0.4] };
}

describe('pose classifier', () => {
  it('open hand facing the camera is OPEN (cut)', () => {
    expect(pose({})).toBe('OPEN');
  });

  it('open hand palm-down is OPEN', () => {
    expect(pose({ up: [0, 0, -1], facing: [0, -1, 0] })).toBe('OPEN');
  });

  it('an open hand is OPEN at any tilt: no fragile facing threshold', () => {
    const tilt = (deg: number) => {
      const r = (deg * Math.PI) / 180;
      return pose({ facing: [Math.sin(r), 0, Math.cos(r)] });
    };
    for (const deg of [0, 20, 40, 60]) expect(tilt(deg)).toBe('OPEN');
  });

  it('fist is FIST', () => {
    expect(pose({ ext: [false, false, false, false] })).toBe('FIST');
  });

  it('pinch is PINCH, not FIST', () => {
    expect(pose({ ext: [false, false, false, false], pinch: true })).toBe('PINCH');
  });

  it('index only is POINT', () => {
    expect(pose({ ext: [true, false, false, false] })).toBe('POINT');
  });

  it('palm normal is along view z when facing the camera', () => {
    const f = features(synthHand(base));
    expect(Math.abs(f.normal[2])).toBeGreaterThan(0.99);
    expect(f.hs).toBeCloseTo(base.size, 2);
  });
});

describe('gesture state machine', () => {
  it('holds a pose for the dwell time before switching', () => {
    const g = new GestureTracker();
    let t = 0;
    let last = g.update([obs('right', {})], t);
    // The first frames dwell from NONE.
    expect(last.pose).toBe('IDLE');
    for (; t <= TUNING.dwellMs + 40; t += 16) last = g.update([obs('right', {})], t);
    expect(last.pose).toBe('OPEN');

    // A brief flicker to FIST must not register.
    last = g.update([obs('right', { ext: [false, false, false, false] })], (t += 16));
    last = g.update([obs('right', {})], (t += 16));
    expect(last.pose).toBe('OPEN');
  });

  it('two pointing hands become CALIPER', () => {
    const g = new GestureTracker();
    let last = g.update([], 0);
    for (let t = 0; t <= 300; t += 16) {
      last = g.update(
        [obs('left', { ext: [true, false, false, false] }), obs('right', { ext: [true, false, false, false], center: [0.9, 0.5] })],
        t,
      );
    }
    expect(last.pose).toBe('CALIPER');
  });

  it('reports LOST only after the timeout', () => {
    const g = new GestureTracker();
    g.update([obs('right', {})], 0);
    expect(g.update([], 100).pose).toBe('IDLE');
    expect(g.update([], 100 + TUNING.lostMs + 1).pose).toBe('LOST');
  });
});

describe('one euro filter', () => {
  // The gesture layer filters landmarks in 640-px camera units and normals in
  // degrees, the scales the spec's beta values are meant for.
  it('suppresses jitter on a still plane normal', () => {
    const f = new OneEuro(TUNING.normalFilter);
    let maxDev = 0;
    let seed = 1;
    const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
    for (let i = 0; i < 300; i++) {
      const y = f.filter(30 + noise(), i * 33);
      if (i > 60) maxDev = Math.max(maxDev, Math.abs(y - 30));
    }
    // Raw jitter is +-1 degree; the spec wants under 1 degree, we hold half that.
    expect(maxDev).toBeLessThan(0.5);
  });

  it('follows a fast landmark move without large lag', () => {
    const f = new OneEuro(TUNING.landmarkFilter);
    let y = 0;
    // 400 px/s across a 640 px frame: a brisk hand.
    for (let i = 0; i < 30; i++) y = f.filter(i * 13.2, i * 33);
    expect(Math.abs(y - 29 * 13.2)).toBeLessThan(15);
  });
});
