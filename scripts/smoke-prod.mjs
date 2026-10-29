/**
 * End-to-end check of a deployed build (the Vercel site by default).
 *
 *   node scripts/smoke-prod.mjs [baseUrl]
 *
 * Loads the landing site and the app, boots both cases from the gzipped
 * data, runs copilot commands, the tutorial and a NIfTI upload, calls the agent
 * backend, and fails on any page error, console error or failed request.
 * Exit code 0 only when every check passed.
 */

import { chromium } from '@playwright/test';

import { makeNifti } from '../tests/niftiFixture.ts';

const base = (process.argv[2] ?? 'https://scrubplus.vercel.app').replace(/\/$/, '');
// A fake camera so the real MediaPipe pipeline starts without hardware.
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['camera', 'microphone'] });
const page = await ctx.newPage();

const problems = [];
page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
page.on('console', (m) => {
  // WebGL performance notes from the GPU driver are not app errors.
  if (m.type() === 'error' && !/GL Driver|GPU stall/.test(m.text())) problems.push(`console: ${m.text().slice(0, 200)}`);
});
page.on('response', (r) => {
  if (r.status() >= 400) problems.push(`${r.status()} ${r.url()}`);
});

const results = [];
async function check(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0, detail: detail ?? '' });
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - t0, detail: String(err.message ?? err).split('\n')[0] });
  }
}
const ready = () => page.waitForFunction(() => window.scrub?.state?.phase === 'ready', null, { timeout: 90_000 });
const dispatch = (intent) => page.evaluate((i) => window.scrub.dispatch(i, 'voice'), intent);
const response = () => page.evaluate(() => window.scrub.state.response);
const waitResponse = (re) => page.waitForFunction((src) => new RegExp(src).test(window.scrub.state.response), re.source, { timeout: 20_000 });

await check('landing site', async () => {
  const r = await page.goto(`${base}/`, { waitUntil: 'load' });
  if (!r?.ok()) throw new Error(`status ${r?.status()}`);
  const links = await page.locator('a[href*="/app"]').count();
  if (!links) throw new Error('no link to the app');
  return `${await page.title()}; ${links} link(s) to the app`;
});

await check('app boots the liver case from gzipped data', async () => {
  await page.goto(`${base}/app/?hands=off&voice=off&tutorial=0`);
  await ready();
  const m = await page.evaluate(() => ({ id: window.scrub.state.data.meta.id, shape: window.scrub.state.data.meta.shape, meshes: !!window.scrub.state.data.meshes }));
  if (m.id !== 'liver' || !m.meshes) throw new Error(JSON.stringify(m));
  return `${m.shape.join('×')} voxels, meshes loaded`;
});

await check('camera and hand tracking start', async () => {
  await page.goto(`${base}/app/?voice=off&tutorial=0`);
  await ready();
  await page.waitForFunction(() => window.scrub.state.inputMode === 'hands', null, { timeout: 60_000 });
  return 'MediaPipe hand landmarker running on the camera feed';
});

await check('copilot: tumour relative to portal vein', async () => {
  await dispatch({ kind: 'relation', a: 'tumor', b: 'portal_vein' });
  await waitResponse(/millimeters? from the portal vein/);
  const mm = await page.evaluate(() => window.scrub.state.caliper.mm);
  return `${await response()} (caliper ${mm.toFixed(1)} mm)`;
});

await check('copilot: closest vessel with CT section', async () => {
  await dispatch({ kind: 'nearest', a: 'tumor' });
  await waitResponse(/^Closest vessel/);
  if (!(await page.evaluate(() => window.scrub.state.viewSection))) throw new Error('no section');
  return await response();
});

await check('cut, save, change, compare, restore', async () => {
  await dispatch({ kind: 'cut', orientation: 'sagittal', through: 'tumor', offsetMm: 12 });
  await page.waitForTimeout(900);
  await dispatch({ kind: 'savePlan' });
  await waitResponse(/Saved as the original plan/);
  await page.evaluate(() => (window.scrub.state.plane.d -= 10));
  await page.waitForTimeout(300);
  await dispatch({ kind: 'comparePlan' });
  await waitResponse(/^Compared with the saved plan/);
  const compared = await response();
  await dispatch({ kind: 'restorePlan' });
  await waitResponse(/Original plan restored/);
  return compared;
});

await check('measure, suggest, outcomes', async () => {
  await dispatch({ kind: 'measure', what: 'tumor' });
  await waitResponse(/^Tumor \d+ by \d+/);
  const m = await response();
  await dispatch({ kind: 'outcomes' });
  await page.waitForSelector('.info-card.show');
  return m;
});

await check('agent answers through the hosted backend (Nemotron on Nebius)', async () => {
  const r = await page.evaluate(() => window.scrub.agent('measure the future liver remnant'));
  if (!r || !r.valid || !r.tool_calls.length) throw new Error(JSON.stringify(r).slice(0, 200));
  return `${r.model} ${r.latency_ms} ms ${r.tool_calls.map((c) => c.name).join(',')}${r.escalated ? ' (escalated)' : ''}`;
});

await check('aorta case: stent seals below the renals', async () => {
  await page.goto(`${base}/app/?hands=off&voice=off&case=aorta`);
  await ready();
  await dispatch({ kind: 'placeStent' });
  await waitResponse(/^Placed\. Neck \d+ millimeters\. Seals\./);
  return await response();
});

await check('first-run tutorial opens on the practice object', async () => {
  await page.goto(`${base}/app/?hands=off&voice=off&tutorial=1`);
  await ready();
  await page.waitForSelector('.tut-card', { timeout: 20_000 });
  const id = await page.evaluate(() => window.scrub.state.data.meta.id);
  if (id !== 'practice') throw new Error(id);
  return await page.locator('.tut-title').textContent();
});

await check('upload a NIfTI CT from disk', async () => {
  await page.goto(`${base}/app/?hands=off&voice=off&tutorial=0`);
  await ready();
  const ct = makeNifti({ dims: [40, 40, 30], spacing: [1, 1, 2], value: (i, j, k) => ((i - 20) ** 2 + (j - 20) ** 2 + (k - 15) ** 2 < 144 ? 60 : -1000) });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Upload CT' }).click();
  await (await chooser).setFiles({ name: 'smoke.nii', mimeType: 'application/octet-stream', buffer: Buffer.from(ct) });
  await waitResponse(/^Scan loaded/);
  return await response();
});

await check('service worker registers', async () => {
  const n = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return -1;
    await navigator.serviceWorker.ready;
    return (await navigator.serviceWorker.getRegistrations()).length;
  });
  if (n < 1) throw new Error(`registrations: ${n}`);
  return `${n} registration(s)`;
});

await browser.close();

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name} (${r.ms} ms)  ${r.detail}`);
const unique = [...new Set(problems)];
if (unique.length) {
  console.log(`\n${unique.length} problem(s) seen:`);
  for (const p of unique.slice(0, 20)) console.log('  ' + p);
}
const failed = results.filter((r) => !r.ok).length + unique.length;
console.log(failed ? `\n${failed} issue(s)` : '\nall checks passed');
process.exit(failed ? 1 : 0);
