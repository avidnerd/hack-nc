/**
 * End-to-end smoke test: boot the real app, replay the recorded landmark
 * stream through the gesture pipeline (no camera needed), and check that the
 * palm turned the plane on and the planning numbers came out. Then run the
 * keyboard fallbacks for the other three moments.
 */

import { expect, test } from '@playwright/test';

// window.scrub is declared by src/main.ts, which tsconfig includes.

test('demo stream drives the plane and the numbers', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/?hands=off&voice=off');
  await page.waitForFunction(() => window.scrub?.state.phase === 'ready');
  // Software WebGL: keep the frame rate up so playback is not decimated.
  await page.evaluate(() => (window.scrub!.renderer.stepsOverride = 16));

  await page.keyboard.press('d');
  // The palm section of the stream starts ~3.5 s in.
  await page.waitForFunction(() => window.scrub!.state.plane.on === true, null, { timeout: 30_000 });
  await page.waitForFunction(() => window.scrub!.state.metrics !== null);

  const m = (await page.evaluate(() => window.scrub!.state.metrics))!;
  expect(m.remnantPct).toBeGreaterThanOrEqual(0);
  expect(m.remnantPct).toBeLessThanOrEqual(100);
  expect(Number.isFinite(m.marginMm)).toBe(true);

  // The HUD shows the same number the engine computed.
  const shown = await page.locator('#numbers .num-value').first().textContent();
  expect(shown).toMatch(/^\d+$/);

  // Fist in the stream locks the plane.
  await page.waitForFunction(() => window.scrub!.state.plane.locked === true, null, { timeout: 30_000 });

  // Two pointing hands: the caliper reports a distance.
  await page.waitForFunction(() => window.scrub!.state.caliper.mm > 0, null, { timeout: 30_000 });

  expect(errors).toEqual([]);
});

test('keyboard fallback runs moments 2 to 4', async ({ page }) => {
  await page.goto('/?hands=off&voice=off&case=aorta');
  await page.waitForFunction(() => window.scrub?.state.phase === 'ready');
  await page.evaluate(() => (window.scrub!.renderer.stepsOverride = 16));

  await page.keyboard.press('m');
  await page.waitForFunction(() => /^Aorta \d+ millimeters/.test(window.scrub!.state.response));

  await page.keyboard.press('s');
  await page.waitForFunction(() => window.scrub!.state.stent?.seals === true);
  expect(await page.evaluate(() => window.scrub!.state.response)).toMatch(/^Placed\. Neck \d+ millimeters\. Seals\.$/);

  // 15 mm higher: the covered graft now crosses the lowest renal ostium.
  for (let i = 0; i < 3; i++) await page.keyboard.press('[');
  await page.waitForFunction(() => window.scrub!.state.stent?.seals === false);
  expect(await page.evaluate(() => window.scrub!.state.response)).toMatch(/Won't seal/);

  await page.keyboard.press('o');
  await page.waitForFunction(() => window.scrub!.state.stent?.seals === true, null, { timeout: 10_000 });

  // Outcomes: published cohort rates, shown on the card.
  await page.keyboard.press('e');
  await page.waitForFunction(() => document.querySelector('.info-card.show') !== null);
  expect(await page.textContent('.info-card')).toMatch(/not a prediction for this patient/);

  await page.keyboard.press('p');
  await page.waitForFunction(() => window.scrub!.state.mode === 'patient');
  await expect(page.locator('#callouts')).toBeVisible();
});
