/**
 * The upload path: a CT with no labels -> "Segment on Nebius" -> the
 * vista3d-full Serverless Job -> the planned case opens -> optimize.
 * Starts one H100 job (about 1 minute of GPU time).
 *
 *   node scripts/upload-path.mjs <ct.nii.gz> [appUrl]   (default: the dev server)
 *
 * Prints each stage as the app shows it, with wall time from the click;
 * writes metrics/upload_path.json. Fails on any console error or page error.
 */

import { writeFileSync } from 'node:fs';

import { chromium } from '@playwright/test';

const ct = process.argv[2];
if (!ct) throw new Error('usage: node scripts/upload-path.mjs <ct.nii.gz> [appUrl]');
const base = process.argv[3] ?? 'http://localhost:5173/';
const browser = await chromium.launch({ headless: process.env.JUDGE_HEADED !== '1', args: ['--ignore-gpu-blocklist'] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !/GL Driver|GPU stall/.test(m.text())) problems.push(`console: ${m.text().slice(0, 200)}`);
});

const stages = [];
let result = {};
try {
  await page.goto(base);
  await page.getByRole('button', { name: /^Skip/ }).click({ timeout: 30_000 });
  await page.waitForFunction(() => window.scrub?.state?.data?.meta?.id === 'liver', null, { timeout: 60_000 });

  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Upload CT' }).click();
  await (await chooser).setFiles(ct);
  const go = page.getByRole('button', { name: 'Segment on Nebius' });
  await go.waitFor({ timeout: 120_000 });
  const t0 = Date.now();
  await go.click();

  let last = '';
  const status = page.locator('.scanjob .palette-status');
  for (;;) {
    const id = await page.evaluate(() => window.scrub.state.data?.meta?.id ?? '');
    if (id.startsWith('upload_')) break;
    const s = (await status.textContent().catch(() => '')) ?? '';
    const stage = s.split(' · ')[0];
    if (stage && stage !== last) {
      stages.push({ stage, at_s: (Date.now() - t0) / 1000, shown: s });
      console.log(`${String(((Date.now() - t0) / 1000).toFixed(1)).padStart(7)} s  ${s}`);
      last = stage;
    }
    if (/failed|refused/i.test(s)) throw new Error(s);
    if (Date.now() - t0 > 20 * 60_000) throw new Error('no READY after 20 min');
    await page.waitForTimeout(1000);
  }
  const ready_s = (Date.now() - t0) / 1000;
  const meta = await page.evaluate(() => ({ id: window.scrub.state.data.meta.id, kind: window.scrub.state.data.meta.kind, labels: window.scrub.state.data.meta.labels.map((l) => l.name) }));
  const reply = await page.waitForFunction(() => /segmented on Nebius/.test(window.scrub.state.response ?? '') && window.scrub.state.response, null, { timeout: 30_000 }).then((h) => h.jsonValue());
  console.log(`${ready_s.toFixed(1).padStart(7)} s  opened ${meta.id} (${meta.kind}): ${meta.labels.join(', ')}`);
  console.log(`          ${reply}`);

  const before = await page.evaluate(() => window.scrub.state.response);
  await page.keyboard.press('/');
  await page.locator('.palette-input').fill('optimize the cut with a 10 mm margin');
  await page.keyboard.press('Enter');
  await page.waitForFunction((b) => window.scrub.state.response !== b && /optimi|FLR|margin/i.test(window.scrub.state.response), before, { timeout: 60_000 });
  const optimize = await page.evaluate(() => window.scrub.state.response);
  console.log(`          optimize -> ${optimize}`);
  result = { ready_s, meta, reply, optimize };
} catch (e) {
  problems.push(`step failed: ${e.message.split('\n')[0]}`);
}

await page.screenshot({ path: 'test-results/upload-path.png' });
await browser.close();
writeFileSync('metrics/upload_path.json', JSON.stringify({ base, ct: ct.split('/').pop(), at: new Date().toISOString(), stages, ...result, problems }, null, 2) + '\n');
if (problems.length) {
  console.log(problems.join('\n'));
  process.exit(1);
}
console.log('upload path passed');
