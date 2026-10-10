/**
 * Dev probe: boots the app headless, runs a JS snippet against `window.scrub`
 * at given times, prints the results and console output. Used to check
 * behaviour that has no pixels to screenshot (gestures, numbers, voice).
 *
 *   node scripts/probe.mjs "<setup js>" "<sample js>" [samples] [intervalMs]
 */

import { chromium } from '@playwright/test';

const [, , setup = '', sample = 'window.scrub.state.hands.pose', n = '10', every = '500'] = process.argv;
const url = process.env.PROBE_URL ?? 'http://localhost:5173/?hands=off';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: Number(process.env.PROBE_W ?? 1280), height: Number(process.env.PROBE_H ?? 800) } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.scrub?.state?.phase === 'ready', { timeout: 60000 });
// Software WebGL is slow; pin the step count so the loop keeps up.
await page.evaluate(() => (window.scrub.renderer.stepsOverride = Number(new URLSearchParams(location.search).get('steps') ?? 48)));
if (setup) await page.evaluate(setup);
for (let i = 0; i < Number(n); i++) {
  await page.waitForTimeout(Number(every));
  const v = await page.evaluate(sample);
  console.log(`${String(i).padStart(3)}  ${typeof v === 'string' ? v : JSON.stringify(v)}`);
}
console.log('--- console ---');
for (const l of logs) console.log(l);
await browser.close();
