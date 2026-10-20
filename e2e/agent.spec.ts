/**
 * The agent path end to end with a scripted backend: the palette sends typed
 * text, round 1 asks the browser to run optimize_plane, round 2 answers from
 * that tool's numbers. The plane must move, the grounding counter must count
 * the reply, and the drawer must show the call.
 */

import { expect, test } from './fixtures.ts';

interface ToolMsg {
  role: string;
  tool_call_id?: string;
  content?: string;
}

test('palette sends a request to the agent, which runs a tool and answers', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const bodies: { text: string; state?: Record<string, unknown>; history?: ToolMsg[] }[] = [];
  const base = { latency_ms: 812, valid: true, prompt_tokens: 900, completion_tokens: 30, prompt_version: 'agent_v1', escalated: false };

  await page.route('**/api/health', (r) => r.fulfill({ json: { ok: true, token_factory: true } }));
  await page.route('**/api/grounding', (r) => r.fulfill({ json: { grounded: 214, rejected: 3 } }));
  await page.route('**/api/agent', async (r) => {
    const body = r.request().postDataJSON() as (typeof bodies)[number];
    bodies.push(body);
    if (!body.history) {
      const args = { margin_min_mm: 10 };
      await r.fulfill({
        json: {
          ...base,
          model: 'nvidia/nemotron-3-super',
          tool_calls: [{ id: 'call_1', name: 'optimize_plane', arguments: args, errors: [] }],
          text: null,
          done: false,
          assistant_message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'optimize_plane', arguments: JSON.stringify(args) } }],
          },
          grounding: null,
        },
      });
      return;
    }
    const tool = body.history.find((m) => m.role === 'tool');
    const result = JSON.parse(tool?.content ?? '{}') as { after?: { flr_pct: number; margin_mm: number } };
    await r.fulfill({
      json: {
        ...base,
        model: 'nvidia/nemotron-3-super',
        tool_calls: [],
        text: `Optimized. FLR ${result.after?.flr_pct} %, margin ${result.after?.margin_mm} mm.`,
        done: true,
        assistant_message: null,
        grounding: { checked: true, passed: true, rejected: 1, fallback: false, numbers: [] },
      },
    });
  });

  await page.goto('/?hands=off&voice=off&tutorial=0');
  await page.waitForFunction(() => window.scrub?.state.phase === 'ready');
  await page.evaluate(() => (window.scrub!.renderer.stepsOverride = 16));

  // Seeded from GET /api/grounding.
  const counter = page.locator('.grounding');
  await expect(counter).toHaveText('GROUNDED ✓ 214 · REJECTED 3');
  const before = await page.evaluate(() => ({ ...window.scrub!.state.plane }));

  await page.keyboard.press('/');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await expect(palette.locator('.palette-suggestion')).toHaveCount(6);
  await page.getByRole('textbox', { name: 'Command' }).fill('optimize the cut with a 10 mm margin');
  await page.keyboard.press('Enter');

  await page.waitForFunction(() => /^Optimized\. FLR \d/.test(window.scrub!.state.response), null, { timeout: 60_000 });
  await expect(palette).toBeHidden();

  // Round 1 carried the app state; round 2 carried the tool result for call_1.
  expect(bodies).toHaveLength(2);
  expect(bodies[0].text).toBe('optimize the cut with a 10 mm margin');
  expect(bodies[0].state).toMatchObject({ case_id: 'liver', case_kind: 'liver', plane: null });
  expect(bodies[1].history?.map((m) => m.role)).toEqual(['assistant', 'tool']);
  expect(bodies[1].history?.[1].tool_call_id).toBe('call_1');

  // The tool moved the real plane, through the same path as "Scrub, optimize".
  await page.waitForTimeout(1000);
  const after = await page.evaluate(() => ({ ...window.scrub!.state.plane, th: window.scrub!.state.thresholds.marginMin }));
  expect(after.on).toBe(true);
  expect(after.n.join() !== before.n.join() || Math.abs(after.d - before.d) > 0.5).toBe(true);
  expect(after.th).toBe(10);
  // The reply quotes the tool's numbers, which are the engine's.
  const reply = await page.evaluate(() => window.scrub!.state.response);
  const m = (await page.evaluate(() => window.scrub!.state.metrics))!;
  expect(reply).toContain(`FLR ${Math.round(m.remnantPct * 10) / 10} %`);

  await expect(counter).toHaveText('GROUNDED ✓ 215 · REJECTED 4');

  await page.getByRole('button', { name: 'Under the hood' }).click();
  const hood = page.locator('aside.hood');
  await expect(hood).toBeVisible();
  const rows = hood.locator('.hood-row');
  await expect(rows).toHaveCount(2);
  // Newest first: the answer, then the tool round.
  await expect(rows.nth(0)).toContainText('nvidia/nemotron-3-super');
  await expect(rows.nth(0)).toContainText('grounded ✓');
  await expect(rows.nth(1)).toContainText('optimize_plane');
  await expect(rows.nth(1)).toContainText('812 ms');
});

