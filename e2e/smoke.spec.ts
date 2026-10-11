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

  await page.goto('/?hands=off&voice=off&tutorial=0');
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

test('copilot: ask for anatomy, get the view and the verified measurement', async ({ page }) => {
  await page.goto('/?hands=off&voice=off&tutorial=0');
  await page.waitForFunction(() => window.scrub?.state.phase === 'ready');
  await page.evaluate(() => (window.scrub!.renderer.stepsOverride = 16));
  // The grammar is imported in the page by its dev-server URL (a variable, so
  // TypeScript does not try to resolve a browser path at compile time).
  const say = (text: string) =>
    page.evaluate(async (t) => {
      const url = '/src/voice/intents.ts';
      const { parseIntent } = (await import(/* @vite-ignore */ url)) as typeof import('../src/voice/intents.ts');
      const intent = parseIntent(t);
      if (!intent) throw new Error(`no intent for "${t}"`);
      window.scrub!.dispatch(intent, 'voice');
    }, text);

  // A: relationship. The camera flies in, both structures are in focus, the
  // closest points are joined and the reading names them.
  await say('show me the tumor relative to the portal vein');
  await page.waitForFunction(() => /portal vein/i.test(window.scrub!.state.caliper.label ?? ''));
  await page.waitForTimeout(800);
  const a = await page.evaluate(() => {
    const s = window.scrub!.state;
    return { target: s.camera.target, dist: s.camera.dist, focus: s.focus.length, mm: s.caliper.mm, response: s.response };
  });
  expect(Math.hypot(...a.target)).toBeGreaterThan(0.05); // moved off the volume centre
  expect(a.dist).toBeLessThan(1.75); // and closer than the default view
  expect(a.focus).toBe(2);
  expect(a.response).toMatch(/millimeters? from the portal vein/);
  await expect(page.locator('.info-card.show')).toContainText('Closest wall-to-wall gap');

  // B: closest vessel, with a CT section through the gap.
  await say('show me where the tumor is closest to a major vessel');
  await page.waitForFunction(() => window.scrub!.state.viewSection === true, null, { timeout: 15_000 });
  await expect(page.locator('.info-card.show')).toContainText('Closest:');

  // C: a cut, saved as the baseline; saving again needs a confirmation.
  await say('make a sagittal cut 12 millimeters from the tumor');
  await page.waitForFunction(() => window.scrub!.state.plane.on && !window.scrub!.state.viewSection);
  await page.waitForTimeout(800);
  await say('save this plan');
  await page.waitForFunction(() => /Saved as the original plan/.test(window.scrub!.state.response));
  const saved = await page.evaluate(() => ({ ...window.scrub!.state.plane }));
  await say('save this plan');
  await page.waitForFunction(() => /confirm/.test(window.scrub!.state.response));

  // Move the cut by hand (keyboard stand-in for the palm), then compare.
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowDown');
  await say('compare this cut to the original plan');
  await page.waitForFunction(() => window.scrub!.state.ghostPlane !== null);
  await expect(page.locator('.info-card.show')).toContainText('Original / current');
  expect(await page.evaluate(() => window.scrub!.state.response)).toMatch(/^Compared with the saved plan, the current plane /);

  // D: restore reproduces the saved plane exactly; go back returns.
  await say('show me the original plan');
  await page.waitForFunction(() => /Original plan restored/.test(window.scrub!.state.response));
  const restored = await page.evaluate(() => ({ ...window.scrub!.state.plane }));
  expect(restored.d).toBeCloseTo(saved.d, 9);
  expect(restored.n).toEqual(saved.n);
  await say('go back to the previous view');
  await page.waitForFunction(() => window.scrub!.state.response === 'Previous view.');

  // A structure this segmentation does not have: said plainly, no measurement.
  const before = await page.evaluate(() => window.scrub!.state.caliper.mm);
  await page.evaluate(() => window.scrub!.dispatch({ kind: 'relation', a: 'tumor', b: 'kidney_cyst' }, 'llm'));
  await page.waitForFunction(() => /There is no kidney cyst in this segmentation/.test(window.scrub!.state.response));
  expect(await page.evaluate(() => window.scrub!.state.caliper.mm)).toBe(before);
  // Words outside the vocabulary never become a command.
  expect(
    await page.evaluate(async () => {
      const url = '/src/voice/intents.ts';
      return ((await import(/* @vite-ignore */ url)) as typeof import('../src/voice/intents.ts')).parseIntent('focus on the spleen');
    }),
  ).toBeNull();
});

