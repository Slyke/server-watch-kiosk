import { test, expect } from './fixtures.js';

test.beforeEach(async ({ request }) => {
  await request.post('/api/v1/runtime', { data: { action: 'scenario', scenario: 'mixed' } });
});
test('auto diagnostics, stale failure retention, recovery and manual ownership', async ({ page, request }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('.tile')).toHaveCount(34);
  await expect(page.getByRole('complementary', { name: 'Service diagnostics' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Probes', exact: true })).toHaveAttribute('aria-selected', 'true');
  await request.post('/api/v1/runtime', { data: { action: 'scenario', scenario: 'collector-disconnect' } });
  await expect(page.locator('.tile[data-state="unknown"]')).toHaveCount(32, { timeout: 10000 });
  await expect(page.getByRole('complementary', { name: 'Service diagnostics' })).toBeVisible();
  await request.post('/api/v1/runtime', { data: { action: 'scenario', scenario: 'recovery' } });
  await expect(page.getByRole('complementary', { name: 'Service diagnostics' })).toBeHidden({ timeout: 10000 });
  await page.getByRole('button', { name: 'Diagnostics', exact: true }).click();
  await page.getByRole('tab', { name: 'Checks', exact: true }).click();
  await request.post('/api/v1/runtime', { data: { action: 'scenario', scenario: 'mixed' } });
  await page.waitForTimeout(5200);
  await expect(page.getByRole('tab', { name: 'Checks', exact: true })).toHaveAttribute('aria-selected', 'true');
  expect(errors).toEqual([]);
});
test('custom named orders, keyboard reorder, persistence, modal and split', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Close diagnostics', exact: true }).click();
  await expect(page.getByLabel('Auto diagnostics', { exact: true })).not.toBeChecked();
  await page.getByLabel('Order', { exact: true }).selectOption('custom');
  await page.getByRole('button', { name: 'Arrange cells', exact: true }).click();
  await page.getByLabel('Layout name', { exact: true }).fill('Wall');
  await page.getByRole('button', { name: 'Save as new', exact: true }).click();
  await page.getByRole('button', { name: 'Move Backup worker up', exact: true }).click();
  const first = await page.locator('.tile').first().getAttribute('data-service');
  await page.getByLabel('Layout name', { exact: true }).fill('Desk');
  await page.getByRole('button', { name: 'Save as new', exact: true }).click();
  await page.getByRole('button', { name: 'Close options', exact: true }).click();
  await page.reload();
  await expect(page.getByLabel('Custom layout', { exact: true })).toHaveValue('Desk');
  await expect(page.locator('.tile').first()).toHaveAttribute('data-service', first!);
  await page.getByLabel('Custom layout', { exact: true }).selectOption('Wall');
  const tile = page.locator('[data-service="nextcloud"]');
  await tile.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('heading', { name: 'Nextcloud' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(tile).toBeFocused();
  await page.getByRole('button', { name: 'Diagnostics', exact: true }).click();
  const divider = page.getByRole('separator', { name: 'Resize diagnostics' });
  await divider.focus(); await page.keyboard.press('ArrowLeft');
  expect(Number(await divider.getAttribute('aria-valuenow'))).toBeLessThan(60);
  await page.reload();
  expect(Number(await page.getByRole('separator').getAttribute('aria-valuenow'))).toBeLessThan(60);
  expect(errors).toEqual([]);
});
test('API outage clears current green tiles without closing diagnostics', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.tile')).toHaveCount(34);
  await expect(page.locator('[data-service="garmin"] .component-status')).toHaveText(['■', '■', '×']);
  await expect(page.locator('[data-service="immich"] .component-status')).toHaveText(['▲']);
  await page.route('**/api/v1/status', route => route.abort());
  await expect(page.locator('.connection-banner')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('.tile[data-state="healthy"]')).toHaveCount(0);
  await expect(page.locator('[data-service="garmin"] .component-status')).toHaveText(['?', '?', '?']);
  await expect(page.getByRole('complementary', { name: 'Service diagnostics' })).toBeVisible();
});
test('responsive layouts and themes have no horizontal overflow', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('.tile')).toHaveCount(34);
  for (const theme of ['reference', 'dark', 'light', 'contrast', 'tron']) {
    await page.getByRole('button', { name: 'Options', exact: true }).click();
    await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption(theme);
    await page.getByRole('button', { name: 'Close options', exact: true }).click();
    await page.screenshot({ path: '.local/theme-' + theme + '.png', fullPage: true });
  }
  for (const viewport of [{ width: 1366, height: 768 }, { width: 320, height: 800 }]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  }
  await page.getByRole('button', { name: 'Return to grid', exact: true }).click();
  await expect(page.locator('.board')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await page.screenshot({ path: '.local/mobile.png', fullPage: true });
});
