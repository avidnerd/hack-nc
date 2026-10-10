/**
 * Trains public/models/gesture-net.json, the temporal pose network.
 *
 *   node --experimental-transform-types scripts/train-gestures.ts [--real recording.json ...]
 *
 * Training data is synthetic by default: sequences of procedural hands that
 * hold poses, change pose, drift, turn and jitter, with occlusion simulated the
 * way MediaPipe actually fails. Hidden fingers have their curl hallucinated,
 * fingertips snap onto neighbours, and the thumb falsely meets or leaves the
 * index, in bursts of a few frames. Labels are the TRUE pose, so the network
 * learns to ride through the bursts on its history taps.
 *
 * Labelled real recordings (Shift+G in the app) can be mixed in with --real;
 * they are oversampled so a few minutes of real hands carry weight.
 *
 * Evaluation runs on held-out synthetic sequences with heavier occlusion and
 * compares the rule classifier, the network, and the fused reading.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { classify, features, rawToPts, type HandPose, type Pt } from '../src/input/gestures.ts';
import {
  assemble,
  argmax,
  forward,
  frameFeatures,
  fuse,
  INPUT_SIZE,
  NET_CLASSES,
  TAPS_MS,
  toJson,
  type NetWeights,
} from '../src/input/gestureNet.ts';
import { synthHand, type SynthOpts } from '../src/input/synthHand.ts';
import type { Vec3 } from '../src/types.ts';

/* ------------------------------------------------------------------ random */

let seed = 12345;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const uni = (a: number, b: number) => a + (b - a) * rnd();
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];

/* ------------------------------------------------------------- hand states */

type Curl = [number, number, number, number];
interface HandState {
  curl: Curl;
  pinch: number;
}

function stateFor(pose: HandPose): HandState {
  switch (pose) {
    case 'OPEN':
      return { curl: [uni(0, 0.15), uni(0, 0.15), uni(0, 0.15), uni(0, 0.2)], pinch: 0 };
    case 'PINCH': {
      // Other fingers anywhere from relaxed to curled, never all straight.
      // Most real pinches curl the other fingers; some leave them relaxed.
      const tight = rnd() < 0.5;
      const rest: Curl = tight
        ? [0.3, uni(0.85, 1), uni(0.85, 1), uni(0.85, 1)]
        : [0.3, uni(0.25, 1), uni(0.3, 1), uni(0.3, 1)];
      if (rnd() < 0.3) rest[1] = rest[2] = rest[3] = uni(0, 0.2); // "OK" sign...
      if (rest[1] < 0.25 && rest[2] < 0.25 && rest[3] < 0.25) rest[3] = uni(0.6, 1); // ...but not quite
      return { curl: rest, pinch: uni(0.85, 1) };
    }
    case 'POINT':
      return { curl: [uni(0, 0.15), uni(0.75, 1), uni(0.75, 1), uni(0.75, 1)], pinch: 0 };
    case 'FIST':
      return { curl: [uni(0.8, 1), uni(0.8, 1), uni(0.8, 1), uni(0.8, 1)], pinch: 0 };
    case 'NONE':
    default: {
      // Everything that should start nothing: relaxed claws, peace signs, three up.
      const kind = Math.floor(rnd() * 4);
      if (kind === 0) return { curl: [uni(0.35, 0.65), uni(0.35, 0.65), uni(0.35, 0.65), uni(0.35, 0.7)], pinch: uni(0, 0.4) };
      if (kind === 1) return { curl: [uni(0, 0.15), uni(0, 0.15), uni(0.8, 1), uni(0.8, 1)], pinch: 0 };
      if (kind === 2) return { curl: [uni(0, 0.15), uni(0, 0.15), uni(0, 0.15), uni(0.8, 1)], pinch: 0 };
      return { curl: [uni(0.8, 1), uni(0, 0.15), uni(0.8, 1), uni(0.8, 1)], pinch: 0 };
    }
  }
}

const POSES: HandPose[] = ['OPEN', 'PINCH', 'POINT', 'FIST', 'NONE'];
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function rotate(v: Vec3, axis: Vec3, ang: number): Vec3 {
  const [x, y, z] = axis;
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const d = v[0] * x + v[1] * y + v[2] * z;
  return [
    v[0] * c + (y * v[2] - z * v[1]) * s + x * d * (1 - c),
    v[1] * c + (z * v[0] - x * v[2]) * s + y * d * (1 - c),
    v[2] * c + (x * v[1] - y * v[0]) * s + z * d * (1 - c),
  ];
}