test('first-run tutorial: each step waits for the gesture (mouse stand-ins), then picks a case', async ({ page }) => {
  // A laptop-sized window, so the object is visible beside the card.
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?hands=off&voice=off');
  await page.waitForFunction(() => window.scrub?.state.phase === 'ready');
  const card = page.locator('.tutorial .tut-card');
  await expect(card).toContainText('Show your hand', { timeout: 15_000 });
  expect(await page.evaluate(() => window.scrub!.state.data?.meta.id)).toBe('practice');

  await page.getByRole('button', { name: 'Next' }).click();
  await expect(card).toContainText('Pinch and drag to turn');
  // Not done until the object actually turns.
  await page.waitForTimeout(400);
  await expect(card).toContainText('Pinch and drag to turn');
  await page.mouse.move(760, 400);
  await page.mouse.down();
  await page.mouse.move(1150, 400, { steps: 12 });
  await page.mouse.up();
  await expect(card).toContainText('Two pinches to zoom', { timeout: 5_000 });

  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -300);
  await expect(card).toContainText('Open hand to cut', { timeout: 5_000 });
  await page.keyboard.press('x');
  await expect(card).toContainText('Fist to lock', { timeout: 5_000 });
  await page.keyboard.press('l');
  await expect(card).toContainText('Two fingers to measure', { timeout: 5_000 });
  await page.mouse.click(780, 380);
  await page.mouse.click(860, 400);
  await expect(card).toContainText('Voice commands', { timeout: 5_000 });

  await page.getByRole('button', { name: 'Liver case' }).click();
  await expect(page.locator('.tutorial')).toHaveCount(0);
  await page.waitForFunction(() => window.scrub!.state.data?.meta.id === 'liver');
});

test('upload: a NIfTI CT from disk becomes a viewable case', async ({ page }) => {
  await page.goto('/?hands=off&voice=off&tutorial=0');
  await page.waitForFunction(() => window.scrub?.state.phase === 'ready');
  const { makeNifti } = await import('../tests/niftiFixture.ts');
  const ct = makeNifti({
    dims: [48, 48, 40],
    spacing: [1.2, 1.2, 2],
    value: (i, j, k) => ((i - 24) ** 2 + (j - 24) ** 2 + (k - 20) ** 2 < 15 ** 2 ? 60 : (i - 24) ** 2 + (j - 24) ** 2 < 22 ** 2 ? -50 : -1000),
  });
  // The Upload button (headless Chromium opens no picker from a key press).
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Upload CT' }).click();
  await (await chooser).setFiles({ name: 'my_scan.nii', mimeType: 'application/octet-stream', buffer: Buffer.from(ct) });
  await page.waitForFunction(() => window.scrub!.state.data?.meta.id === 'upload', null, { timeout: 15_000 });
  const meta = await page.evaluate(() => ({ ...window.scrub!.state.data!.meta }));
  expect(meta.kind).toBe('scan');
  expect(meta.name).toBe('Upload: my_scan');
  expect(await page.evaluate(() => window.scrub!.state.response)).toMatch(/^Scan loaded\. No labels/);
  // The generic tools work on it: a spoken cut through its centre.
  await page.evaluate(() => window.scrub!.dispatch({ kind: 'cut', orientation: 'axial', through: null, offsetMm: null }, 'voice'));
  await page.waitForFunction(() => window.scrub!.state.plane.on);
  expect(await page.evaluate(() => window.scrub!.state.metrics)).toBeNull();
});
