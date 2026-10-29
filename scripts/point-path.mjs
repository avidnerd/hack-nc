/**
 * "What's this?" on the vista3d-point endpoint, as a judge does it with the
 * mouse: alt-click the centre of the screen (a structure the case labels), then a point in
 * unlabelled tissue beside it (voxel 170,230,60 of the liver case), which
 * VISTA-3D adds as a new teal structure.
 *
 *   node scripts/point-path.mjs [appUrl]      (default: the dev server)
 *
 * Writes metrics/point_path.json with each reply and its timings.
 */

import { writeFileSync } from 'node:fs';

import { chromium } from '@playwright/test';

const base = process.argv[2] ?? 'http://localhost:5173/';
const browser = await chromium.launch({ headless: process.env.JUDGE_HEADED !== '1', args: ['--ignore-gpu-blocklist'] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !/GL Driver|GPU stall/.test(m.text())) problems.push(`console: ${m.text().slice(0, 200)}`);
});

const steps = [];
async function step(label, act, want) {
  const before = await page.evaluate(() => window.scrub.state.response);
  const t = Date.now();
  await act();
  await page.waitForFunction(([b, re]) => window.scrub.state.response !== b && new RegExp(re, 'i').test(window.scrub.state.response), [before, want.source], { timeout: 120_000 });
  const reply = await page.evaluate(() => window.scrub.state.response);
  steps.push({ label, reply, ms: Date.now() - t });
  console.log(`${String(Date.now() - t).padStart(6)} ms  ${label}  ->  ${reply}`);
}

try {
  await page.goto(base);
  await page.getByRole('button', { name: /^Skip/ }).click({ timeout: 30_000 });
  await page.waitForFunction(() => window.scrub?.state?.data?.meta?.id === 'liver', null, { timeout: 60_000 });
  if (process.env.JUDGE_HEADED !== '1') await page.evaluate(() => (window.scrub.renderer.stepsOverride = 16));
  // The health probe runs at boot; give it a moment.
  await page.waitForTimeout(1500);

  // Alt-click the middle of the screen: whatever labelled structure is under it.
  await step('alt-click the centre of the screen', async () => {
    await page.keyboard.down('Alt');
    await page.mouse.click(720, 450);
    await page.keyboard.up('Alt');
  }, /liver|VISTA-3D|segment/);

  await step('what is this at voxel 170,230,60', () => page.evaluate(() => {
    const m = window.scrub.state.data.meta;
    const v = [170, 230, 60];
    return window.scrub.whatsThis(v.map((x, a) => m.origin[a] + x * m.spacing[a]));
  }), /VISTA-3D|segment/);
  const added = await page.evaluate(() => window.scrub.state.data.meta.labels.filter((l) => l.key.startsWith('vista_')).map((l) => l.name));
  steps.push({ label: 'new structures', reply: added.join(', ') });
  console.log(`          new structures: ${added.join(', ')}`);
} catch (e) {
  problems.push(`step failed: ${e.message.split('\n')[0]}`);
}

await page.screenshot({ path: 'test-results/point-path.png' });
await browser.close();
writeFileSync('metrics/point_path.json', JSON.stringify({ base, at: new Date().toISOString(), steps, problems }, null, 2) + '\n');
if (problems.length) {
  console.log(problems.join('\n'));
  process.exit(1);
}
console.log('point path passed');
