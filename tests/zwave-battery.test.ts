import test from 'node:test';
import assert from 'node:assert/strict';
import { CheckResultSchema } from '../src/shared/contracts.js';
// @ts-ignore Operator-installed ES module.
import module, { evaluateZwaveBattery } from '../checks/custom.zwave-battery.mjs';

const now = Date.parse('2026-10-11T16:00:00Z');
const hour = 3600000;
const message = (value: unknown, time = now) => ({ payload: JSON.stringify({ value, time }), receiptAt: now, retained: true });
const config = { name: 'Laundry HVAC LCD', source: 'garage', levelTopic: 'hvac/battery', lastActiveTopic: 'hvac/lastActive', gatewayTopic: 'zwave/gateway' };
const args = { config, now, level: message(50, now - 72 * hour), lastActive: message(now - hour), gateway: message(true, now - 90 * 24 * hour) };

test('battery monitoring uses producer timestamps, accepting retained reports without inventing freshness', () => {
  const r = evaluateZwaveBattery(args);
  assert.equal(r.state, 'healthy');
  assert.equal(r.measurements.batteryPercent, 50);
  assert.equal(r.measurements.batteryReportAgeHours, 72);
  assert.equal(r.measurements.lastSeenHours, 1);
  assert.equal(r.presentation.timestamp.at, new Date(now - 72 * hour).toISOString());
  assert.match(r.reason, /50%; report 3d ago/);
  assert.ok(CheckResultSchema.safeParse(r).success);
});

test('battery thresholds distinguish early warning, replacement and Z-Wave low sentinel', () => {
  for (const [value, state] of [[100, 'healthy'], [31, 'healthy'], [30, 'warning'], [11, 'warning'], [10, 'critical'], [0, 'critical'], [255, 'critical']] as const) {
    const r = evaluateZwaveBattery({ ...args, level: message(value) });
    assert.equal(r.state, state);
    assert.ok(CheckResultSchema.safeParse(r).success);
    if (value === 255) { assert.match(r.reason, /LOW/); assert.ok(!r.reason.includes('255%')); }
  }
});

test('old battery reports warn then expire even if retained messages arrive today', () => {
  const evaluate = (days: number) => evaluateZwaveBattery({ ...args, level: message(50, now - days * 24 * hour) });
  assert.equal(evaluate(13).state, 'healthy');
  assert.equal(evaluate(14).state, 'warning');
  assert.equal(evaluate(30).state, 'unknown');
  assert.match(evaluate(30).reason, /reading expired/);
});

test('controller silence warns then becomes unknown; gateway loss cannot appear healthy', () => {
  const evaluate = (hours: number) => evaluateZwaveBattery({ ...args, lastActive: message(now - hours * hour) });
  assert.equal(evaluate(47).state, 'healthy');
  assert.equal(evaluate(48).state, 'warning');
  assert.equal(evaluate(168).state, 'unknown');
  assert.equal(evaluateZwaveBattery({ ...args, gateway: message(false) }).state, 'unknown');
  assert.equal(evaluateZwaveBattery({ ...args, gateway: null }).state, 'unknown');
  // A current battery replacement alert outranks an overdue activity warning.
  assert.equal(evaluateZwaveBattery({ ...args, level: message(10), lastActive: message(now - 49 * hour) }).state, 'critical');
});

test('missing, malformed, out-of-range and future battery/activity data stay unknown', () => {
  for (const level of [null, { payload: 'invalid' }, { payload: '{}' }, { payload: 'null' }, message(null), message('50'), message(101), message(-1), message(1.5), message(50, now + 60000)]) {
    assert.equal(evaluateZwaveBattery({ ...args, level }).state, 'unknown');
  }
  assert.equal(evaluateZwaveBattery({ ...args, lastActive: message(now + 60000) }).state, 'unknown');
  assert.equal(evaluateZwaveBattery({ ...args, lastActive: null }).state, 'unknown');
  assert.equal(evaluateZwaveBattery({ ...args, config: { ...config, criticalPercent: 50 } }).state, 'unknown');
});

test('module reads exactly the three configured topics from the existing MQTT source', async () => {
  const reads: string[] = [];
  const data: Record<string, unknown> = { 'hvac/battery': args.level, 'hvac/lastActive': args.lastActive, 'zwave/gateway': args.gateway };
  const context = { clock: { now: () => new Date(now).toISOString() }, mqtt: { latest: async ({ source, topic }: { source: string; topic: string }) => { assert.equal(source, 'garage'); reads.push(topic); return data[topic]; } } };
  assert.equal((await module.check({ config, context })).state, 'healthy');
  assert.deepEqual(reads.sort(), Object.keys(data).sort());
  context.mqtt.latest = async () => { throw new Error('Disconnected'); };
  assert.equal((await module.check({ config, context })).state, 'unknown');
});