test('agent failure falls back to the grammar', async ({ page }) => {
  await page.route('**/api/health', (r) => r.fulfill({ json: { ok: true, token_factory: true } }));
  // An invalid reply (not a failed request, which Chromium would log as an error).
  await page.route('**/api/agent', (r) =>
    r.fulfill({
      json: {
        model: 'nvidia/nemotron-3-super', latency_ms: 50, valid: false, prompt_tokens: 0, completion_tokens: 0, prompt_version: 'agent_v1',
        tool_calls: [{ id: 'c', name: 'window', arguments: null, errors: ['window: preset is required'] }],
        text: null, done: false, assistant_message: null, escalated: false, grounding: null,
      },
    }),
  );
  const health = page.waitForResponse('**/api/health');
  await page.goto('/?hands=off&voice=off&tutorial=0');
  await page.waitForFunction(() => window.scrub?.state.phase === 'ready');
  await health;
  await page.waitForTimeout(50);
  const asked = page.waitForRequest('**/api/agent');
  await page.evaluate(() => window.scrub!.command('bone window'));
  await asked;
  await page.waitForFunction(() => window.scrub!.state.preset === 'bone');
  // The counter stays hidden: no grounding totals from this backend.
  await expect(page.locator('.grounding')).toBeHidden();
  await page.getByRole('button', { name: 'Under the hood' }).click();
  await expect(page.locator('aside.hood .hood-row').first()).toContainText('failed');
});

