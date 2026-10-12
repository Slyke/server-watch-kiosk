import test from 'node:test';
import assert from 'node:assert/strict';
import { Kubernetes } from '../src/server/kubernetes.js';
import { UpstreamError } from '../src/server/network.js';
// @ts-ignore Operator-installed ES modules expose pure evaluators for regression coverage.
import { evaluateBitaxe } from '../checks/custom.bitaxe.mjs';
// @ts-ignore
import { evaluateGarminLog } from '../checks/custom.garmin-log.mjs';

test('Bitaxe needs new accepted shares and detects stalled mining and resets', () => {
  const now = Date.now(); const data = { hashRate: 1200, sharesAccepted: 50, uptimeSeconds: 1000, workReceived: 100 };
  const first = evaluateBitaxe(data, undefined, now); assert.equal(first.result.state, 'unknown');
  const live = evaluateBitaxe({ ...data, sharesAccepted: 51, uptimeSeconds: 1030 }, first.next, now + 30000);
  assert.equal(live.result.state, 'healthy');
  assert.equal(evaluateBitaxe({ ...data, sharesAccepted: 51, uptimeSeconds: 1630 }, live.next, now + 630000).result.state, 'critical');
  assert.equal(evaluateBitaxe({ ...data, sharesAccepted: 0, uptimeSeconds: 5 }, live.next, now + 640000).result.state, 'unknown');
  assert.equal(evaluateBitaxe({ ...data, miningPaused: true }, first.next, now + 1000).result.state, 'critical');
});
test('Garmin freshness uses successful database writes rather than polling activity', () => {
  const now = Date.parse('2026-10-11T14:00:00Z');
  const line = (time: string) => `${time} INFO Success : updated influxDB database with new points`;
  assert.equal(evaluateGarminLog(line('2026-10-11T13:30:00Z'), now).state, 'healthy');
  assert.equal(evaluateGarminLog(line('2026-10-10T17:00:00Z'), now).state, 'warning');
  assert.equal(evaluateGarminLog(line('2026-10-10T13:00:00Z'), now).state, 'critical');
  assert.equal(evaluateGarminLog('2026-10-11T13:59:00Z No new data found', now).state, 'unknown');
  assert.equal(evaluateGarminLog('2026-10-10T13:59:00Z No new data found', now).state, 'critical');
  assert.equal(evaluateGarminLog(line('2026-10-12T13:00:00Z'), now).state, 'unknown');
});

test('Kubernetes retries oversized pages without losing continuation or repeating items', async () => {
  const kube = new Kubernetes({} as any); const requests: URLSearchParams[] = [];
  kube.get = async ({ path }) => {
    const query = new URL('https://cluster' + path).searchParams; requests.push(query);
    if (Number(query.get('limit')) > 25) throw new UpstreamError('limit');
    return query.has('continue') ? { items: [{ id: 2 }], metadata: {} } : { items: [{ id: 1 }], metadata: { continue: 'next/page' } };
  };
  const items = await kube.list({ source: 'home', path: '/pods?labelSelector=app%3Dtest', signal: new AbortController().signal });
  assert.deepEqual(items, [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(requests.map(q => q.get('limit')), ['100', '50', '25', '25']);
  assert.equal(requests.at(-1)!.get('continue'), 'next/page');
  assert.ok(requests.every(q => q.get('labelSelector') === 'app=test'));
});
