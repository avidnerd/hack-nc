/**
 * Build-time asset prep for the site. Everything comes from the app; nothing
 * here is authored by hand.
 *
 *   1. The liver CT and label volumes from ../public/data/liver at two
 *      resolutions, block-averaged so no axis exceeds 128 (lo, first paint)
 *      or 256 (hi, streamed in after) voxels, gzipped.
 *   2. Scene stats the scroll sweep needs (tumour centroid, organ bounds,
 *      hepatic vessel depth), written to meta.json next to the volumes.
 *   3. The gesture clips rendered by ../scripts/gesture-gifs.ts (docs/video).
 *   4. MediaPipe's WASM runtime and the hand model, for the webcam opt-in.
 *
 * Runs before `dev` and `build`. Idempotent; skips work already done.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const site = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = join(site, '..');
const srcDir = join(app, 'public', 'data', 'liver');
const outDir = join(site, 'public', 'data', 'liver');

function fresh(out, ...inputs) {
  if (!existsSync(out)) return false;
  const t = statSync(out).mtimeMs;
  return inputs.every((i) => statSync(i).mtimeMs <= t);
}

/* ------------------------------------------------------------ 1. volumes */

const metaIn = join(srcDir, 'meta.json');
const volIn = join(srcDir, 'volume.u8');
const labIn = join(srcDir, 'labels.u8');

if (!existsSync(volIn)) {
  console.error('[prepare-data] ../public/data/liver is missing; run the app pipeline first');
  process.exit(1);
}

/**
 * One resolution level: block-average the CT (and vote the labels) by a
 * whole-number factor per axis so no axis exceeds `max` voxels, then write
 * gzipped volumes plus a meta.json with the sweep stats.
 */
function buildLevel(name, max) {
  const dir = join(outDir, name);
  const metaOut = join(dir, 'meta.json');
  if (fresh(metaOut, metaIn, volIn, labIn, fileURLToPath(import.meta.url))) {
    console.log(`[prepare-data] liver/${name} up to date`);
    return;
  }
  const meta = JSON.parse(readFileSync(metaIn, 'utf8'));
  const [nx, ny, nz] = meta.shape;
  const vol = readFileSync(volIn);
  const lab = readFileSync(labIn);

  const [fx, fy, fz] = [nx, ny, nz].map((n) => Math.ceil(n / max));
  const [ox, oy, oz] = [Math.floor(nx / fx), Math.floor(ny / fy), Math.floor(nz / fz)];
  const vOut = new Uint8Array(ox * oy * oz);
  const lOut = new Uint8Array(ox * oy * oz);
  const block = fx * fy * fz;

  const byKey = Object.fromEntries(meta.labels.map((l) => [l.key, l.id]));
  // Thin structures lose to the liver in a plain majority vote and vanish when
  // downsampled. Any vote for the tumour or a vessel wins its block.
  const priority = [byKey.tumor, byKey.hepatic_vessels, byKey.portal_vein, byKey.ivc, byKey.aorta].filter(
    (id) => id !== undefined,
  );

  for (let k = 0; k < oz; k++) {
    for (let j = 0; j < oy; j++) {
      for (let i = 0; i < ox; i++) {
        let sum = 0;
        const votes = new Map();
        for (let dk = 0; dk < fz; dk++)
          for (let dj = 0; dj < fy; dj++)
            for (let di = 0; di < fx; di++) {
              const idx = fx * i + di + nx * (fy * j + dj + ny * (fz * k + dk));
              sum += vol[idx];
              const id = lab[idx];
              votes.set(id, (votes.get(id) ?? 0) + 1);
            }
        const o = i + ox * (j + oy * k);
        vOut[o] = Math.round(sum / block);
        let pick = priority.find((id) => votes.has(id));
        if (pick === undefined) {
          let best = -1;
          for (const [id, n] of votes) if (n > best) (best = n), (pick = id);
        }
        lOut[o] = pick;
      }
    }
  }

  /* -------------------------------------------------------- 2. stats */

  const spacing = [meta.spacing[0] * fx, meta.spacing[1] * fy, meta.spacing[2] * fz];
  const stats = {};
  for (const key of ['liver', 'tumor', 'hepatic_vessels']) {
    const id = byKey[key];
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    const c = [0, 0, 0];
    let n = 0;
    for (let k = 0; k < oz; k++)
      for (let j = 0; j < oy; j++)
        for (let i = 0; i < ox; i++) {
          if (lOut[i + ox * (j + oy * k)] !== id) continue;
          const pt = [i * spacing[0], j * spacing[1], k * spacing[2]];
          for (let a = 0; a < 3; a++) {
            lo[a] = Math.min(lo[a], pt[a]);
            hi[a] = Math.max(hi[a], pt[a]);
            c[a] += pt[a];
          }
          n++;
        }
    stats[key] = { min: lo, max: hi, centroid: c.map((v) => v / Math.max(n, 1)), voxels: n };
  }

  mkdirSync(dir, { recursive: true });
  // Gzipped here rather than trusted to the host: static hosts rarely
  // compress octet-streams. The browser inflates with DecompressionStream.
  const vz = gzipSync(vOut, { level: 9 });
  const lz = gzipSync(lOut, { level: 9 });
  writeFileSync(join(dir, 'volume.u8.gz'), vz);
  writeFileSync(join(dir, 'labels.u8.gz'), lz);
  writeFileSync(
    metaOut,
    JSON.stringify(
      {
        id: meta.id,
        name: meta.name,
        shape: [ox, oy, oz],
        spacing,
        origin: meta.origin,
        huCurve: meta.huCurve,
        labels: meta.labels,
        windowPresets: meta.windowPresets,
        bytes: { volume: vz.length, labels: lz.length },
        stats,
      },
      null,
      1,
    ),
  );
  const mb = ((vz.length + lz.length) / 1e6).toFixed(2);
  console.log(`[prepare-data] liver/${name} ${nx}x${ny}x${nz} -> ${ox}x${oy}x${oz}, ${mb} MB gzipped`);
}

// First paint loads `lo`; `hi` streams in after and replaces it.
buildLevel('lo', 128);
buildLevel('hi', 256);
for (const stale of ['volume.u8', 'labels.u8', 'meta.json']) rmSync(join(outDir, stale), { force: true });

/* --------------------------------------------------------- 3. mediapipe */

const wasmDst = join(site, 'public', 'mediapipe', 'wasm');
const modelSrc = join(app, 'public', 'models', 'hand_landmarker.task');
const modelDst = join(site, 'public', 'models', 'hand_landmarker.task');

const wasmSrc = join(site, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
if (existsSync(wasmSrc)) {
  if (!existsSync(wasmDst)) {
    mkdirSync(wasmDst, { recursive: true });
    cpSync(wasmSrc, wasmDst, { recursive: true });
    console.log('[prepare-data] mediapipe wasm copied');
  }
} else {
  console.warn('[prepare-data] @mediapipe/tasks-vision not installed; webcam opt-in disabled');
}
if (existsSync(modelSrc) && !existsSync(modelDst)) {
  mkdirSync(dirname(modelDst), { recursive: true });
  cpSync(modelSrc, modelDst);
  console.log('[prepare-data] hand model copied');
}

/* ------------------------------------------------------- gesture clips */

const clipSrc = join(app, 'docs', 'video');
if (existsSync(clipSrc)) {
  const clipDst = join(site, 'public', 'video');
  mkdirSync(clipDst, { recursive: true });
  cpSync(clipSrc, clipDst, { recursive: true });
  console.log('[prepare-data] gesture clips copied');
}
