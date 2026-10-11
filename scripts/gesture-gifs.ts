/**
 * Builds one short clip per gesture or demo moment: a 3D surgical glove in a
 * camera-feed inset, next to the real app reacting to it.
 *
 *   docs/gifs/<clip>.gif     960 x 600, for the README
 *   docs/video/<clip>.webm   1920 x 1200 VP9, for the website
 *
 * Nothing in the app is faked. Each clip is a procedural landmark stream
 * (synthHand.ts) served in place of public/demo/landmarks.json and replayed
 * with `D`, so it goes through the same 1€ filters, gesture state machine and
 * hand controller as a camera would. The glove (scripts/gifkit/glove.js) is
 * posed from those same landmarks. Voice moments are dispatched as the intents
 * the speech grammar would produce, and the spoken phrase is captioned.
 *
 * Time is stepped with Playwright's fake clock, so frames are evenly spaced no
 * matter how long a screenshot takes. Frames are captured at 2x device pixels
 * so text stays sharp after the GIF's 2:1 downscale.
 *
 *   npm run dev            (in another terminal)
 *   node scripts/gesture-gifs.ts [clip ...]
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { synthHand, toRaw, type SynthOpts } from '../src/input/synthHand.ts';
import { parseIntent, stripWake } from '../src/voice/intents.ts';

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test') as typeof import('@playwright/test');
const { PNG } = require('pngjs') as typeof import('pngjs');
const { GIFEncoder, quantize, applyPalette } = require('gifenc') as {
  GIFEncoder: () => {
    writeFrame(index: Uint8Array, w: number, h: number, o: { palette: number[][]; delay: number; first?: boolean }): void;
    finish(): void;
    bytes(): Uint8Array;
  };
  quantize: (rgba: Uint8Array, n: number, o?: { format?: string }) => number[][];
  applyPalette: (rgba: Uint8Array, palette: number[][], format?: string) => Uint8Array;
};

// ?tutorial=0 skips the first-visit practice tutorial and opens the liver case.
const URL_APP = process.env.SCRUB_URL ?? 'http://localhost:5173/?tutorial=0';
const ASPECT = 4 / 3;
const REC_FPS = 30;
/** GIF frame rate; every other recording frame. */
const GIF_FPS = 15;
/** Viewport in CSS pixels; captured at DPR 2. */
const W = 960;
const H = 600;
const DPR = 2;

/** Page globals this script touches: the app's window.scrub and glove.js's card. */
interface GifCard {
  text(title: string, sub: string): void;
  voiceOnly(): void;
  frame(...bounds: number[]): void;
  draw(hands: unknown): void;
  say(text: string): void;
}
type PageWindow = Window & {
  scrub?: { state?: { phase?: string }; dispatch(intent: unknown, source: string): void };
  __gifcard?: GifCard;
};

type Side = 'left' | 'right';
type Hand = { side: Side; o: SynthOpts };
type Ext = [boolean, boolean, boolean, boolean];

interface Clip {
  name: string;
  title: string;
  sub: string;
  /** 'moment3': start from the wedge cut tests/optimize.test.ts uses. */
  start?: 'moment3';
  /** Case to load before the clip starts. */
  caseId?: 'liver' | 'aorta';
  seconds: number;
  hands: (t: number) => Hand[];
  /** Intents to dispatch at a time (s), with the phrase to caption. */
  /** Phrases said at a time (s). Each goes through the app's own wake word
   * and speech grammar, so the clip shows exactly what that sentence does. */
  voice?: { at: number; say: string }[];
}

const ease = (x: number) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, x)));
const span = (t: number, a: number, b: number) => ease((t - a) / (b - a));
const CURLED: Ext = [false, false, false, false];
const POINT: Ext = [true, false, false, false];

/* -------------------------------------------------------------------- clips */

