import { test, expect } from '@playwright/test';

for (const [timezoneId, expected] of [['America/Vancouver', '2026-10-11 08:00:01'], ['Asia/Tokyo', '2026-10-12 00:00:01']]) {
  test(`change timestamp uses browser timezone ${timezoneId}`, async ({ browser }) => {
    const context = await browser.newContext({ timezoneId });
    const page = await context.newPage();
    await page.route('**/api/v1/status', async route => {
      const response = await route.fetch(); const snapshot = await response.json();
      snapshot.ui.autoDiagnostics = false;
      snapshot.services[0].presentation = { text: 'POWER3: OFF', textMode: 'wrap', timestamp: { label: 'Last observed change', at: '2026-10-11T15:00:01Z' } };
      await route.fulfill({ response, json: snapshot });
    });
    try {
      await page.goto('http://127.0.0.1:8128/');
      await expect(page.locator('.change-time time')).toHaveText(expected!);
      await expect(page.locator('.change-time time')).toHaveAttribute('datetime', '2026-10-11T15:00:01Z');
    } finally { await context.close(); }
  });
}