test('tools drive the live app and answer in the shared shapes', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?hands=off&voice=off&tutorial=0');
  await page.waitForFunction(() => window.scrub?.state.phase === 'ready');
  await page.evaluate(() => (window.scrub!.renderer.stepsOverride = 16));
  const tool = (name: string, args: Record<string, unknown> = {}) =>
    page.evaluate(([n, a]) => window.scrub!.tool(n as string, a as Record<string, unknown>), [name, args] as const);
  /** Wait until the drawn plane has arrived at `d` (tweens run on frames, slow under SwiftShader). */
  const planeAt = (d: number) =>
    page.waitForFunction((t) => Math.abs(window.scrub!.state.plane.d - t) < 0.06, d, { timeout: 20_000 });

  const s0 = await tool('get_state');
  expect(s0).toMatchObject({ case_id: 'liver', case_kind: 'liver', mode: 'surgeon', plane: null, stent: null, thresholds: { margin_min_mm: 10, flr_min_pct: 30 } });
  expect(s0.visible).toContain('tumor');
  expect(await tool('measure', { what: 'flr' })).toHaveProperty('error');
  expect(await tool('segment_point', { xyz_mm: [0, 0, 0] })).toMatchObject({ error: 'unavailable' });

  const opt = await tool('optimize_plane', {});
  expect(opt.reason_codes).toEqual(['no_cut', 'wide_search']);
  expect(Object.keys(opt.after as object).sort()).toEqual(['flr_pct', 'margin_mm', 'vessels_crossed']);
  await planeAt((opt.plane as { d: number }).d);

  const flr = await tool('measure', { what: 'flr' });
  expect(flr).toMatchObject({ what: 'flr', unit: '%', value: (opt.after as { flr_pct: number }).flr_pct });
  expect(typeof flr.method).toBe('string');
  expect(await tool('measure', { what: 'tumor_volume' })).toMatchObject({ unit: 'mL' });

  const moved = await tool('set_plane', { offset_mm: -3 });
  expect(moved).toMatchObject({ plane: { d: Math.round(((opt.plane as { d: number }).d - 3) * 10) / 10 } });
  expect(moved).toHaveProperty('flr_pct');
  // Chained without waiting: the next call builds on where this one is headed.
  const turned = await tool('set_plane', { rotate_deg: { axis: 'z', deg: 10 } });
  expect(turned).toHaveProperty('margin_mm');
  await planeAt((turned.plane as { d: number }).d);

  expect(await tool('set_threshold', { name: 'margin_min_mm', value: 12 })).toEqual({ thresholds: { margin_min_mm: 12, flr_min_pct: 30 } });
  expect(await tool('window', { preset: 'soft' })).toEqual({ ok: true, preset: 'soft' });
  expect(await page.evaluate(() => window.scrub!.state.preset)).toBe('soft');
  expect(await tool('show', { structure_ids: ['nope'], mode: 'hide' })).toHaveProperty('error');
  expect(await tool('show', { structure_ids: ['tumor'], mode: 'highlight' })).toMatchObject({ ok: true });

  const res = await tool('resect');
  if (!('error' in res)) {
    expect(Object.keys(res).sort()).toEqual(['remnant_flr_pct', 'resected_ml']);
    await expect(page.locator('.info-card.show')).toContainText('Planned resection');
  }
  const plan = await tool('write_plan');
  expect(plan).toMatchObject({ case_id: 'liver', thresholds: { margin_min_mm: 12 } });
  expect(await tool('place_stent', { device_id: 'x' })).toHaveProperty('error');

  // The aorta case: the stent tools.
  await page.evaluate(() => window.scrub!.dispatch({ kind: 'loadCase', id: 'aorta' }, 'key'));
  await page.waitForFunction(() => window.scrub!.state.data?.meta.id === 'aorta');
  const st = await tool('place_stent', { device_id: 'gore_excluder' });
  expect(st).toMatchObject({ device_id: 'gore_excluder', seals: true });
  expect((st.rules as { pass: boolean }[]).every((r) => r.pass)).toBe(true);
  expect(await page.evaluate(() => window.scrub!.state.stent?.seals)).toBe(true);
  const neck = (st.rules as { id: string; value: number }[]).find((r) => r.id === 'neck_length')!.value;
  expect(await tool('measure', { what: 'neck_length' })).toMatchObject({ value: neck, unit: 'mm' });
  const lowest = await tool('place_stent', { device_id: 'gore_excluder', s0_mm: Math.max(0, (st.s0_mm as number) - 15) });
  expect(lowest).toMatchObject({ seals: false });
  expect((lowest.rules as { id: string; pass: boolean }[])[0]).toMatchObject({ id: 'renal', pass: false });
  // A device sized for that seat may seal nowhere; report, not crash.
  const nowhere = await tool('optimize_stent', { device_id: 'gore_excluder' });
  expect(nowhere.found === true || typeof nowhere.failing_rule === 'string').toBe(true);
  // The keyboard story: the sealing device nudged 15 mm up, then optimized.
  await tool('place_stent', { device_id: 'gore_excluder' });
  await page.evaluate(() => window.scrub!.dispatch({ kind: 'nudgeStent', mm: -15 }, 'key'));
  await page.waitForFunction(() => window.scrub!.state.stent?.seals === false);
  const fixed = await tool('optimize_stent', { device_id: 'gore_excluder' });
  expect(fixed).toMatchObject({ found: true, seals: true });
  await page.waitForFunction(() => window.scrub!.state.stent?.seals === true, null, { timeout: 10_000 });
  expect(await tool('optimize_plane')).toHaveProperty('error');
});