const CLIPS: Clip[] = [
  {
    name: 'cut',
    title: 'Open hand',
    sub: 'Cut. Tilt your palm and the plane tilts.',
    seconds: 6,
    hands: (t) => {
      if (t < 0.4) return [];
      const k = span(t, 1.4, 3.6);
      const back = span(t, 4.2, 5.6);
      const tilt = 0.5 * k - 0.5 * back;
      return [
        {
          side: 'right',
          o: {
            center: [0.78 - 0.16 * k + 0.06 * back, 0.5],
            size: 0.17,
            facing: [Math.sin(tilt), 0.1 * k, Math.cos(tilt)],
          },
        },
      ];
    },
  },
  {
    name: 'rotate',
    title: 'Pinch and drag',
    sub: 'Grab the body and turn it.',
    seconds: 5,
    hands: (t) => {
      if (t < 0.4) return [];
      const x = 0.67 + 0.24 * Math.sin(span(t, 0.9, 4.4) * Math.PI * 2);
      return [{ side: 'right', o: { center: [x, 0.55], size: 0.16, ext: CURLED, pinch: true } }];
    },
  },
  {
    name: 'measure',
    title: 'Two index fingers',
    sub: 'A caliper, in millimetres, on the cut face.',
    seconds: 5,
    hands: (t) => {
      if (t < 0.4) return [];
      const gap = 0.13 + 0.08 * span(t, 1.2, 3.6);
      return [
        { side: 'left', o: { center: [0.66 - gap, 0.5], size: 0.15, ext: POINT } },
        { side: 'right', o: { center: [0.66 + gap, 0.5], size: 0.15, ext: POINT } },
      ];
    },
  },
  {
    name: 'lock',
    title: 'Fist',
    sub: 'Lock the cut. The resected piece lifts away.',
    seconds: 6,
    hands: (t) => {
      if (t < 0.4) return [];
      const center: [number, number] = [0.7, 0.5];
      if (t < 2.2) return [{ side: 'right', o: { center, size: 0.17 } }];
      const c = span(t, 2.2, 2.7);
      return [{ side: 'right', o: { center, size: 0.17, curl: [c, c, c, c] } }];
    },
  },
  {
    name: 'zoom',
    title: 'Two pinches',
    sub: 'Pull apart to zoom in.',
    seconds: 5,
    hands: (t) => {
      if (t < 0.4) return [];
      const gap = 0.1 + 0.16 * span(t, 1.2, 3.8);
      return [
        { side: 'left', o: { center: [0.66 - gap, 0.5], size: 0.15, ext: CURLED, pinch: true } },
        { side: 'right', o: { center: [0.66 + gap, 0.5], size: 0.15, ext: CURLED, pinch: true } },
      ];
    },
  },
  {
    name: 'optimize',
    title: 'Voice: optimize',
    sub: 'A cut 6 mm from the tumour, across a vessel, re-seats itself.',
    start: 'moment3',
    seconds: 6,
    hands: () => [],
    voice: [{ at: 1.2, say: 'scrub, optimize' }],
  },
  {
    name: 'stent',
    title: 'Voice: place, then move',
    sub: 'The graft seats and says whether it seals. Too high and it covers the renal arteries.',
    caseId: 'aorta',
    seconds: 8,
    hands: () => [],
    voice: [
      { at: 0.6, say: 'scrub, place the stent' },
      { at: 3.4, say: 'scrub, move the stent up' },
      { at: 4.2, say: 'scrub, move the stent up' },
      { at: 5.0, say: 'scrub, move the stent up' },
    ],
  },
  {
    name: 'relation',
    title: 'Voice: show me',
    sub: 'Both structures found, the closest gap measured and framed side-on.',
    seconds: 6,
    hands: () => [],
    voice: [{ at: 0.6, say: 'scrub, show me the tumor relative to the portal vein' }],
  },
  {
    name: 'nearest',
    title: 'Voice: nearest vessel',
    sub: 'Every segmented vessel searched at once; the closest one shown.',
    seconds: 6,
    hands: () => [],
    voice: [{ at: 0.6, say: 'scrub, show me where the tumor is closest to a major vessel' }],
  },
  {
    name: 'compare',
    title: 'Voice: save, change, compare',
    sub: 'The saved plan and the new cut, side by side, through the same engine.',
    start: 'moment3',
    seconds: 9,
    hands: () => [],
    voice: [
      { at: 0.5, say: 'scrub, save this plan' },
      { at: 2.2, say: 'scrub, optimize' },
      { at: 5.0, say: 'scrub, compare this cut to the original plan' },
    ],
  },
  {
    name: 'measure-tumor',
    title: 'Voice: measure',
    sub: 'The measurement a radiologist would report, with its normal range.',
    seconds: 5,
    hands: () => [],
    voice: [{ at: 0.6, say: 'scrub, measure the tumor' }],
  },
  {
    name: 'outcomes',
    title: 'Voice: outcomes',
    sub: 'Published rates for the band this plan falls in, with the study.',
    start: 'moment3',
    seconds: 6,
    hands: () => [],
    voice: [{ at: 0.6, say: 'scrub, what are the outcomes' }],
  },
];