/* --------------------------------------------------------------- sequences */

const FPS = 30;
const SEQ = 36;
const AHEAD = 5; // frames ~ 150 ms

interface Seq {
  pts: Pt[][];
  labels: number[];
  t: number[];
}

function makeSequence(occlusion: number): Seq {
  // 1 to 3 poses, with smooth transitions between them.
  const nSeg = 1 + Math.floor(rnd() * 3);
  const poses = Array.from({ length: nSeg }, () => pick(POSES));
  const states = poses.map(stateFor);
  const cuts = Array.from({ length: nSeg - 1 }, () => Math.floor(uni(6, SEQ - 6))).sort((a, b) => a - b);
  const trans = Math.floor(uni(3, 8));

  // Orientation: fingers roughly up, palm anywhere from facing the camera to
  // edge-on and slightly away, drifting slowly.
  const roll0 = uni(-0.9, 0.9);
  const tilt0 = uni(-1.4, 1.4); // around the finger axis: palm -> edge-on
  const pitch0 = uni(-0.6, 0.6);
  const roll1 = roll0 + uni(-0.3, 0.3);
  const tilt1 = tilt0 + uni(-0.4, 0.4);
  const c0: [number, number] = [uni(0.35, 1.0), uni(0.3, 0.7)];
  const c1: [number, number] = [c0[0] + uni(-0.25, 0.25), c0[1] + uni(-0.2, 0.2)];
  const size0 = uni(0.1, 0.24);
  const size1 = size0 * uni(0.85, 1.2);

  const seq: Seq = { pts: [], labels: [], t: [] };
  let burst = 0;
  let burstFingers: number[] = [];
  let burstKind = 0;

  for (let f = 0; f < SEQ; f++) {
    const u = f / (SEQ - 1);
    // Which segment, and how far into a transition.
    let seg = 0;
    while (seg < cuts.length && f >= cuts[seg]) seg++;
    let st = states[seg];
    let label = poses[seg];
    if (seg > 0 && f - cuts[seg - 1] < trans) {
      const k = (f - cuts[seg - 1]) / trans;
      const a = states[seg - 1];
      const b = states[seg];
      st = { curl: a.curl.map((v, i) => lerp(v, b.curl[i], k)) as Curl, pinch: lerp(a.pinch, b.pinch, k) };
      label = k < 0.5 ? poses[seg - 1] : poses[seg];
    }

    const roll = lerp(roll0, roll1, u);
    const tilt = lerp(tilt0, tilt1, u);
    let up: Vec3 = rotate([0, 1, 0], [0, 0, 1], roll);
    up = rotate(up, [1, 0, 0], pitch0);
    let facing: Vec3 = rotate([0, 0, 1], up, tilt);
    facing = rotate(facing, [1, 0, 0], pitch0 * 0.5);
    const size = lerp(size0, size1, u);
    const opts: SynthOpts = {
      center: [lerp(c0[0], c1[0], u), lerp(c0[1], c1[1], u)],
      size,
      up,
      facing,
      curl: st.curl,
      pinchAmount: st.pinch,
    };
    let pts = synthHand(opts);

    // Occlusion bursts, likelier when the hand is edge-on (fingers overlap).
    const edgeOn = 1 - Math.abs(facing[2]);
    if (burst <= 0 && rnd() < occlusion * (0.15 + 0.6 * edgeOn)) {
      // Real MediaPipe glitches are brief. Keeping bursts under 200 ms means the
      // deepest history tap (300 ms) always sees the true hand.
      burst = Math.floor(uni(2, 7));
      burstFingers = [Math.floor(rnd() * 4)];
      if (rnd() < 0.4) burstFingers.push(Math.floor(rnd() * 4));
      burstKind = Math.floor(rnd() * 3);
    }
    if (burst > 0) {
      burst--;
      if (burstKind === 0) {
        // Hallucinated curl: the hidden finger is reported in the wrong state.
        const wrong = { ...opts, curl: [...st.curl] as Curl };
        for (const fi of burstFingers) wrong.curl![fi] = st.curl[fi] > 0.5 ? uni(0, 0.3) : uni(0.7, 1);
        const alt = synthHand(wrong);
        for (const fi of burstFingers) for (let j = 0; j < 4; j++) pts[5 + fi * 4 + j] = alt[5 + fi * 4 + j];
      } else if (burstKind === 1) {
        // A fingertip snaps onto its neighbour's.
        for (const fi of burstFingers) {
          const nb = fi === 3 ? 2 : fi + 1;
          pts[8 + fi * 4] = [...pts[8 + nb * 4]] as Pt;
          pts[7 + fi * 4] = [...pts[7 + nb * 4]] as Pt;
        }
      } else if (st.pinch > 0.5 || st.curl[0] < 0.5) {
        // The thumb falsely leaves a pinch, or falsely meets an extended index.
        // (Not applied to fists: a perfect pinch shape there is not noise.)
        const alt = synthHand({ ...opts, pinchAmount: st.pinch > 0.5 ? uni(0, 0.4) : uni(0.8, 1) });
        for (const i of [3, 4, 6, 7, 8]) pts[i] = alt[i];
      }
    }

    // Per-landmark jitter; MediaPipe's depth is much noisier than x/y.
    pts = pts.map((p) => [p[0] + gauss() * 0.012 * size, p[1] + gauss() * 0.012 * size, p[2] + gauss() * 0.05 * size] as Pt);

    seq.pts.push(pts);
    seq.labels.push(NET_CLASSES.indexOf(label));
    seq.t.push((f * 1000) / FPS);
  }
  return seq;
}

