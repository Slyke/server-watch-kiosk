import { test, expect } from '@playwright/test';

test('theme defaults, browser overrides and resetting to the configured default', async ({ page }) => {
  let configuredTheme = 'tron';
  let revision = 0;
  await page.route('**/api/v1/status', async route => {
    const response = await route.fetch();
    const snapshot = await response.json();
    snapshot.ui.theme = configuredTheme;
    snapshot.revision = ++revision;
    await route.fulfill({ response, json: snapshot });
  });
  const root = page.locator('html');
  const selector = page.getByRole('combobox', { name: 'Theme', exact: true });
  await page.goto('/');
  await expect(root).toHaveAttribute('data-theme', 'tron');
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await expect(selector).toHaveValue('');
  await expect(page.getByText('configured in config.json5', { exact: false })).toHaveCount(0);
  for (const theme of ['reference', 'dark', 'contrast', 'tron', 'light']) {
    await selector.selectOption(theme);
    await expect(root).toHaveAttribute('data-theme', theme);
  }
  configuredTheme = 'contrast';
  const previousRevision = revision;
  await expect.poll(() => revision, { timeout: 10000 }).toBeGreaterThan(previousRevision);
  await expect(root).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(root).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await expect(selector).toHaveValue('light');
  await selector.selectOption('');
  await expect(root).toHaveAttribute('data-theme', 'contrast');
  configuredTheme = 'dark';
  await page.reload();
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await expect(selector).toHaveValue('');
  await page.getByRole('checkbox', { name: 'Compact cells', exact: true }).check();
  await page.reload();
  await expect(page.locator('.board')).toHaveClass('board dense');
});
