import { test, expect } from '@playwright/test';

test('status-only viewers cannot open diagnostics despite saved browser preferences', async ({ page }) => {
  const requests: string[] = []; const errors: string[] = [];
  page.on('request', request => { if (/diagnostics|\/runtime/.test(request.url())) requests.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('service-board.preferences.v1', JSON.stringify({ version: 1, autoDiagnostics: true, manualPaneOpen: true })));
  await page.route('**/api/v1/status', async route => {
    const response = await route.fetch(); const snapshot = await response.json();
    snapshot.ui = { ...snapshot.ui, diagnosticsEnabled: false, optionsEnabled: false, autoDiagnostics: false, allowHotReload: false };
    await route.fulfill({ response, json: snapshot });
  });
  await page.goto('/');
  await expect(page.locator('.tile')).toHaveCount(34);
  await expect(page.getByText('Read-only status', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Diagnostics', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Options', exact: true })).toHaveCount(0);
  await page.locator('.tile').first().click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByRole('complementary', { name: 'Service diagnostics' })).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.tile')).toHaveCount(34);
  expect(requests).toEqual([]); expect(errors).toEqual([]);
});
