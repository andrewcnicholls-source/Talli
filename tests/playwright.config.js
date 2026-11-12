// The browser suite. Run through scripts/check.sh, which starts the local
// Supabase stack first; see TESTING.md.
'use strict';
const { defineConfig, devices } = require('@playwright/test');

const PORT = 4173;

module.exports = defineConfig({
  testDir: './browser',
  // One stack, one database: tests that sell spaces must not race each
  // other for them.
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'off',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...(process.env.PW_CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } }
      : {}),
  },
  // A phone at the gate, a tablet, and a desktop. All Chromium: the point
  // is the layout and the flow at each size.
  projects: [
    { name: 'phone', use: { ...devices['Pixel 7'] } },
    { name: 'tablet', use: { ...devices['Galaxy Tab S4'] } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } },
  ],
  webServer: {
    command: `node lib/serve.js ${PORT}`,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI,
  },
});
