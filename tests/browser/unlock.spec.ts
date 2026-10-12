import { test, expect, type BrowserContext } from '@playwright/test';
import http from 'node:http';

const code = 'browser-unlock-test-code';
const key = 'service-board.unlock-code';

// Use the real API middleware with a LAN Host, without depending on external DNS.
const lanApi = async (context: BrowserContext) => {
  await context.route('**/api/v1/**', async route => {
    const request = route.request();
    const headers: Record<string, string> = { ...request.headers(), host: 'board.lan', 'accept-encoding': 'identity' };
    if (headers.origin === new URL(request.url()).origin) headers.origin = 'http://board.lan';
    const result = await new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>((resolve, reject) => {
      const req = http.request(request.url(), { method: request.method(), headers }, res => {
        const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode!, headers: Object.fromEntries(Object.entries(res.headers)
          .filter(([name, value]) => typeof value === 'string' && !['content-length', 'transfer-encoding', 'content-encoding'].includes(name))) as Record<string, string>, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      req.on('error', reject); req.end(request.postDataBuffer());
    });
    await route.fulfill(result);
  });
};

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
  await page.getByRole('button', { name: 'Diagnostics', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Checks', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Lock UI', exact: true })).toBeVisible();
  const second = await context.newPage(); await second.goto('/');
  await expect(second.getByRole('button', { name: 'Lock UI', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Lock UI', exact: true }).click();
  for (const tab of [page, second]) {
    await expect(tab.getByText('Read-only status', { exact: true })).toBeVisible();
    await expect(tab.getByRole('button', { name: 'Options', exact: true })).toHaveCount(0);
    await expect(tab.getByRole('complementary', { name: 'Service diagnostics' })).toHaveCount(0);
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
  await expect(page.getByRole('button', { name: 'Diagnostics', exact: true })).toHaveCount(0);
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
