import { test, expect } from './fixtures.js';
import { lanApi } from './lan-api.js';

test('theme and compact mode sync into independent locked browsers and survive reload', async ({ page, browser }) => {
  const lockedContext = await browser.newContext(); await lanApi(lockedContext);
  const locked = await lockedContext.newPage();
  await Promise.all([page.goto('/'), locked.goto('/')]);
  await expect(locked.getByText('Read-only status', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption('tron');
  await page.getByLabel('Compact cells', { exact: true }).check();
  await expect(locked.locator('html')).toHaveAttribute('data-theme', 'tron', { timeout: 10000 });
  await expect(locked.locator('.board')).toHaveClass(/dense/, { timeout: 10000 });
  await locked.reload();
  await expect(locked.locator('html')).toHaveAttribute('data-theme', 'tron');
  await expect(locked.locator('.board')).toHaveClass(/dense/);
  await expect(locked.getByRole('button', { name: 'Options', exact: true })).toHaveCount(0);
  const status = await locked.evaluate(async () => (await fetch('/api/v1/preferences', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dense: false }) })).status);
  expect(status).toBe(403);
  await lockedContext.close();
});
