/**
 * Shared e2e fixture. Every test:
 *  - fails on any console.error or uncaught page error (CLAUDE.md section 8);
 *  - runs without the agent backend: /api/health says Token Factory is off and
 *    /api/grounding has no totals, so the app takes the v1 grammar path and
 *    no request fails (a failed fetch is itself a console error in Chromium).
 * A test that wants the agent registers its own routes; later routes win.
 */

import { expect, test as base } from '@playwright/test';

export const test = base.extend<{ consoleGuard: void }>({
  consoleGuard: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
      });
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      await page.route('**/api/health', (r) => r.fulfill({ json: { ok: true, token_factory: false } }));
      await page.route('**/api/grounding', (r) => r.fulfill({ json: {} }));
      await use();
      expect(errors, 'console errors during the test').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