/* --------------------------------------------------------------- recording */

/**
 * synthHand builds one chirality only: palm to the camera with the thumb on
 * screen left, which in the mirrored view is a right hand. A left hand is that
 * hand mirrored about its own vertical axis. The app's gesture rules are
 * chirality-blind, so this changes how the hand looks, not what it does.
 */
function handed(h: Hand) {
  const pts = synthHand(h.o);
  if (h.side === 'right') return pts;
  const cx = h.o.center[0];
  return pts.map(([x, y, z]) => [2 * cx - x, y, z] as typeof pts[number]);
}

function recording(c: Clip) {
  const frames: { t: number; hands: { side: Side; lm: number[] }[] }[] = [];
  const n = Math.round(c.seconds * REC_FPS);
  for (let i = 0; i < n; i++) {
    const t = i / REC_FPS;
    frames.push({
      t: Math.round(t * 1000),
      hands: c.hands(t).map((h) => ({ side: h.side, lm: toRaw(handed(h), ASPECT) })),
    });
  }
  return { aspect: ASPECT, frames };
}

// Runs in the page. The Moment 3 starting cut, built exactly as in
// tests/optimize.test.ts: aimed from the liver centroid at the tumour, tilted
// by 0.25 in x, and placed 6 mm in front of the nearest tumour voxel.
const MOMENT3 = `
(() => {
  const s = window.scrub.state;
  const { meta, labels } = s.data;
  const [nx, ny, nz] = meta.shape, [sx, sy, sz] = meta.spacing, o = meta.origin;
  const id = (role) => meta.labels.find((l) => l.role === role).id;
  const organ = id('organ'), tumor = id('tumor');
  const co = [0, 0, 0, 0], ct = [0, 0, 0, 0];
  const pts = [];
  for (let k = 0, i = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let x = 0; x < nx; x++, i++) {
    const l = labels[i];
    if (l !== organ && l !== tumor) continue;
    const p = [o[0] + x * sx, o[1] + j * sy, o[2] + k * sz];
    // Tumour counts as organ, as in the planning grid.
    co[0] += p[0]; co[1] += p[1]; co[2] += p[2]; co[3]++;
    if (l === tumor) { ct[0] += p[0]; ct[1] += p[1]; ct[2] += p[2]; ct[3]++; pts.push(p); }
  }
  const norm = (v) => { const L = Math.hypot(...v); return v.map((x) => x / L); };
  const toward = norm([0, 1, 2].map((a) => ct[a] / ct[3] - co[a] / co[3]));
  const n = norm([toward[0] - 0.25, toward[1], toward[2]]);
  let tmin = Infinity;
  for (const p of pts) tmin = Math.min(tmin, n[0] * p[0] + n[1] * p[1] + n[2] * p[2]);
  Object.assign(s.plane, { on: true, n, d: tmin - 6 });
})();
`;

/* ------------------------------------------------------------------ capture */

/** 2:1 box downscale of a DPR-2 frame to the CSS-pixel size. */
function half(src: Uint8Array): Uint8Array {
  const sw = W * DPR;
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      const a = (2 * y * sw + 2 * x) * 4;
      const b = a + sw * 4;
      for (let c = 0; c < 4; c++) out[o + c] = (src[a + c] + src[a + 4 + c] + src[b + c] + src[b + 4 + c] + 2) >> 2;
    }
  }
  return out;
}

/** GitHub refuses images over 10 MB in a README. */
const GIF_LIMIT = 9.5e6;

