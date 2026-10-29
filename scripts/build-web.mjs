/**
 * Builds the hosted deployment into web-dist/ (what vercel.json serves):
 *
 *   /       the Astro site from site/
 *   /app/   the app, installable as a PWA
 *
 * The app is built with every API key blanked: a VITE_* variable ends up in
 * public JavaScript, so a key in .env.local must never reach this build.
 * The agent runs on our backend (a Nebius Serverless Endpoint, backend/deploy.sh),
 * named by VITE_AGENT_URL; no closed model is called from the hosted build.
 * Without the backend the app falls back to regex intents and template
 * sentences. Binary case data is gzipped (the loader inflates
 * it when VITE_DATA_GZ=1), and the service worker gets a fresh cache id.
 */

import { execSync } from 'node:child_process';
import { cpSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'web-dist');
const appOut = join(out, 'app');

const run = (cmd, env = {}) => execSync(cmd, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });

rmSync(out, { recursive: true, force: true });

// DECISION: the hosted backend URL is public, so its default lives here and a
// Vercel build from git needs no environment setup. AGENT_URL overrides it.
const AGENT_URL = process.env.AGENT_URL ?? 'https://port8000-kkda5hbszzy2k3q.tunnel.applications.eu-south1.nebius.cloud/api/agent';

// Variables already in the environment beat .env files in Vite, so these
// empty values win over anything in .env.local.
run(`npx tsc --noEmit && npx vite build --base=/app/ --outDir "${appOut}" --emptyOutDir`, {
  VITE_LLM: 'off',
  VITE_AGENT_URL: AGENT_URL,
  VITE_GEMINI_KEY: '',
  VITE_ANTHROPIC_KEY: '',
  VITE_ELEVENLABS_KEY: '',
  VITE_HEAD: '0',
  VITE_DATA_GZ: '1',
});

const leaked = readdirSync(join(appOut, 'assets'))
  .filter((f) => f.endsWith('.js'))
  .some((f) => /AIza[0-9A-Za-z_-]{20,}|sk-ant-/.test(readFileSync(join(appOut, 'assets', f), 'utf8')));
if (leaked) throw new Error('[build-web] an API key made it into the app bundle');

let raw = 0;
let packed = 0;
const dataDir = join(appOut, 'data');
for (const id of readdirSync(dataDir)) {
  if (!statSync(join(dataDir, id)).isDirectory()) continue;
  for (const f of readdirSync(join(dataDir, id))) {
    if (!/\.(u8|bin)$/.test(f)) continue;
    const p = join(dataDir, id, f);
    const gz = gzipSync(readFileSync(p), { level: 9 });
    writeFileSync(`${p}.gz`, gz);
    raw += statSync(p).size;
    packed += gz.length;
    rmSync(p);
  }
}
console.log(`[build-web] case data ${(raw / 1e6).toFixed(1)} MB -> ${(packed / 1e6).toFixed(1)} MB gzipped`);

const sw = join(appOut, 'sw.js');
writeFileSync(sw, readFileSync(sw, 'utf8').replaceAll('__BUILD__', Date.now().toString(36)));

run('npm run build --prefix site');
cpSync(join(root, 'site', 'dist'), out, { recursive: true });
console.log('[build-web] web-dist ready: site at /, app at /app/');
