import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type { Pt } from '../src/input/gestures.ts';
import { frameFeatures, fromJson, HandNet, NET_CLASSES, argmax, forward, INPUT_SIZE } from '../src/input/gestureNet.ts';
import { synthHand } from '../src/input/synthHand.ts';

const hand = synthHand({ center: [0.6, 0.5], size: 0.18, facing: [0.3, 0, 0.95] });

function maxDiff(a: Float32Array, b: Float32Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

describe('gesture features', () => {
  it('ignore where the hand is, how big it is, its in-plane turn, and which hand it is', () => {
    const a = frameFeatures(hand);
    const c = Math.cos(0.7);
    const s = Math.sin(0.7);
    const moved: Pt[] = hand.map(([x, y, z]) => [
      -(x * c - y * s) * 1.6 + 0.2, // rotated, scaled, mirrored, shifted
      (x * s + y * c) * 1.6 - 0.1,
      z * 1.6,
    ]);
    const b = frameFeatures(moved);
    expect(maxDiff(a.d3, b.d3)).toBeLessThan(1e-4);
    expect(maxDiff(a.d2, b.d2)).toBeLessThan(1e-4);
  });

  it('separate an open hand from a fist', () => {
    const fist = frameFeatures(synthHand({ center: [0.6, 0.5], size: 0.18, ext: [false, false, false, false] }));
    expect(maxDiff(frameFeatures(hand).d3, fist.d3)).toBeGreaterThan(0.5);
  });
});

describe('shipped gesture network', () => {
  const text = readFileSync(new URL('../public/models/gesture-net.json', import.meta.url), 'utf8');
  const w = fromJson(text);
  const report = (JSON.parse(text) as { report: { heldOut: { heavyOcclusion: Record<string, number>; clean: Record<string, number> } } }).report;

  it('has the expected shape and outputs probabilities', () => {
    expect(w.mean.length).toBe(INPUT_SIZE);
    const out = forward(w, new Float32Array(INPUT_SIZE).fill(1));
    expect(out.now.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 5);
    expect(out.ahead.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 5);
  });

  it('reads clean synthetic poses correctly through its history', () => {
    const net = new HandNet(w);
    const cases: [string, Parameters<typeof synthHand>[0]][] = [
      ['OPEN', { center: [0.6, 0.5], size: 0.18 }],
      ['FIST', { center: [0.6, 0.5], size: 0.18, ext: [false, false, false, false] }],
      ['POINT', { center: [0.6, 0.5], size: 0.18, ext: [true, false, false, false] }],
      ['PINCH', { center: [0.6, 0.5], size: 0.18, ext: [false, false, false, false], pinch: true }],
    ];
    for (const [want, opts] of cases) {
      net.reset();
      let out = net.push(synthHand(opts), 0);
      for (let t = 33; t < 400; t += 33) out = net.push(synthHand(opts), t);
      expect(NET_CLASSES[argmax(out.now)]).toBe(want);
    }
  });

  it('beat the rules under occlusion on held-out sequences (training report)', () => {
    const occ = report.heldOut.heavyOcclusion;
    console.log('held-out heavy occlusion:', occ, 'clean:', report.heldOut.clean);
    expect(occ.fused).toBeGreaterThan(occ.rules + 0.2);
    expect(report.heldOut.clean.fused).toBeGreaterThanOrEqual(report.heldOut.clean.rules);
  });
});
