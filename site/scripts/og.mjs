/**
 * Open Graph image: a real 1200 x 630 frame of the hero, the engine's cut
 * torso with the headline, captured in headless Chromium.
 *
 *   node scripts/og.mjs [url]        default http://localhost:4321/
 *
 * Needs a running dev or preview server. Uses the Playwright install of the
 * app one level up, so the site carries no browser dependency of its own.
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(site, '..', 'package.json'));
const { chromium } = require('playwright');

const url = process.argv[2] ?? 'http://localhost:4321/';
const out = join(site, 'public', 'og.png');

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.goto(url);
await page.waitForSelector('[data-hero][data-hires]', { timeout: 90_000 });
// The end of the scroll sweep: tumour exposed, vessel lit, 3 mm from the cut.
await page.evaluate(() => window.scrollTo(0, innerHeight * 2));
await page.waitForTimeout(4000);
await page.addStyleTag({ content: 'astro-dev-toolbar, .hand { display: none !important; }' });
await page.screenshot({ path: out });
await browser.close();
console.log(`[og] ${out}`);