/**
 * GIF with a palette per frame: the UI text and the render both keep their
 * colours. A clip that would pass GIF_LIMIT is written at half the frame rate.
 */
function encodeGif(frames: Buffer[], out: string, every = 1): number {
  const enc = GIFEncoder();
  const delay = Math.round((1000 / GIF_FPS) * every);
  frames.filter((_, i) => i % every === 0).forEach((f, i) => {
    const rgba = half(PNG.sync.read(f).data as unknown as Uint8Array);
    const palette = quantize(rgba, 256);
    enc.writeFrame(applyPalette(rgba, palette), W, H, { palette, delay, first: i === 0 });
  });
  enc.finish();
  const bytes = enc.bytes();
  if (bytes.length > GIF_LIMIT && every === 1) return encodeGif(frames, out, 2);
  writeFileSync(out, bytes);
  return bytes.length;
}

/**
 * Playwright ships a cut-down ffmpeg: no pipe protocol and no PNG decoder, but
 * it reads a file of concatenated JPEGs (what its own recorder feeds it) and
 * writes VP9.
 */
function ffmpegPath(): string | null {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(process.env.LOCALAPPDATA ?? join(homedir(), '.cache'), 'ms-playwright');
  if (!existsSync(root)) return null;
  for (const d of readdirSync(root).filter((n) => n.startsWith('ffmpeg'))) {
    for (const exe of ['ffmpeg-win64.exe', 'ffmpeg-linux', 'ffmpeg-mac']) {
      const p = join(root, d, exe);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

function encodeWebm(jpegs: Buffer[], out: string): number | null {
  const ff = ffmpegPath();
  if (!ff) return null;
  const tmp = `${out}.frames.mjpeg`;
  writeFileSync(tmp, Buffer.concat(jpegs));
  const r = spawnSync(
    ff,
    ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(GIF_FPS), '-i', tmp,
      '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-crf', '30', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', out],
    { maxBuffer: 1 << 26 },
  );
  rmSync(tmp, { force: true });
  if (r.status !== 0) {
    console.warn(`[webm] ffmpeg failed: ${r.stderr?.toString()}`);
    return null;
  }
  return readFileSync(out).length;
}

async function capture(clip: Clip): Promise<void> {
  const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'] });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
  page.on('pageerror', (e) => console.warn(`[${clip.name}] pageerror ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && console.warn(`[${clip.name}] console ${m.text()}`));
  const rec = recording(clip);
  await page.route('**/demo/landmarks.json', (r) => r.fulfill({ json: rec }));
  // The glove overlay, its model, and the three.js it imports, from this repo.
  const subpath = (url: string, prefix: string) => decodeURIComponent(new URL(url).pathname.split(prefix)[1]);
  await page.route('**/__gif/glove.js', (r) => r.fulfill({ path: 'scripts/gifkit/glove.js', contentType: 'text/javascript' }));
  await page.route('**/__gif/model/**', (r) => r.fulfill({ path: join('scripts/gifkit/glove-model', subpath(r.request().url(), '/__gif/model/')) }));
  await page.route('**/__gif/three/**', (r) => {
    // three's addons import the bare specifier 'three'; point it at the one
    // build the overlay already loaded, so there is a single THREE instance.
    const src = readFileSync(join('node_modules/three', subpath(r.request().url(), '/__gif/three/')), 'utf8');
    const body = src.replace(/from\s+['"]three['"]/g, "from '/__gif/three/build/three.module.js'");
    return r.fulfill({ body, contentType: 'text/javascript' });
  });

  await page.clock.install();
  await page.goto(URL_APP, { waitUntil: 'load' });
  await page.waitForFunction(() => (window as unknown as PageWindow).scrub?.state?.phase === 'ready', null, { timeout: 60_000 });
  if (clip.caseId && clip.caseId !== 'liver') {
    await page.evaluate((id) => (window as unknown as PageWindow).scrub!.dispatch({ kind: 'loadCase', id }, 'key'), clip.caseId);
    await page.waitForTimeout(2500);
  }
  if (clip.start === 'moment3') await page.evaluate(MOMENT3);
  await page.addScriptTag({ type: 'module', url: '/__gif/glove.js' });
  // Polled from Node: the page's own timers are under the fake clock, and the
  // overlay finishes only once the glove model has loaded and been rigged.
  for (let t = 0; !(await page.evaluate(() => !!(window as unknown as PageWindow).__gifcard)); t += 250) {
    if (t > 30_000) throw new Error('glove overlay did not load');
    await new Promise((r) => setTimeout(r, 250));
  }
  await page.evaluate(([t, s]) => (window as unknown as PageWindow).__gifcard!.text(t, s), [clip.title, clip.sub]);
  if (rec.frames.every((f) => f.hands.length === 0)) await page.evaluate(() => (window as unknown as PageWindow).__gifcard!.voiceOnly());
  else {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const f of rec.frames) {
      for (const h of f.hands) {
        for (let i = 0; i < 21; i++) {
          xs.push(h.lm[i * 3]);
          ys.push(h.lm[i * 3 + 1]);
        }
      }
    }
    const b = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    await page.evaluate((b) => (window as unknown as PageWindow).__gifcard!.frame(...b), b);
  }
  // Let toasts and intro banners settle before time is frozen.
  await page.waitForTimeout(1500);
  await page.keyboard.press('Escape');

  await page.clock.pauseAt(Date.now() + 2000);
  await page.keyboard.press('d');
  await page.clock.runFor(100);

  const frames: Buffer[] = [];
  const jpegs: Buffer[] = [];
  const step = 1000 / GIF_FPS;
  const n = Math.round(clip.seconds * GIF_FPS);
  const voice = [...(clip.voice ?? [])];
  let saying = '';
  for (let i = 0; i < n; i++) {
    const t = i / GIF_FPS;
    while (voice.length && voice[0].at <= t) {
      const v = voice.shift()!;
      saying = v.say;
      const text = stripWake(v.say);
      const intent = text === null ? null : parseIntent(text);
      if (!intent) throw new Error(`grammar does not understand "${v.say}"`);
      await page.evaluate((i) => (window as unknown as PageWindow).scrub!.dispatch(i, 'voice'), intent);
    }
    const recFrame = rec.frames[Math.min(rec.frames.length - 1, Math.round(t * REC_FPS))];
    await page.evaluate(
      ([hands, say]) => {
        (window as unknown as PageWindow).__gifcard!.draw(hands);
        (window as unknown as PageWindow).__gifcard!.say(say);
      },
      [recFrame.hands, saying] as const,
    );
    await page.clock.runFor(step);
    frames.push(await page.screenshot({ timeout: 90_000 }));
    jpegs.push(await page.screenshot({ type: 'jpeg', quality: 95, timeout: 90_000 }));
  }
  await browser.close();

  // FRAMES=dir dumps one PNG per second, for checking a clip by eye.
  const dump = process.env.FRAMES;
  if (dump) {
    mkdirSync(dump, { recursive: true });
    frames.forEach((f, i) => i % GIF_FPS === 0 && writeFileSync(`${dump}/${clip.name}-${i / GIF_FPS}s.png`, f));
  }

  mkdirSync('docs/gifs', { recursive: true });
  mkdirSync('docs/video', { recursive: true });
  const gifBytes = encodeGif(frames, `docs/gifs/${clip.name}.gif`);
  const webmBytes = encodeWebm(jpegs, `docs/video/${clip.name}.webm`);
  const mb = (n: number | null) => (n === null ? 'skipped' : `${(n / 1e6).toFixed(2)} MB`);
  console.log(`[clip] ${clip.name}  ${frames.length} frames  gif ${mb(gifBytes)}  webm ${mb(webmBytes)}`);
}

const wanted = process.argv.slice(2);
for (const clip of CLIPS) {
  if (wanted.length && !wanted.includes(clip.name)) continue;
  // The dev server occasionally full-reloads the page mid-clip (the first
  // time a lazily loaded code path pulls in a dependency it re-bundles and
  // reloads every client), which drops the overlay. Pause and start over.
  for (let attempt = 1; ; attempt++) {
    try {
      await capture(clip);
      break;
    } catch (err) {
      if (attempt >= 4) throw err;
      console.warn(`[clip] ${clip.name} failed (${(err as Error).message.split('\n')[0]}), retrying`);
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
}
