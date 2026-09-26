import { defineConfig } from '@playwright/test';
import fs from 'node:fs';
fs.mkdirSync('.local', { recursive: true });
fs.writeFileSync('.local/browser.json5', JSON.stringify({ schemaVersion: 1, server: { host: '127.0.0.1', port: 8128 }, demo: { enabled: true }, plugins: { directory: '../checks', allowHotReload: true } }));

export default defineConfig({
  testDir: './tests/browser', fullyParallel: false, workers: 1, timeout: 20000,
  use: { baseURL: 'http://127.0.0.1:8128', headless: true, viewport: { width: 1920, height: 1080 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: 'node dist/server/main.js --config .local/browser.json5 --demo', url: 'http://127.0.0.1:8128/livez', reuseExistingServer: !process.env.CI, timeout: 20000 },
});
