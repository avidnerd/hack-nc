/**
 * The judge path from CLAUDE.md section 8, cold, with no camera and no
 * microphone, using only the mouse and the command palette:
 * gallery case -> optimize -> resect -> stent -> Tavily rule card -> plan.
 *
 *   node scripts/judge-path.mjs [baseUrl]
 *
 * Prints each step's reply and the total time; writes metrics/judge_path.json.
 * Fails on any console error, page error or failed request.
 */

import { writeFileSync } from 'node:fs';

import { chromium } from '@playwright/test';

const base = (process.argv[2] ?? 'https://scrubplus.vercel.app').replace(/\/$/, '');
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist'] });
// No camera or microphone permission: getUserMedia is denied, as on a judge's locked-down laptop.
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !/GL Driver|GPU stall/.test(m.text())) problems.push(`console: ${m.text().slice(0, 200)}`);
});
page.on('response', (r) => {
  if (r.status() >= 400) problems.push(`${r.status()} ${r.url()}`);
});

const steps = [];
const t0 = Date.now();
const response = () => page.evaluate(() => window.scrub.state.response);

async function type(text, want, timeout = 45_000) {
  const before = await response();
  const t = Date.now();
  const tp = Date.now();
  await page.keyboard.press('/');
  await page.locator('.palette-input').fill(text);
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    ([b, re]) => window.scrub.state.response !== b && new RegExp(re, 'i').test(window.scrub.state.response),
    [before, want.source],
    { timeout },
  );
  const rounds = await page.evaluate((x) => window.scrub.agentLog().filter((e) => e.text === x)
    .map(({ at, round, model, latency_ms, tools, grounded, escalated, error }) => ({ at, round, model, latency_ms, tools, grounded, escalated, error })), text);
  const r = await response();
  steps.push({ text, reply: r, ms: Date.now() - t, rounds });
  console.log(`${String(Date.now() - t).padStart(6)} ms  ${text}  ->  ${r}`);
  for (const x of rounds) console.log(`          +${Math.round(x.at - tp)} ms round ${x.round} ${x.model} ${x.latency_ms} ms [${x.tools.join(',')}]${x.escalated ? ' escalated' : ''}${x.error ? ` ${x.error}` : ''}`);
  await page.keyboard.press('Escape').catch(() => {});
}

try {
  await page.goto(`${base}/app/`);
  await page.getByRole('button', { name: /^Skip/ }).click({ timeout: 30_000 });
  await page.waitForFunction(() => window.scrub?.state?.data?.meta?.id === 'liver', null, { timeout: 60_000 });

  await page.getByRole('button', { name: 'Gallery' }).click();
  await page.locator('.gallery-case').first().click({ timeout: 30_000 });
  await page.waitForFunction(() => window.scrub.state.data.meta.id !== 'liver' && /Opened|loaded|case/i.test(window.scrub.state.response ?? ''), null, { timeout: 60_000 })
    .catch(() => {});
  const gid = await page.evaluate(() => window.scrub.state.data.meta.id);
  steps.push({ text: 'gallery', reply: gid, ms: Date.now() - t0 });
  console.log(`gallery case ${gid}`);

  await type('optimize the cut with a 10 mm margin', /optimi|FLR|margin/);
  await type('resect', /resect|milliliters|mL/);
  {
    const t = Date.now();
    await page.keyboard.press('/');
    await page.locator('.palette-input').fill('open the aorta case');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.scrub.state.data?.meta?.id === 'aorta', null, { timeout: 60_000 });
    steps.push({ text: 'open the aorta case', reply: 'aorta', ms: Date.now() - t });
    console.log(`${String(Date.now() - t).padStart(6)} ms  open the aorta case (grammar)`);
    await page.keyboard.press('Escape').catch(() => {});
  }
  await type('size a stent for a Gore Excluder', /neck|seal|excluder|millimeters/);
  const card = await page.locator('.info-card.show').innerText({ timeout: 10_000 }).catch(() => '');
  const links = await page.locator('.info-card.show a.info-link').evaluateAll((as) => as.map((a) => a.href)).catch(() => []);
  steps.push({ text: 'rule card', reply: card.slice(0, 300), links });
  console.log(`rule card: ${card.replace(/\s+/g, ' ').slice(0, 160)} | ${links.length} source link(s)`);
  await type('write the plan', /plan/);
} catch (e) {
  problems.push(`step failed: ${e.message.split('\n')[0]}`);
}

const total = Date.now() - t0;
await page.screenshot({ path: 'test-results/judge-path.png' });
await browser.close();
writeFileSync('metrics/judge_path.json', JSON.stringify({ base, at: new Date().toISOString(), total_ms: total, steps, problems }, null, 2) + '\n');
console.log(`\ntotal ${(total / 1000).toFixed(1)} s`);
if (problems.length) {
  console.log(problems.join('\n'));
  process.exit(1);
}
console.log('judge path passed');
