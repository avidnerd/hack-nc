/**
 * Reproducible technical benchmark of the copilot workflow.
 *
 *   npm run dev            (in another terminal)
 *   node scripts/benchmark.mjs [repeats]
 *
 * For each task it starts the in-app instrumentation (src/copilot/bench.ts),
 * issues the one spoken command through the real grammar and dispatcher, and
 * records what the instrumentation measured: machine time until the requested
 * answer is on screen, interactions counted, and whether the answer matches
 * an independent recomputation. Setup (placing and saving a plan) happens
 * before the clock starts.
 *
 * This measures software latency and step count, NOT human performance: no
 * person is timed here. The same instrumentation is how a human trial would
 * be recorded (window.scrub.bench.start(task, 'manual' | 'copilot')).
 */

import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const repeats = Number(process.argv[2] ?? 5);
const URL = 'http://localhost:5173/?hands=off&voice=off';

const browser = await chromium.launch({ headless: false, args: ['--ignore-gpu-blocklist'] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();

const say = (text) =>
  page.evaluate(async (t) => {
    const { parseIntent } = await import('/src/voice/intents.ts');
    window.scrub.dispatch(parseIntent(t), 'voice');
  }, text);

async function boot() {
  await page.goto(URL);
  await page.waitForFunction(() => window.scrub?.state?.phase === 'ready', { timeout: 60000 });
  await page.mouse.click(5, 5);
}

async function timed(task, command, setup) {
  await boot();
  if (setup) await setup();
  const n0 = await page.evaluate(() => window.scrub.bench.results.length);
  await page.evaluate((t) => window.scrub.bench.start(t, 'copilot'), task);
  await say(command);
  await page.waitForFunction((n) => window.scrub.bench.results.length > n, n0, { timeout: 20000 });
  return page.evaluate(() => window.scrub.bench.results.at(-1));
}

// A saved plan, then the cut and the camera moved away from it.
async function savedThenChanged() {
  await say('make a sagittal cut 12 millimeters from the tumor');
  await page.waitForTimeout(900);
  await say('save this plan');
  await page.waitForTimeout(200);
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowDown');
  await page.evaluate(() => {
    const c = window.scrub.state.camera;
    c.yaw += 1.2;
    c.dist = 2.4;
  });
  await page.waitForTimeout(200);
}

const TASKS = [
  ['distance', 'show me the tumor relative to the portal vein', null],
  ['nearest', 'show me where the tumor is closest to a major vessel', null],
  ['restore', 'show me the original plan', savedThenChanged],
  ['compare', 'compare this cut to the original plan', savedThenChanged],
];

const rows = [];
for (const [task, command, setup] of TASKS) {
  for (let i = 0; i < repeats; i++) {
    const r = await timed(task, command, setup);
    rows.push({ ...r, command });
    console.log(task, r.ms, 'ms', r.interactions, 'interaction(s)', r.correct ? 'correct' : 'WRONG', '-', r.detail);
  }
}
await browser.close();

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};
const summary = TASKS.map(([task, command]) => {
  const rs = rows.filter((r) => r.task === task);
  return {
    task,
    command,
    runs: rs.length,
    medianMs: median(rs.map((r) => r.ms)),
    maxMs: Math.max(...rs.map((r) => r.ms)),
    interactions: median(rs.map((r) => r.interactions)),
    correct: rs.filter((r) => r.correct).length,
    detail: rs[0].detail,
  };
});
console.table(summary);
writeFileSync('docs/BENCHMARK.json', JSON.stringify({ when: new Date().toISOString(), repeats, summary, rows }, null, 2));
console.log('wrote docs/BENCHMARK.json');
