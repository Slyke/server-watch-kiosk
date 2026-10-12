import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { ConfigSchema } from '../src/server/config.js';
import { createBoard } from '../src/server/app.js';
import { SharedDisplaySettings } from '../src/server/display-settings.js';

test('display settings persist atomically and merge independent field updates', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'board-display-'));
  const file = path.join(directory, 'settings.json');
  const defaults = ConfigSchema.parse({ schemaVersion: 1 }).uiDefaults;
  try {
    const store = new SharedDisplaySettings(defaults, file);
    store.patch({ themeOverride: 'tron' }); store.patch({ dense: true });
    const restored = new SharedDisplaySettings(defaults, file);
    assert.equal(restored.state.value.themeOverride, 'tron'); assert.equal(restored.state.value.dense, true);
    assert.equal(restored.state.revision, 2); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.throws(() => store.patch({ customOrders: JSON.parse('{"__proto__":[]}') }));
    assert.throws(() => store.patch({ themeOverride: 'invalid' } as any));
    assert.equal(store.state.revision, 2);
    fs.renameSync(directory, directory + '-moved'); fs.writeFileSync(directory, 'blocked directory');
    assert.throws(() => store.patch({ dense: false })); assert.equal(store.state.value.dense, true);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); fs.rmSync(directory + '-moved', { recursive: true, force: true }); }
});

test('shared settings are public to read, protected to update, and never accept credentials or runtime settings', async () => {
  const board = await createBoard({ config: ConfigSchema.parse({ schemaVersion: 1 }), secrets: { schemaVersion: 1, values: {} }, unlockCode: 'settings-test-key' });
  const server = http.createServer(board.app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const request = (route: string, patch?: unknown, headers: Record<string, string> = {}) => new Promise<{ status: number; value: any }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method: patch === undefined ? 'GET' : 'PATCH', headers: { host: 'board.lan', 'content-type': 'application/json', ...headers } }, res => {
      const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); let value; try { value = JSON.parse(text); } catch { value = text; } resolve({ status: res.statusCode!, value }); });
    });
    req.on('error', reject); req.end(patch === undefined ? undefined : JSON.stringify(patch));
  });
  const auth = { authorization: 'Bearer settings-test-key' };
  try {
    assert.equal((await request('/api/v1/preferences', { dense: true })).status, 403);
    assert.equal((await request('/api/v1/preferences', { dense: true }, { authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await request('/api/v1/preferences', { dense: true }, { ...auth, origin: 'http://evil.example' })).status, 403);
    assert.equal((await request('/api/v1/preferences', { dense: true }, { ...auth, origin: 'bad-origin' })).status, 403);
    for (const patch of [{ unlockCode: 'anything' }, { remoteAccess: 'full' }, { themeOverride: 'bad' }, { customOrders: JSON.parse('{"__proto__":[]}') }]) {
      assert.equal((await request('/api/v1/preferences', patch, auth)).status, 400);
    }
    assert.equal((await request('/api/v1/preferences', { dense: true }, auth)).status, 200);
    assert.equal((await request('/api/v1/preferences', { themeOverride: 'light' }, { host: 'localhost' })).status, 200);
    const read = await request('/api/v1/status');
    assert.equal(read.status, 200); assert.equal(read.value.ui.optionsEnabled, false);
    assert.equal(read.value.ui.sharedPreferences.value.dense, true);
    assert.equal(read.value.ui.sharedPreferences.value.themeOverride, 'light');
    assert.ok(!JSON.stringify(read.value).includes('settings-test-key'));
  } finally { await board.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
