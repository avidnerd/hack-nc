import { defineConfig } from '@playwright/test';

// E2E_PORT lets a second checkout (a git worktree) run its own dev server
// beside one already on 5173; reuseExistingServer would otherwise test the
// other checkout's code.
const port = Number(process.env.E2E_PORT ?? 5173);

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 480, height: 300 },
    launchOptions: {
      // Headless Chromium has no GPU; SwiftShader runs the real shaders.
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
  },
  webServer: {
    command: port === 5173 ? 'npm run dev' : `npm run dev -- --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
