// @ts-check
const { defineConfig, devices } = require('@playwright/test');

// 有 NODE_LINK → 走本地 SOCKS；不再使用 GOST_PROXY
const useLocalSocks = !!(process.env.NODE_LINK || '').trim();

module.exports = defineConfig({
  testDir: './tests',
  timeout: 120_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    ...devices['Desktop Chrome'],
    headless: true,
    ...(useLocalSocks
      ? {
          proxy: {
            server: 'socks5://127.0.0.1:1080',
          },
        }
      : {}),
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
