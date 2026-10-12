import test from 'node:test';
import assert from 'node:assert/strict';
import { transition, HealthEngine, aggregate } from '../src/server/health.js';
import { ConfigSchema, validateConfig, resolveEnvironmentReferences, builtinSchemas } from '../src/server/config.js';
import { assertValue, timestampResult } from '../src/server/assertions.js';
import { CheckResultSchema, iso } from '../src/shared/contracts.js';
import { mqttResult } from '../src/server/checks.js';
import { evaluateWorkload, evaluatePods } from '../src/server/kubernetes.js';
import { automaticPane, currentServices, sortedServices, moveService } from '../src/web/state.js';
import { preferences, savePreferences } from '../src/web/preferences.js';
import { createRedactor } from '../src/server/logging.js';

const now = Date.parse('2026-09-24T12:00:00Z');
const apply = (previous: ReturnType<typeof transition> | undefined, state: 'healthy' | 'critical' | 'unknown' | 'warning', offset = 0, observation = offset) => transition({ previous, result: { state, reason: state, observedAt: iso(now + observation) }, now: now + offset, failureMs: 30000, recoveryMs: 30000, staleMs: 120000, futureMs: 30000 });
const baseConfig = () => ConfigSchema.parse({ schemaVersion: 1, demo: { enabled: false }, checks: { app: { type: 'tcp', params: { host: '127.0.0.1', port: 123 } }, db: { type: 'tcp', params: { host: '127.0.0.1', port: 124 } } }, services: [{ id: 'web', name: 'Web', checks: [{ id: 'app' }, { id: 'db' }] }] });
test('first good result is healthy, failure needs a later distinct observation', () => {
  const good = apply(undefined, 'healthy'); assert.equal(good.effective, 'healthy');
  const first = apply(good, 'critical', 1000); assert.equal(first.effective, 'warning');
  assert.equal(apply(first, 'critical', 40000, 1000).effective, 'warning');
  const failed = apply(first, 'critical', 31000); assert.equal(failed.effective, 'critical');
  const recover = apply(failed, 'healthy', 32000); assert.equal(recover.effective, 'critical');
  assert.equal(recover.pending?.phase, 'recovery');
  assert.equal(apply(recover, 'healthy', 62000).effective, 'healthy');
});
test('unknown and stale evidence interrupt confirmation continuity', () => {
  const first = apply(undefined, 'critical');
  const unknown = apply(first, 'unknown', 20000);
  assert.equal(apply(unknown, 'critical', 31000).effective, 'warning');
  assert.equal(apply(first, 'critical', 121000).effective, 'warning');
  assert.equal(apply(first, 'healthy', 130000, 0).effective, 'unknown');
  assert.equal(apply(undefined, 'healthy', 0, 30001).effective, 'unknown');
});
test('stuck checks expire independently of new completions', () => {
  const config = baseConfig(); const engine = new HealthEngine(config);
  engine.record({ id: 'app', result: { state: 'healthy', reason: 'ready', observedAt: iso(now) }, now });
  assert.equal(engine.check({ id: 'app', now: now + 120000 }).state, 'unknown');
  assert.equal(engine.check({ id: 'app', now: now + 120000 }).lastKnownState, 'healthy');
});
test('required database failure dominates ready app; optional failure caps at warning', () => {
  const config = baseConfig(); config.runtime.failureAfter = '0s';
  const engine = new HealthEngine(config);
  engine.record({ id: 'app', result: { state: 'healthy', reason: 'App ready' }, now });
  engine.record({ id: 'db', result: { state: 'critical', reason: 'Database down' }, now });
  assert.equal(engine.services({ now })[0]?.state, 'critical');
  config.services[0]!.checks[1]!.required = false;
  assert.equal(engine.services({ now })[0]?.state, 'warning');
  engine.record({ id: 'app', result: { state: 'unknown', reason: 'Observer lost' }, now });
  assert.equal(engine.services({ now })[0]?.state, 'unknown');
});
test('paused semantics, service dependencies and cycles', () => {
  const config = baseConfig(); config.runtime.failureAfter = '0s';
  config.services.push({ ...config.services[0]!, id: 'dependent', checks: [], dependsOn: [{ serviceId: 'web', required: true }] });
  const engine = new HealthEngine(config);
  engine.record({ id: 'app', result: { state: 'paused', reason: 'maintenance' }, now });
  engine.record({ id: 'db', result: { state: 'healthy', reason: 'ready' }, now });
  assert.equal(engine.services({ now })[0]?.state, 'warning');
  engine.record({ id: 'db', result: { state: 'critical', reason: 'down' }, now });
  assert.equal(engine.services({ now })[1]?.state, 'critical');
  config.services[0]!.dependsOn.push({ serviceId: 'dependent', required: true });
  assert.throws(() => validateConfig({ config, secrets: { schemaVersion: 1, values: {} } }), /cycle/);
});
test('timestamp boundaries are inclusive; missing, naive and future timestamps are unknown', () => {
  assert.equal(timestampResult({ value: now - 24 * 3600000, now, warningAfter: '20h', criticalAfter: '24h' }).state, 'critical');
  assert.equal(timestampResult({ value: now - 20 * 3600000, now, warningAfter: '20h', criticalAfter: '24h' }).state, 'warning');
  for (const value of [null, undefined, '', '2026-09-24 12:00:00', now + 30001]) assert.equal(timestampResult({ value, now, criticalAfter: '24h' }).state, 'unknown');
});
test('assertions reject missing and numeric strings; no implicit zero coercion', () => {
  const assertions = [{ path: 'value', operator: 'gt' as const, value: 0, failureState: 'critical' as const }];
  assert.equal(assertValue({ value: {}, assertions, now }).state, 'unknown');
  assert.equal(assertValue({ value: { value: '10' }, assertions, now }).state, 'unknown');
  assert.equal(assertValue({ value: { value: 0 }, assertions, now }).state, 'critical');
});
test('MQTT retained replay, producer time, LWT and sleep-aware freshness', () => {
  const check = ConfigSchema.parse({ schemaVersion: 1, checks: { x: { type: 'mqtt', params: { topic: 'tele/a', timestampPath: 'at', timestampFormat: 'rfc3339', offlineValue: 'Offline', warningAfter: '10m', criticalAfter: '15m', assertions: [] } } } }).checks.x!;
  const sample = (payload: string, retained = true) => ({ payload, retained, receiptAt: now });
  assert.equal(mqttResult({ check, telemetry: sample('{}'), lwt: null, now }).state, 'unknown');
  assert.equal(mqttResult({ check, telemetry: sample('{}', false), lwt: null, now }).state, 'unknown');
  assert.equal(mqttResult({ check, telemetry: sample(JSON.stringify({ at: iso(now - 20 * 60000) })), lwt: null, now }).state, 'critical');
  assert.equal(mqttResult({ check, telemetry: sample(JSON.stringify({ at: iso(now) }), false), lwt: null, now }).state, 'healthy');
  assert.equal(mqttResult({ check, telemetry: sample('{}', false), lwt: { payload: 'Offline' }, now }).state, 'critical');
  assert.equal(mqttResult({ check, telemetry: sample(JSON.stringify({ at: iso(now + 60000) })), lwt: null, now }).state, 'unknown');
});
test('Kubernetes rollout, partitions, zero replicas, jobs and readiness', () => {
  const object = { metadata: { generation: 2 }, spec: { replicas: 3, updateStrategy: { rollingUpdate: { partition: 2 } } }, status: { readyReplicas: 3, availableReplicas: 3, updatedReplicas: 1, observedGeneration: 2 } };
  assert.equal(evaluateWorkload({ object, kind: 'StatefulSet' }).state, 'healthy');
  assert.equal(evaluateWorkload({ object, kind: 'Deployment' }).state, 'warning');
  object.spec.replicas = 0; assert.equal(evaluateWorkload({ object, kind: 'Deployment' }).state, 'paused');
  object.spec.replicas = 3; object.status.readyReplicas = 0; assert.equal(evaluateWorkload({ object, kind: 'Deployment' }).state, 'critical');
  assert.equal(evaluatePods({ pods: [{ status: { phase: 'Succeeded' } }] }).state, 'healthy');
  assert.equal(evaluatePods({ pods: [{ status: { containerStatuses: [{ state: { waiting: { reason: 'CrashLoopBackOff' } } }] } }] }).state, 'critical');
});
test('environment references use exact whole strings and preserve defined empty strings', () => {
  assert.deepEqual(resolveEnvironmentReferences({ value: { a: '${VALUE}', b: '${MISSING}', c: 'prefix-${VALUE}', d: ['${EMPTY}'] }, env: { VALUE: ' 12 ', EMPTY: '' } }), { a: ' 12 ', b: null, c: 'prefix-${VALUE}', d: [''] });
});
test('restart warnings expire after the quiet window, without masking current faults', () => {
  const pod = (restartCount: number, ago: number) => ({ status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{ restartCount, lastState: { terminated: { finishedAt: iso(now - ago) } } }] } });
  assert.equal(evaluatePods({ pods: [pod(6, 60000)], now }).state, 'warning');
  assert.equal(evaluatePods({ pods: [pod(4, 60000)], now }).state, 'healthy');
  assert.equal(evaluatePods({ pods: [pod(6, 3600000)], now }).state, 'healthy');
  assert.equal(evaluatePods({ pods: [pod(60, 10 * 86400000)], now }).state, 'healthy');
  assert.equal(evaluatePods({ pods: [pod(6, 3600000)], restartWarningWindow: '2h', now }).state, 'warning');
  assert.equal(evaluatePods({ pods: [pod(6, -60000)], now }).state, 'healthy');
  const unready = pod(6, 10 * 86400000); unready.status.conditions = [];
  assert.equal(evaluatePods({ pods: [unready], now }).state, 'warning');
  const crashing = { status: { containerStatuses: [{ state: { waiting: { reason: 'CrashLoopBackOff' } } }] } };
  assert.equal(evaluatePods({ pods: [pod(6, 60000), crashing], now }).state, 'critical');
  assert.equal(evaluatePods({ pods: [unready, { status: { phase: 'Failed' } }], now }).state, 'critical');
});
test('restart recency uses last termination or running start, never a count alone', () => {
  const status: any = { restartCount: 6 };
  const pods = [{ status: { conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [status] } }];
  assert.equal(evaluatePods({ pods, now }).state, 'healthy');
  status.state = { running: { startedAt: iso(now - 1000) } };
  assert.equal(evaluatePods({ pods, now }).state, 'warning');
  status.lastState = { terminated: { finishedAt: iso(now - 86400000) } };
  assert.equal(evaluatePods({ pods, now }).state, 'healthy');
  for (const type of ['kubernetes.pods', 'kubernetes.workload']) {
    const params = type === 'kubernetes.pods' ? { namespace: 'test', selector: 'app=test' } : { namespace: 'test', name: 'test', kind: 'Deployment' };
    assert.equal(builtinSchemas[type]!.parse(params).restartWarningWindow, '1h');
    assert.equal(builtinSchemas[type]!.safeParse({ ...params, restartWarningWindow: '0s' }).success, false);
  }
});
test('config rejects unknown keys, bad refs, durations, source types and malformed params', () => {
  assert.throws(() => ConfigSchema.parse({ schemaVersion: 1, mystery: true }));
  const config = baseConfig(); config.checks.app!.params = { host: ';rm', port: 22 };
  assert.throws(() => validateConfig({ config, secrets: { schemaVersion: 1, values: {} } }), /params/);
  config.checks.app!.params = { host: 'localhost', port: 22 }; config.checks.app!.interval = '0s';
  assert.throws(() => validateConfig({ config, secrets: { schemaVersion: 1, values: {} } }), /positive/);
});
test('redaction removes credentials, URL queries and header material', () => {
  const redact = createRedactor({ secrets: { schemaVersion: 1, values: { password: 'example-secret' } } });
  const result = redact('example-secret Authorization: Bearer-secret https://u:p@example.test/path?api_key=hidden');
  assert.ok(!result.includes('example-secret')); assert.ok(!result.includes('Bearer-secret')); assert.ok(!result.includes('api_key=hidden')); assert.ok(!result.includes('u:p'));
});
const makeServices = () => {
  const config = baseConfig(); config.runtime.failureAfter = '0s'; const engine = new HealthEngine(config);
  engine.record({ id: 'app', result: { state: 'healthy', reason: 'ready' }, now });
  engine.record({ id: 'db', result: { state: 'critical', reason: 'down' }, now }); return engine.services({ now });
};
test('automatic pane retains unresolved stale failures and closes only on recovery', () => {
  const failed = makeServices();
  const pane = automaticPane({ pane: { owner: 'closed', selected: null, tracked: [] }, services: failed, enabled: true });
  assert.equal(pane.owner, 'auto');
  const stale = failed.map(s => ({ ...s, state: 'unknown' as const, fresh: false }));
  assert.equal(automaticPane({ pane, services: stale, enabled: true }).owner, 'auto');
  const healthy = failed.map(s => ({ ...s, state: 'healthy' as const, fresh: true, confirmed: true }));
  assert.equal(automaticPane({ pane, services: healthy, enabled: true }).owner, 'closed');
  assert.equal(automaticPane({ pane: { ...pane, owner: 'manual' }, services: healthy, enabled: true }).owner, 'manual');
});
test('custom sorting is stable and preserves incomplete named layouts', () => {
  const services = makeServices(); const more = [{ ...services[0]!, id: 'z', name: 'Zulu' }, { ...services[0]!, id: 'a', name: 'Alpha' }];
  assert.deepEqual(sortedServices({ services: more, mode: 'custom', order: ['z'] }).map(s => s.id), ['z', 'a']);
  assert.deepEqual(moveService({ ids: ['a', 'b', 'c'], id: 'c', before: 'a' }), ['c', 'a', 'b']);
});
test('preferences discard nonpresentation fields and survive blocked storage', () => {
  const defaults = { theme: 'dark', optionsEnabled: true, allowHotReload: true, autoDiagnostics: true, sortMode: 'severity', splitRatio: 0.6, customOrders: {} };
  const p = preferences({ defaults, storage: { getItem: () => JSON.stringify({ version: 1, splitRatio: 99, theme: 'light', themeOverride: 'contrast', secret: 'no', sortMode: 'custom', customOrders: { wall: ['a', 'a', 'b'] }, customOrder: 'wall' }) } });
  assert.equal(p.themeOverride, 'contrast');
  for (const themeOverride of [null, undefined, 'invalid']) {
    assert.equal(preferences({ defaults, storage: { getItem: () => JSON.stringify({ version: 1, themeOverride }) } }).themeOverride, null);
  }
  assert.equal(p.splitRatio, 0.8); assert.equal((p as any).theme, undefined); assert.equal((p as any).secret, undefined); assert.deepEqual(p.customOrders.wall, ['a', 'b']);
  assert.equal(preferences({ defaults, storage: { getItem: () => { throw new Error(); } } }).autoDiagnostics, true);
  assert.doesNotThrow(() => savePreferences({ value: p, storage: { setItem: () => { throw new Error(); } } }));
});
test('result contract rejects executable presentation and unbounded measurements', () => {
  assert.equal(CheckResultSchema.safeParse({ state: 'healthy', reason: 'x', presentation: { html: '<script>' } }).success, false);
  assert.equal(CheckResultSchema.safeParse({ state: 'healthy', reason: 'x', presentation: { background: 'url(https://evil)' } }).success, false);
});

test('an observer gap never shortcuts confirmed recovery from a critical state', () => {
  const first = apply(undefined, 'critical');
  const failed = apply(first, 'critical', 30000);
  const lost = apply(failed, 'unknown', 40000);
  const returning = apply(lost, 'healthy', 50000);
  assert.equal(returning.effective, 'critical');
  assert.equal(returning.pending?.phase, 'recovery');
  assert.equal(apply(returning, 'healthy', 80000).effective, 'healthy');
});
test('a fresh required failure remains critical when another observer is unknown', () => {
  const config = baseConfig(); config.runtime.failureAfter = '0s';
  const engine = new HealthEngine(config);
  engine.record({ id: 'app', result: { state: 'unknown', reason: 'observer unavailable' }, now });
  engine.record({ id: 'db', result: { state: 'critical', reason: 'database down' }, now });
  const service = engine.services({ now })[0]!;
  assert.equal(service.state, 'critical'); assert.equal(service.fresh, true); assert.equal(service.confirmed, true);
  assert.ok(service.remainingMs > 0);
});
