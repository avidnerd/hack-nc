/**
 * Builds public/demo/landmarks.json: a scripted landmark stream that walks
 * the gesture layer through Moment 1 (grab-rotate, cut, tilt, lock and lift, caliper,
 * two-hand zoom).
 *
 * TODO(ship): replace with a real Shift+D recording made on the demo laptop.
 * This synthetic stream exists so `D` works and the e2e smoke test has input
 * from a fresh clone.
 *
 *   node scripts/make-demo.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';

import { synthHand, toRaw, type SynthOpts } from '../src/input/synthHand.ts';

const ASPECT = 4 / 3;
const FPS = 30;
type Hand = { side: 'left' | 'right'; o: SynthOpts };
const frames: { t: number; hands: { side: 'left' | 'right'; lm: number[] }[] }[] = [];

let t = 0;
function emit(hands: Hand[]): void {
  frames.push({
    t: Math.round(t),
    hands: hands.map((h) => ({ side: h.side, lm: toRaw(synthHand(h.o), ASPECT).map((v) => +v.toFixed(5)) })),
  });
  t += 1000 / FPS;
}

function segment(seconds: number, at: (s: number) => Hand[]): void {
  const n = Math.round(seconds * FPS);
  for (let i = 0; i < n; i++) emit(at(i / Math.max(n - 1, 1)));
}

const ease = (x: number) => 0.5 - 0.5 * Math.cos(Math.PI * x);

// 1. Nothing for half a second.
segment(0.5, () => []);

// 2. Pinch and drag right then back: grab the body and turn it.
const curled = [false, false, false, false] as [boolean, boolean, boolean, boolean];
segment(3.0, (s) => {
  const x = 0.55 + 0.3 * Math.sin(ease(s) * Math.PI * 2);
  return [{ side: 'right', o: { center: [x, 0.55], size: 0.16, ext: curled, pinch: true } }];
});

// 3. Open hand: the cut appears under it, then the palm tilts and slides.
segment(1.0, () => [{ side: 'right', o: { center: [0.7, 0.5], size: 0.17 } }]);
segment(3.0, (s) => {
  const tilt = ease(s) * 0.45;
  return [
    {
      side: 'right',
      o: {
        center: [0.7 - 0.12 * ease(s), 0.5],
        size: 0.17 * (1 + 0.15 * ease(s)),
        facing: [Math.sin(tilt), 0, Math.cos(tilt)],
      },
    },
  ];
});

// 4. Fist: lock (the resected piece lifts away).
segment(1.2, () => [{ side: 'right', o: { center: [0.6, 0.5], size: 0.19, ext: curled } }]);

// 5. Hands down briefly, then two index fingers spread apart (caliper).
segment(0.6, () => []);
segment(2.5, (s) => {
  const gap = 0.12 + 0.18 * ease(s);
  const pt = [true, false, false, false] as [boolean, boolean, boolean, boolean];
  return [
    { side: 'left', o: { center: [0.66 - gap, 0.55], size: 0.15, ext: pt } },
    { side: 'right', o: { center: [0.66 + gap, 0.55], size: 0.15, ext: pt } },
  ];
});

// 6. Two pinches pulled apart: zoom in.
segment(0.6, () => []);
segment(2.0, (s) => {
  const gap = 0.12 + 0.12 * ease(s);
  return [
    { side: 'left', o: { center: [0.66 - gap, 0.5], size: 0.15, ext: curled, pinch: true } },
    { side: 'right', o: { center: [0.66 + gap, 0.5], size: 0.15, ext: curled, pinch: true } },
  ];
});

// 7. Fist again to unlock (the piece settles back), then hands away.
segment(0.6, () => []);
segment(1.0, () => [{ side: 'right', o: { center: [0.66, 0.5], size: 0.18, ext: curled } }]);
segment(0.6, () => []);

mkdirSync('public/demo', { recursive: true });
writeFileSync('public/demo/landmarks.json', JSON.stringify({ aspect: ASPECT, frames }));
console.log(`wrote public/demo/landmarks.json: ${frames.length} frames, ${(t / 1000).toFixed(1)} s`);
