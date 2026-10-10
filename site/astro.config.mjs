// @ts-check
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';

const here = (/** @type {string} */ p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  output: 'static',
  site: 'https://scrubplus.vercel.app',
  vite: {
    resolve: {
      // The hero imports the app's own shader, coordinate maths and hand
      // tracking from ../src. Those files must resolve their packages from
      // this site's node_modules, so a deploy that installs only site/ works.
      dedupe: ['three', '@mediapipe/tasks-vision'],
      alias: { '@app': here('../src') },
    },
    server: { fs: { allow: [here('..')] } },
  },
});
