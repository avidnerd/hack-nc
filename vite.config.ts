// `defineConfig` comes from vitest/config (a superset of vite's) so the test
// block and the dev-server block can live in one file.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: {
    port: 5173,
    open: false,
    // Build output never feeds the app: site/ (the Astro landing page),
    // web-dist/ (the hosted build) and dist/. Their builds lock files that
    // crashed this watcher (EBUSY) on Windows. A regex, not a glob: the glob
    // missed Windows backslash paths.
    watch: { ignored: [/[\\/](site|web-dist|dist)[\\/]/] },
    // The v2 backend (backend/, FastAPI on :8787) in dev; a Nebius Serverless
    // Endpoint in the hosted build.
    proxy: {
      '/api/agent': 'http://localhost:8787',
      '/api/health': 'http://localhost:8787',
      '/api/grounding': 'http://localhost:8787',
      '/api/rules': 'http://localhost:8787',
      '/api/scans': 'http://localhost:8787',
      '/api/segment-point': 'http://localhost:8787',
    },
  },
  build: { target: 'es2022', assetsInlineLimit: 0 },
  // Shaders are imported with ?raw so they stay in .glsl files.
  assetsInclude: ['**/*.glsl'],
  worker: { format: 'es' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Files run one at a time: the optimizer test asserts the spec's < 500 ms
    // budget, which parallel suites competing for the CPU would make flaky.
    fileParallelism: false,
  },
});