/* -------------------------------------------------------------- real data */

interface RealRecording {
  aspect: number;
  frames: { t: number; label: string; hands: { side: string; lm: number[] }[] }[];
}

function realSequences(path: string): Seq[] {
  const rec = JSON.parse(readFileSync(path, 'utf8')) as RealRecording;
  const out: Seq[] = [];
  let cur: Seq | null = null;
  for (const fr of rec.frames) {
    const k = NET_CLASSES.indexOf(fr.label as HandPose);
    if (fr.hands.length !== 1 || k < 0) {
      cur = null;
      continue;
    }
    if (!cur) {
      cur = { pts: [], labels: [], t: [] };
      out.push(cur);
    }
    cur.pts.push(rawToPts(fr.hands[0].lm, rec.aspect));
    cur.labels.push(k);
    cur.t.push(fr.t);
  }
  return out.filter((s) => s.pts.length > 12);
}

/* ---------------------------------------------------------------- samples */

interface Samples {
  x: Float32Array[];
  yNow: number[];
  yAhead: number[];
  /** Rule-classifier reading for the same frame (with hysteresis), for evaluation. */
  rule: HandPose[];
}

function samplesFrom(seqs: Seq[], repeat = 1): Samples {
  const s: Samples = { x: [], yNow: [], yAhead: [], rule: [] };
  for (const seq of seqs) {
    const d3s = seq.pts.map((p) => frameFeatures(p));
    let pinching = false;
    const rules = seq.pts.map((p) => {
      const r = classify(features(p), pinching);
      pinching = r === 'PINCH';
      return r;
    });
    for (let f = 4; f < seq.pts.length; f++) {
      const past = TAPS_MS.map((dt) => {
        let best = 0;
        for (let g = 0; g <= f; g++) if (Math.abs(seq.t[g] - (seq.t[f] - dt)) < Math.abs(seq.t[best] - (seq.t[f] - dt))) best = g;
        return d3s[best].d3;
      });
      const x = assemble(d3s[f], past);
      for (let r = 0; r < repeat; r++) {
        s.x.push(x);
        s.yNow.push(seq.labels[f]);
        s.yAhead.push(seq.labels[Math.min(seq.labels.length - 1, f + AHEAD)]);
        s.rule.push(rules[f]);
      }
    }
  }
  return s;
}

/* ---------------------------------------------------------------- training */

