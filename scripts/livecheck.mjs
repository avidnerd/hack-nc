/**
 * Live check on this machine's real GPU: opens a visible Chromium window with
 * a fake camera (so camera permission, MediaPipe loading and per-frame hand
 * detection all run for real), measures frame rate and detection cost, then
 * replays the recorded gesture stream and samples how the app responds.
 *
 *   node scripts/livecheck.mjs [outDir]
 */

import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const out = process.argv[2] ?? 'docs/shots';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  headless: false,
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
  ],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['camera', 'microphone'] });
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

const t0 = Date.now();
await page.goto('http://localhost:5173/?voice=off', { waitUntil: 'load' });
await page.waitForFunction(() => window.scrub?.state?.phase === 'ready', { timeout: 60000 });
const bootMs = Date.now() - t0;
await page.waitForFunction(() => window.scrub.state.inputMode === 'hands', { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(2500);

const fps = (ms) =>
  page.evaluate(
    (ms) =>
      new Promise((res) => {
        let n = 0;
        const t = performance.now();
        const f = () => {
          n++;
          if (performance.now() - t < ms) requestAnimationFrame(f);
          else res(+(n / (ms / 1000)).toFixed(1));
        };
        requestAnimationFrame(f);
      }),
    ms,
  );

const env = await page.evaluate(() => {
  const g = window.scrub.renderer.renderer.getContext();
  const e = g.getExtension('WEBGL_debug_renderer_info');
  const v = document.getElementById('cam');
  return {
    gpu: e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : '?',
    inputMode: window.scrub.state.inputMode,
    video: [v.videoWidth, v.videoHeight, v.readyState],
  };
});
const idleFps = await fps(3000);
await page.screenshot({ path: `${out}/live-idle.png` });

// Replay the gesture stream through the full pipeline (camera stays on).
await page.keyboard.press('Shift');
await page.keyboard.press('d');
const samples = [];
const fpsDuring = fps(15000);
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(500);
  samples.push(
    await page.evaluate(() => {
      const s = window.scrub.state;
      return [
        s.hands.pose,
        s.camera.yaw.toFixed(2),
        s.camera.dist.toFixed(2),
        s.plane.on ? 'cut' : '-',
        s.plane.locked ? 'locked' : '',
        s.metrics ? `R${s.metrics.remnantPct.toFixed(0)} M${s.metrics.marginMm.toFixed(1)} V${s.metrics.vesselsCrossed}` : '',
        s.caliper.mm ? `${s.caliper.mm.toFixed(0)}mm` : '',
        s.cursor ? 'cursor' : '',
      ].join(' ');
    }),
  );
  if (i === 9) await page.screenshot({ path: `${out}/live-cut.png` });
  if (i === 12) await page.screenshot({ path: `${out}/live-lift.png` });
}
const activeFps = await fpsDuring;

// Moment 3 via the keyboard while the camera keeps running.
await page.keyboard.press('o');
await page.waitForTimeout(2500);
const optimize = await page.evaluate(() => [window.scrub.state.perf.optimizeMs, window.scrub.state.response]);
await page.screenshot({ path: `${out}/live-optimized.png` });

const detect = await page.evaluate(() => window.__detectMs ?? null);
console.log(JSON.stringify({ bootMs, ...env, idleFps, activeFps, optimize, detect }, null, 1));
console.log('--- samples (pose yaw dist cut lock metrics caliper cursor) ---');
samples.forEach((s, i) => console.log(String(i).padStart(2), s));
console.log('--- console ---');
for (const l of logs.filter((l) => !/vite|\[debug\]/.test(l))) console.log(l);
await browser.close();
