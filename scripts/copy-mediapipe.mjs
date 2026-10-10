/**
 * Copy MediaPipe's WASM runtime out of node_modules into public/, so hand
 * tracking loads from our own origin and keeps working offline. Runs on
 * `npm install` (postinstall) and before `npm run dev`.
 */

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const dst = join(root, 'public', 'mediapipe', 'wasm');

if (!existsSync(src)) {
  console.warn('[copy-mediapipe] @mediapipe/tasks-vision not installed; skipping');
} else {
  mkdirSync(dst, { recursive: true });
  cpSync(src, dst, { recursive: true });
  console.log('[copy-mediapipe] wasm runtime -> public/mediapipe/wasm');
}
