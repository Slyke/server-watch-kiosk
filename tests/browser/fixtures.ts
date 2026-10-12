import { test as base } from '@playwright/test';
export * from '@playwright/test';
export const defaultDisplaySettings = { themeOverride: null, dense: false, keepAwake: true, sortMode: 'severity', autoDiagnostics: true, splitRatio: 0.6, customOrders: {}, customOrder: '' };
export const test = base.extend<{ resetDisplaySettings: void }>({
  resetDisplaySettings: [async ({ request }, use) => {
    const response = await request.patch('/api/v1/preferences', { data: defaultDisplaySettings });
    if (!response.ok()) throw new Error('Unable to reset shared test settings');
    await use();
  }, { auto: true }],
});
