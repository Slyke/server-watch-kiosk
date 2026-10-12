import { test, expect } from './fixtures.js';
import { lanApi } from './lan-api.js';

const code = 'browser-unlock-test-code';
const key = 'service-board.unlock-code';


test('LAN code unlocks diagnostics and controls, persists across reload, and can be forgotten', async ({ page, context }) => {
  await lanApi(context);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByText('Read-only status', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await page.getByLabel('Unlock code', { exact: true }).fill(code);
  await page.getByRole('button', { name: 'Unlock dashboard', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Lock UI', exact: true })).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe(code);
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh now', exact: true }).click();
  await expect(page.getByText('Applied.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close options', exact: true }).click();
  if (!await page.getByRole('complementary', { name: 'Service diagnostics' }).isVisible()) await page.getByRole('button', { name: 'Diagnostics', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Checks', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Lock UI', exact: true })).toBeVisible();
  const second = await context.newPage(); await second.goto('/');
  await expect(second.getByRole('button', { name: 'Lock UI', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Lock UI', exact: true }).click();
  for (const tab of [page, second]) {
    await expect(tab.getByText('Read-only status', { exact: true })).toBeVisible();
    await expect(tab.getByRole('button', { name: 'Options', exact: true })).toHaveCount(0);
    await expect(tab.getByRole('tab', { name: 'Logs', exact: true })).toHaveCount(0);
  }
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBeNull();
  expect(errors).toEqual([]);
});

test('incorrect and stale saved codes keep the board read-only', async ({ page, context }) => {
  await lanApi(context);
  await page.addInitScript(key => localStorage.setItem(key, 'obsolete-code'), key);
  await page.goto('/');
  await expect(page.getByText('Read-only status', { exact: true })).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBeNull();
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await page.getByLabel('Unlock code', { exact: true }).fill('incorrect-code');
  await page.getByRole('button', { name: 'Unlock dashboard', exact: true }).click();
  await expect(page.getByText('Incorrect unlock code.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Diagnostics', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Options', exact: true })).toHaveCount(0);
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBeNull();
});

test('localhost is fully available without an unlock or lock button, even with an obsolete saved code', async ({ page }) => {
  await page.addInitScript(key => localStorage.setItem(key, 'obsolete-local-code'), key);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Diagnostics', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Options', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unlock', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Lock UI', exact: true })).toHaveCount(0);
});
