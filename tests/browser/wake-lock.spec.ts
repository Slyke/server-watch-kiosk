import { test, expect, type Page } from './fixtures.js';

const mockWakeLock = async ({ page, delayed = false }: { page: Page; delayed?: boolean }) => {
  await page.addInitScript(({ delayed }) => {
    const state = { requests: 0, releases: 0, denied: false, resolve: () => {}, release: () => {} };
    (window as any).__wake = state;
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: {
      request: async () => {
        state.requests++;
        if (state.denied) throw new DOMException('Denied', 'NotAllowedError');
        const sentinel = new EventTarget() as EventTarget & { released: boolean; release: () => Promise<void> };
        sentinel.released = false;
        sentinel.release = async () => { if (!sentinel.released) { sentinel.released = true; state.releases++; sentinel.dispatchEvent(new Event('release')); } };
        state.release = () => { void sentinel.release(); };
        if (delayed) await new Promise<void>(resolve => { state.resolve = resolve; });
        return sentinel;
      },
    } });
  }, { delayed });
  await page.route('**/api/v1/status', async route => {
    const response = await route.fetch(); const snapshot = await response.json(); snapshot.mode = 'live';
    await route.fulfill({ response, json: snapshot });
  });
};

test('live wake lock releases, reacquires, reports denial and persists opt-out', async ({ page }) => {
  await mockWakeLock({ page });
  await page.goto('/');
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await expect(page.getByText('Screen wake lock is active.', { exact: true })).toBeVisible();
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => page.evaluate(() => (window as any).__wake.releases)).toBe(1);
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => page.evaluate(() => (window as any).__wake.requests)).toBe(2);
  await page.evaluate(() => (window as any).__wake.release());
  await expect(page.getByText('The browser or device released the screen wake lock.', { exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).__wake.denied = true; });
  await page.getByRole('button', { name: 'Retry screen wake lock', exact: true }).click();
  await expect(page.getByText('The browser or device declined the screen wake lock.', { exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).__wake.denied = false; });
  await page.getByRole('button', { name: 'Retry screen wake lock', exact: true }).click();
  await expect(page.getByText('Screen wake lock is active.', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Keep screen awake', exact: true }).uncheck();
  await expect(page.getByText('Screen sleep follows device settings.', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Keep screen awake', exact: true })).not.toBeChecked();
  expect(await page.evaluate(() => (window as any).__wake.requests)).toBe(0);
});

test('a late wake lock grant is released after the user disables it', async ({ page }) => {
  await mockWakeLock({ page, delayed: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await expect(page.getByText('Requesting screen wake lock…', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Keep screen awake', exact: true }).uncheck();
  await page.evaluate(() => (window as any).__wake.resolve());
  await expect.poll(() => page.evaluate(() => (window as any).__wake.releases)).toBe(1);
  await expect(page.getByText('Screen sleep follows device settings.', { exact: true })).toBeVisible();
});

test('offline demo does not request a screen wake lock', async ({ page }) => {
  await mockWakeLock({ page });
  await page.unroute('**/api/v1/status');
  await page.goto('/');
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await expect(page.getByText('Screen wake lock starts in live mode.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__wake.requests)).toBe(0);
});
