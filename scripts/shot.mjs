/**
 * Development screenshot harness.
 *
 * Loads the app in headless Chromium, waits for the first case to reach the
 * GPU, optionally drives it through some state, and writes a PNG. Also relays
 * every console message and page error, which is how GLSL compile failures
 * become visible from a terminal.
 *
 *   node scripts/shot.mjs out.png                      plain boot shot
 *   node scripts/shot.mjs out.png --preset bone         after a window change
 *   node scripts/shot.mjs out.png --plane 1,0,0,-20     with a cutting plane
 *   node scripts/shot.mjs out.png --eval "yaw=1.2"      arbitrary state poke
 */

import { chromium } from '@playwright/test';

const [, , outPath = 'shot.png', ...rest] = process.argv;

function flag(name, fallback = null) {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] ? rest[i + 1] : fallback;
}

const url = flag('url', 'http://localhost:5173/');
const waitMs = Number(flag('wait', '2600'));
const width = Number(flag('w', '1280'));
const height = Number(flag('h', '800'));

const browser = await chromium.launch({
  args: [
    // Headless Chromium has no real GPU, so force SwiftShader's software
    // WebGL2. Slow, but it compiles and runs the same GLSL the demo machine
    // will, which is the point.
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
  ],
});

const page = await browser.newPage({ viewport: { width, height } });

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('requestfailed', (r) =>
  logs.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText ?? ''}`),
);

await page.goto(url, { waitUntil: 'load', timeout: 60000 });

// Wait until main.ts has published its handle and the case is loaded.
await page
  .waitForFunction(() => window.scrub?.state?.phase === 'ready', { timeout: 60000 })
  .catch(() => logs.push('[harness] phase never became "ready"'));

const preset = flag('preset');
if (preset) {
  await page.evaluate((p) => window.scrub.dispatch({ kind: 'window', preset: p }, 'key'), preset);
}

const plane = flag('plane');
if (plane) {
  const [nx, ny, nz, d] = plane.split(',').map(Number);
  await page.evaluate(
    ([nx, ny, nz, d]) => {
      const s = window.scrub.state;
      s.plane.n = [nx, ny, nz];
      s.plane.d = d;
      s.plane.on = true;
    },
    [nx, ny, nz, d],
  );
}

const camera = flag('camera');
if (camera) {
  const [yaw, pitch, dist] = camera.split(',').map(Number);
  await page.evaluate(
    ([yaw, pitch, dist]) => {
      Object.assign(window.scrub.state.camera, { yaw, pitch, dist });
    },
    [yaw, pitch, dist],
  );
}

// Software rendering cannot afford the real step count: SwiftShader takes
// many seconds per frame at 256 steps, which outruns the screenshot timeout.
// Pinning a low count still exercises the whole shader, just noisier.
const steps = Number(flag('steps', '64'));
await page.evaluate((n) => {
  window.scrub.renderer.stepsOverride = n;
}, steps);

const evalStr = flag('eval');
if (evalStr) await page.evaluate((s) => eval(s), evalStr);

// Let the ray-marcher settle: software rendering needs several frames, and the
// window/level tween runs for 300 ms.
await page.waitForTimeout(waitMs);

const info = await page.evaluate(() => {
  const s = window.scrub?.state;
  const gl = document.querySelector('canvas')?.getContext('webgl2');
  return {
    phase: s?.phase,
    error: s?.error,
    caseName: s?.data?.meta?.name ?? null,
    shape: s?.data?.meta?.shape ?? null,
    preset: s?.preset,
    wl: s?.windowLevel,
    planeOn: s?.plane?.on,
    perf: s?.perf,
    webgl2: !!gl,
    renderer: gl
      ? gl.getExtension('WEBGL_debug_renderer_info')
        ? gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL)
        : 'unknown'
      : 'none',
  };
});

await page.screenshot({ path: outPath });
await browser.close();

console.log(JSON.stringify(info, null, 1));
const interesting = logs.filter(
  (l) =>
    !/\[(debug|verbose)\]/.test(l) &&
    !/vite|hmr/i.test(l) &&
    // One failed shader produces a draw-call warning every frame; the useful
    // message is the compile log underneath them.
    !/no valid shader program in use/.test(l),
);
if (interesting.length) {
  console.log('\n--- page console ---');
  for (const l of interesting.slice(0, 60)) console.log(l);
}
console.log(`\nwrote ${outPath}`);
