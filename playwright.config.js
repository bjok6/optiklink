// playwright.config.js
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
    testDir: './tests',
    timeout: 120000,
    retries: 0,
    workers: 1,
    reporter: [['list']],
    use: {
        headless: true,
        screenshot: 'only-on-failure',
        video: 'off',
    },
});
