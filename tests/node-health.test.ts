import test from 'node:test';
import assert from 'node:assert/strict';
import { nodeHealth, retryNodePing } from '../src/server/node-health.js';
import type { CheckResult } from '../src/shared/contracts.js';

test('each master square requires both ping and API; partial failure degrades, total failure fails', () => {
  const probe = (state: CheckResult['state']): CheckResult => ({ state, reason: state });
  assert.equal(nodeHealth(probe('healthy'), probe('healthy')).state, 'healthy');
  assert.equal(nodeHealth(probe('critical'), probe('healthy')).state, 'warning');
  assert.equal(nodeHealth(probe('healthy'), probe('critical')).state, 'warning');
  assert.equal(nodeHealth(probe('warning'), probe('healthy')).state, 'warning');
  assert.equal(nodeHealth(probe('critical'), probe('critical')).state, 'critical');
  assert.equal(nodeHealth(probe('unknown'), probe('critical')).state, 'unknown');
  assert.equal(nodeHealth(probe('unknown'), probe('healthy')).state, 'warning');
  assert.equal(nodeHealth(probe('healthy')).state, 'healthy');
  assert.equal(nodeHealth(probe('critical')).state, 'critical');
});

for (const [firstState, secondState] of [
  ['warning', 'healthy'], ['critical', 'healthy'], ['warning', 'warning'],
  ['critical', 'critical'], ['warning', 'critical'], ['critical', 'unknown'],
] as const) {
  test(`node ping waits five seconds before retrying ${firstState}, then uses ${secondState}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let calls = 0;
    const result = retryNodePing({ signal: new AbortController().signal, probe: async () => {
      calls++;
      return { state: calls === 1 ? firstState : secondState, reason: `attempt ${calls}`, measurements: { latencyMs: calls === 1 ? 900 : 10 } };
    } });
    await Promise.resolve();
    assert.equal(calls, 1);
    t.mock.timers.tick(4999);
    await Promise.resolve();
    assert.equal(calls, 1);
    t.mock.timers.tick(1);
    const final = await result;
    assert.equal(calls, 2);
    assert.equal(final.state, secondState);
    assert.equal(final.measurements?.latencyMs, 10);
    assert.equal(final.measurements?.pingAttempts, 2);
    assert.equal(final.evidence?.[0]?.message, 'attempt 1');
    // A recovered master ping still cannot hide a failed API port.
    if (secondState === 'healthy') assert.equal(nodeHealth(final, { state: 'critical', reason: 'API unavailable' }).state, 'warning');
  });
}

test('healthy and unavailable node ping observations do not trigger a retry', async () => {
  for (const state of ['healthy', 'unknown'] as const) {
    let calls = 0;
    const result = await retryNodePing({ signal: new AbortController().signal, probe: async () => { calls++; return { state, reason: state }; } });
    assert.equal(calls, 1);
    assert.equal(result.state, state);
  }
});

test('cancelling a node check during the retry delay prevents another ping', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController(); let calls = 0;
  const result = retryNodePing({ signal: controller.signal, probe: async () => { calls++; return { state: 'critical', reason: '100% loss' }; } });
  await Promise.resolve();
  const rejected = assert.rejects(result, { name: 'AbortError' });
  t.mock.timers.tick(4000);
  controller.abort();
  await rejected;
  t.mock.timers.tick(10000);
  assert.equal(calls, 1);
});