function train(data: Samples, hidden = 64, epochs = 14): NetWeights {
  const N = data.x.length;
  const D = INPUT_SIZE;
  const C = NET_CLASSES.length;
  const O = 2 * C;

  const mean = new Float32Array(D);
  const scale = new Float32Array(D);
  for (const x of data.x) for (let i = 0; i < D; i++) mean[i] += x[i] / N;
  for (const x of data.x) for (let i = 0; i < D; i++) scale[i] += (x[i] - mean[i]) ** 2 / N;
  for (let i = 0; i < D; i++) scale[i] = Math.sqrt(scale[i]) + 1e-3;

  // Every class counts the same however many frames of it there are.
  const counts = new Array(C).fill(0);
  for (const y of data.yNow) counts[y]++;
  const cw = counts.map((c) => N / (C * Math.max(c, 1)));

  const he = (fanIn: number) => gauss() * Math.sqrt(2 / fanIn);
  const w1 = Float32Array.from({ length: D * hidden }, () => he(D));
  const b1 = new Float32Array(hidden);
  const w2 = Float32Array.from({ length: hidden * O }, () => he(hidden));
  const b2 = new Float32Array(O);
  const params = [w1, b1, w2, b2];
  const m = params.map((p) => new Float32Array(p.length));
  const v = params.map((p) => new Float32Array(p.length));
  const g = params.map((p) => new Float32Array(p.length));

  const B = 256;
  const lr = 3e-3;
  let step = 0;
  const z = new Float32Array(B * D);
  const h = new Float32Array(B * hidden);
  const dlog = new Float32Array(B * O);
  const dh = new Float32Array(B * hidden);
  const order = Array.from({ length: N }, (_, i) => i);

  for (let ep = 0; ep < epochs; ep++) {
    for (let i = N - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    let loss = 0;
    for (let start = 0; start + B <= N; start += B) {
      // Standardise, with a little input noise so no single distance is leaned on.
      for (let b = 0; b < B; b++) {
        const x = data.x[order[start + b]];
        for (let i = 0; i < D; i++) z[b * D + i] = (x[i] - mean[i]) / scale[i] + gauss() * 0.1;
      }
      // Hidden layer.
      for (let b = 0; b < B; b++) {
        const hr = b * hidden;
        for (let j = 0; j < hidden; j++) h[hr + j] = b1[j];
        const zr = b * D;
        for (let i = 0; i < D; i++) {
          const zi = z[zr + i];
          const wr = i * hidden;
          for (let j = 0; j < hidden; j++) h[hr + j] += zi * w1[wr + j];
        }
        for (let j = 0; j < hidden; j++) if (h[hr + j] < 0) h[hr + j] = 0;
      }
      // Two softmax heads; the look-ahead head counts half.
      for (let b = 0; b < B; b++) {
        const idx = order[start + b];
        const logits = new Float32Array(O);
        logits.set(b2);
        for (let j = 0; j < hidden; j++) {
          const hj = h[b * hidden + j];
          if (hj === 0) continue;
          for (let k = 0; k < O; k++) logits[k] += hj * w2[j * O + k];
        }
        for (const [off, y, wt] of [[0, data.yNow[idx], 1], [C, data.yAhead[idx], 0.5]] as const) {
          let mx = -Infinity;
          for (let k = 0; k < C; k++) mx = Math.max(mx, logits[off + k]);
          let sum = 0;
          const p = new Float32Array(C);
          for (let k = 0; k < C; k++) sum += p[k] = Math.exp(logits[off + k] - mx);
          const w = (wt * cw[y]) / B;
          for (let k = 0; k < C; k++) {
            p[k] /= sum;
            dlog[b * O + off + k] = (p[k] - (k === y ? 1 : 0)) * w;
          }
          loss -= Math.log(p[y] + 1e-9) * wt;
        }
      }
      // Backward.
      for (const gg of g) gg.fill(0);
      const [gw1, gb1, gw2, gb2] = g;
      dh.fill(0);
      for (let b = 0; b < B; b++) {
        for (let k = 0; k < O; k++) gb2[k] += dlog[b * O + k];
        for (let j = 0; j < hidden; j++) {
          const hj = h[b * hidden + j];
          if (hj === 0) continue;
          let acc = 0;
          for (let k = 0; k < O; k++) {
            const d = dlog[b * O + k];
            gw2[j * O + k] += hj * d;
            acc += w2[j * O + k] * d;
          }
          dh[b * hidden + j] = acc;
        }
      }
      for (let b = 0; b < B; b++) {
        for (let j = 0; j < hidden; j++) gb1[j] += dh[b * hidden + j];
        const zr = b * D;
        const hr = b * hidden;
        for (let i = 0; i < D; i++) {
          const zi = z[zr + i];
          if (zi === 0) continue;
          const wr = i * hidden;
          for (let j = 0; j < hidden; j++) gw1[wr + j] += zi * dh[hr + j];
        }
      }
      // Adam with a little weight decay.
      step++;
      const bc1 = 1 - 0.9 ** step;
      const bc2 = 1 - 0.999 ** step;
      for (let pi = 0; pi < params.length; pi++) {
        const p = params[pi];
        const gp = g[pi];
        for (let i = 0; i < p.length; i++) {
          const gi = gp[i] + 1e-4 * p[i];
          m[pi][i] = 0.9 * m[pi][i] + 0.1 * gi;
          v[pi][i] = 0.999 * v[pi][i] + 0.001 * gi * gi;
          p[i] -= (lr * (m[pi][i] / bc1)) / (Math.sqrt(v[pi][i] / bc2) + 1e-8);
        }
      }
    }
    console.log(`  epoch ${ep + 1}/${epochs}  loss ${(loss / N).toFixed(4)}`);
  }
  return { classes: NET_CLASSES.map(String), hidden, mean, scale, w1, b1, w2, b2 };
}

/* -------------------------------------------------------------- evaluation */

function evaluate(w: NetWeights, data: Samples): { rules: number; net: number; fused: number; aheadNet: number } {
  let rules = 0;
  let net = 0;
  let fused = 0;
  let ahead = 0;
  for (let i = 0; i < data.x.length; i++) {
    const out = forward(w, data.x[i]);
    const y = data.yNow[i];
    if (NET_CLASSES.indexOf(data.rule[i]) === y) rules++;
    if (argmax(out.now) === y) net++;
    if (NET_CLASSES.indexOf(fuse(data.rule[i], out)) === y) fused++;
    if (argmax(out.ahead) === data.yAhead[i]) ahead++;
  }
  const n = data.x.length;
  return { rules: rules / n, net: net / n, fused: fused / n, aheadNet: ahead / n };
}

/* -------------------------------------------------------------------- main */

const args = process.argv.slice(2);
const realPaths: string[] = [];
for (let i = 0; i < args.length; i++) if (args[i] === '--real' && args[i + 1]) realPaths.push(args[++i]);

const t0 = Date.now();
console.log('[train-gestures] generating synthetic sequences');
const trainSeqs = Array.from({ length: 2400 }, () => makeSequence(1.0));
const realSeqs = realPaths.flatMap(realSequences);
if (realPaths.length) console.log(`  + ${realSeqs.length} real sequences from ${realPaths.join(', ')}`);
const trainData = samplesFrom(trainSeqs);
if (realSeqs.length) {
  const real = samplesFrom(realSeqs, 5);
  trainData.x.push(...real.x);
  trainData.yNow.push(...real.yNow);
  trainData.yAhead.push(...real.yAhead);
  trainData.rule.push(...real.rule);
}
console.log(`  ${trainData.x.length} training frames`);

const weights = train(trainData);

// Held out: fresh seed, and twice the occlusion rate it was trained on.
seed = 987654;
const cleanTest = samplesFrom(Array.from({ length: 300 }, () => makeSequence(0)));
const occTest = samplesFrom(Array.from({ length: 300 }, () => makeSequence(2.0)));
const clean = evaluate(weights, cleanTest);
const occ = evaluate(weights, occTest);
const pct = (x: number) => `${(100 * x).toFixed(1)} %`;
console.log('\n                     rules     network   fused');
console.log(`  clean hands        ${pct(clean.rules).padEnd(10)}${pct(clean.net).padEnd(10)}${pct(clean.fused)}`);
console.log(`  heavy occlusion    ${pct(occ.rules).padEnd(10)}${pct(occ.net).padEnd(10)}${pct(occ.fused)}`);
console.log(`  look-ahead head (pose 150 ms later): ${pct(occ.aheadNet)} under occlusion`);

const report = {
  trainedOn: { syntheticSequences: trainSeqs.length, realSequences: realSeqs.length, frames: trainData.x.length },
  heldOut: {
    clean: { rules: clean.rules, network: clean.net, fused: clean.fused },
    heavyOcclusion: { rules: occ.rules, network: occ.net, fused: occ.fused, lookAhead: occ.aheadNet },
  },
  seconds: (Date.now() - t0) / 1000,
};
writeFileSync('public/models/gesture-net.json', toJson(weights, report));
console.log(`\nwrote public/models/gesture-net.json in ${report.seconds.toFixed(0)} s`);
