/**
 * Measures render frame time on the real GPU (headed Chromium) for each case,
 * plane off and plane on, at a laptop-sized window. Writes metrics/frametime.json.
 *
 *   npm run dev            (in another terminal)
 *   node scripts/frametime.mjs
 *
 * frameMs is the renderer's own moving average (src/render/volumeRenderer.ts);
 * fps is counted from requestAnimationFrame over the same window.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const SAMPLE_MS = 4000;
const browser = await chromium.launch({ headless: false, args: ['--ignore-gpu-blocklist'] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();

async function sample() {
  return page.evaluate(async (ms) => {
    const frames = [];
    let last = performance.now();
    const end = last + ms;
    await new Promise((done) => {
      const tick = (t) => {
        frames.push(t - last);
        last = t;
        if (t < end) requestAnimationFrame(tick);
        else done();
      };
      requestAnimationFrame(tick);
    });
    frames.sort((a, b) => a - b);
    const p = (q) => frames[Math.min(frames.length - 1, Math.floor(q * frames.length))];
    return {
      rendererFrameMs: window.scrub.state.perf.frameMs,
      steps: window.scrub.state.perf.steps,
      fps: Math.round((frames.length / ms) * 1000),
      rafMedianMs: +p(0.5).toFixed(1),
      rafP95Ms: +p(0.95).toFixed(1),
    };
  }, SAMPLE_MS);
}

const out = { measuredAt: new Date().toISOString(), viewport: '1440x900', userAgent: '', cases: {} };
for (const id of ['liver', 'aorta']) {
  await page.goto(`http://localhost:5173/?hands=off&voice=off&tutorial=0&case=${id}`);
  await page.waitForFunction(() => window.scrub?.state?.phase === 'ready', null, { timeout: 60000 });
  out.userAgent = await page.evaluate(() => navigator.userAgent);
  await page.waitForTimeout(1500);
  const off = await sample();
  await page.keyboard.press('x');
  await page.waitForTimeout(800);
  const on = await sample();
  out.cases[id] = { planeOff: off, planeOn: on };
  console.log(id, JSON.stringify(out.cases[id]));
}
await browser.close();
mkdirSync('metrics', { recursive: true });
writeFileSync('metrics/frametime.json', JSON.stringify(out, null, 2) + '\n');
