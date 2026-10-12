import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createBoard } from '../src/server/app.js';
import { ConfigSchema } from '../src/server/config.js';
import { unlockVerifier } from '../src/server/access.js';

const code = 'test-only-unlock-code-7de58227';
const request = (url: string, route: string, headers: Record<string, string> = {}, body?: string) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }>((resolve, reject) => {
  const req = http.request(url + route, { method: body ? 'POST' : 'GET', headers: { host: 'board.lan', ...headers } }, res => {
    const chunks: Buffer[] = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    res.on('error', reject);
  });
  req.on('error', reject); req.end(body);
});

const fixture = async (unlockCode: string, localLock = false) => {
  const board = await createBoard({ config: ConfigSchema.parse({ schemaVersion: 1, demo: { enabled: false },
    server: { localLock },
    checks: { check: { type: 'tcp', params: { host: '127.0.0.1', port: 1 } } },
    services: [{ id: 'service', name: 'Service', checks: [{ id: 'check' }] }],
  }), secrets: { schemaVersion: 1, values: {} }, unlockCode });
  board.scheduler.close();
  board.health.record({ id: 'check', result: { state: 'healthy', reason: 'Ready', evidence: [{ kind: 'http', label: 'private-probe-label', message: 'Evidence ' + code, durationMs: 125, statusCode: 200 }], measurements: { private: 'private-measurement' } } });
  const server = http.createServer(board.app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { board, url: 'http://127.0.0.1:' + (server.address() as { port: number }).port,
    close: async () => { await board.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
};

test('only the correct configured code grants full LAN diagnostics and runtime access', async () => {
  const f = await fixture(code);
  try {
    const anonymous = await request(f.url, '/api/v1/status');
    assert.equal(anonymous.status, 200); assert.equal(anonymous.headers['x-service-board-access'], 'status-only');
    assert.equal(JSON.parse(anonymous.text).ui.diagnosticsEnabled, true);
    assert.equal(JSON.parse(anonymous.text).ui.optionsEnabled, false);
    assert.ok(!anonymous.text.includes('Evidence'));
    assert.equal((await request(f.url, '/api/v1/runtime')).status, 403);
    const hints = await request(f.url, '/api/v1/access');
    assert.deepEqual(JSON.parse(hints.text), { fullAccess: false, unlockedWithCode: false, unlockAvailable: true });
    for (const route of ['/api/v1/access', '/api/v1/status', '/api/v1/runtime', '/api/v1/services/service/diagnostics/checks']) {
      assert.equal((await request(f.url, route, { authorization: 'Bearer incorrect' })).status, 401);
    }
    for (const headers of [{ cookie: 'unlockCode=' + code }, { 'x-forwarded-for': '127.0.0.1', 'x-forwarded-host': 'localhost' }]) {
      assert.equal((await request(f.url, '/api/v1/runtime?unlockCode=' + code, headers)).status, 403);
    }
    const auth = { authorization: 'Bearer ' + code };
    const full = await request(f.url, '/api/v1/status', auth);
    assert.equal(full.status, 200); assert.equal(full.headers['x-service-board-access'], 'code');
    assert.equal(full.headers['cache-control'], 'no-store'); assert.match(String(full.headers.vary), /Authorization/);
    const snapshot = JSON.parse(full.text);
    assert.equal(snapshot.ui.diagnosticsEnabled, true); assert.equal(snapshot.ui.optionsEnabled, true);
    assert.equal(snapshot.services[0].checks[0].evidence[0].message, 'Evidence [REDACTED]');
    for (const route of ['/api/v1/access', '/api/v1/runtime', '/api/v1/services/service/diagnostics/checks', '/metrics']) {
      const response = await request(f.url, route, auth);
      assert.equal(response.status, 200, route); assert.ok(!response.text.includes(code));
    }
    const refresh = JSON.stringify({ action: 'refresh' });
    assert.equal((await request(f.url, '/api/v1/runtime', { ...auth, 'content-type': 'application/json', origin: 'http://board.lan' }, refresh)).status, 200);
    assert.equal((await request(f.url, '/api/v1/runtime', { ...auth, 'content-type': 'application/json', origin: 'http://another-site.example' }, refresh)).status, 403);
    assert.equal((await request(f.url, '/api/v1/runtime')).status, 403, 'Removing the header removes access immediately');
  } finally { await f.close(); }
});

test('unconfigured or rotated unlock codes cannot grant access', async () => {
  for (const configured of ['', 'a-new-unlock-code-after-rotation']) {
    const f = await fixture(configured);
    try {
      assert.equal((await request(f.url, '/api/v1/runtime', { authorization: 'Bearer ' + code })).status, 401);
      const hints = JSON.parse((await request(f.url, '/api/v1/access')).text);
      assert.equal(hints.unlockAvailable, Boolean(configured)); assert.equal(hints.fullAccess, false);
      const local = await request(f.url, '/api/v1/runtime', { host: 'localhost' });
      assert.equal(local.status, 200, 'The existing localhost kiosk remains fully available');
      const localWithOldCode = await request(f.url, '/api/v1/access', { host: 'localhost', authorization: 'Bearer obsolete-code' });
      assert.equal(localWithOldCode.status, 200);
      assert.deepEqual(JSON.parse(localWithOldCode.text), { fullAccess: true, unlockedWithCode: false, unlockAvailable: false });
    } finally { await f.close(); }
  }
});

test('unlock configuration rejects values that cannot be safely transported as a header', () => {
  assert.throws(() => unlockVerifier('invalid\ncode'), /SERVICE_BOARD_UNLOCK_CODE/);
  assert.throws(() => unlockVerifier('x'.repeat(513)), /SERVICE_BOARD_UNLOCK_CODE/);
  assert.equal(unlockVerifier('').accepts('Bearer anything'), false);
  assert.equal(unlockVerifier(code).accepts('Bearer ' + code), true);
  assert.equal(unlockVerifier(code).accepts('Bearer ' + code + '-extra'), false);
});

test('local locking is opt-in and LAN locking cannot be disabled', async () => {
  assert.equal(ConfigSchema.parse({ schemaVersion: 1 }).server.localLock, false);
  assert.equal(ConfigSchema.safeParse({ schemaVersion: 1, server: { remoteAccess: 'full' } }).success, false);
  for (const configured of ['', code]) {
    const f = await fixture(configured, true);
    try {
      for (const host of ['localhost', 'board.lan']) {
        const hints = await request(f.url, '/api/v1/access', { host });
        assert.deepEqual(JSON.parse(hints.text), { fullAccess: false, unlockedWithCode: false, unlockAvailable: Boolean(configured) });
        assert.equal((await request(f.url, '/api/v1/runtime', { host })).status, 403);
        assert.equal(JSON.parse((await request(f.url, '/api/v1/status', { host })).text).ui.diagnosticsEnabled, true);
        const auth = { host, authorization: 'Bearer ' + code };
        assert.equal((await request(f.url, '/api/v1/runtime', auth)).status, configured ? 200 : 401);
        if (configured) assert.deepEqual(JSON.parse((await request(f.url, '/api/v1/access', auth)).text),
          { fullAccess: true, unlockedWithCode: true, unlockAvailable: true });
        assert.equal((await request(f.url, '/api/v1/runtime', { host })).status, 403, 'Removing the key locks access again');
      }
    } finally { await f.close(); }
  }
});

test('locked diagnostics expose only checks and safe probe metadata, without private discovery or shared cache access', async () => {
  const f = await fixture('', true);
  let privateCalls = 0;
  f.board.diagnostics.get = async () => { privateCalls++; throw new Error('Private diagnostics must not be called'); };
  try {
    for (const host of ['board.lan', 'localhost']) {
      for (const query of ['', '?discover=true', '?pod=anything&container=anything&previous=true']) {
        const index = await request(f.url, '/api/v1/services/service/diagnostics' + query, { host });
        assert.equal(index.status, 200);
        const parsed = JSON.parse(index.text);
        assert.deepEqual(parsed.kinds, ['checks', 'probes']); assert.deepEqual(parsed.pods, []);
        if (query.includes('discover')) assert.deepEqual(parsed.preferred, { kind: 'checks' });
      }
      for (const kind of ['checks', 'probes']) {
        const response = await request(f.url, '/api/v1/services/service/diagnostics/' + kind, { host });
        assert.equal(response.status, 200); assert.equal(response.headers['cache-control'], 'no-store');
        const section = JSON.parse(response.text);
        assert.equal(section.kind, kind); assert.match(section.text, /Ready/);
        for (const privateValue of ['private-probe-label', 'private-measurement', 'Evidence', code]) assert.ok(!response.text.includes(privateValue), privateValue);
        if (kind === 'probes') { assert.match(section.text, /"durationMs": 125/); assert.match(section.text, /"statusCode": 200/); }
        assert.equal((await request(f.url, '/api/v1/services/service/diagnostics/' + kind, { host, 'content-type': 'application/json' }, '{}')).status, 403);
      }
      for (const kind of ['logs', 'description', 'events', 'message', 'probes/logs', '%6cogs']) {
        assert.equal((await request(f.url, '/api/v1/services/service/diagnostics/' + kind, { host })).status, 403);
      }
    }
    assert.equal(privateCalls, 0);
  } finally { await f.close(); }
});
