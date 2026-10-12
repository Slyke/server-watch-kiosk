import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SourceSchema, ConfigSchema, validateConfig } from '../src/server/config.js';
import { MqttStateHistory } from '../src/server/mqtt-state.js';
// @ts-ignore Operator-installed ES module.
import { evaluateGarage } from '../checks/custom.tasmota-state.mjs';

const source = (stateFile?: string) => {
  const parsed = SourceSchema.parse({ type: 'mqtt', url: 'mqtt://localhost', topics: ['tele', 'power', 'lwt'], stateFile,
    trackedStates: { power3: { inputs: [{ topic: 'tele', field: 'POWER3' }, { topic: 'power' }], values: ['ON', 'OFF'], availabilityTopic: 'lwt' } } });
  if (parsed.type !== 'mqtt') throw new Error('Invalid fixture');
  return parsed;
};
test('MQTT tracks brief pulses and ignores repeat telemetry, unrelated relays and retained replay', () => {
  const h = new MqttStateHistory(source());
  const send = (topic: string, payload: string, receiptAt: number, retained = false) => h.ingest({ topic, payload, receiptAt, retained });
  send('power', 'ON', 1, true); assert.equal(h.get('power3'), null);
  send('tele', '{"POWER3":"OFF","POWER1":"ON"}', 1000); assert.equal(h.get('power3')?.lastChangedAt, null);
  send('power', 'ON', 1010); send('power', 'OFF', 1020);
  assert.deepEqual(h.get('power3'), { value: 'OFF', lastChangedAt: 1020, receivedAt: 1020 });
  send('power', 'OFF', 1030); send('tele', '{"POWER3":"OFF","POWER1":"OFF"}', 1040);
  assert.equal(h.get('power3')?.lastChangedAt, 1020);
  send('power', 'ON', 1050, true); send('power', 'invalid', 1060); send('tele', 'null', 1070);
  assert.equal(h.get('power3')?.value, 'OFF');
  h.disconnect(); send('power', 'ON', 1080);
  assert.equal(h.get('power3')?.lastChangedAt, null); // No invented time for changes during gaps.
  send('power', 'OFF', 1090); assert.equal(h.get('power3')?.lastChangedAt, 1090);
  send('lwt', 'Offline', 1100); assert.equal(h.get('power3'), null);
  send('tele', '{"POWER3":"ON"}', 1110); assert.equal(h.get('power3')?.lastChangedAt, null);
});
test('MQTT change time survives restart without treating cached state as fresh', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'board-history-'));
  const config = source(path.join(directory, 'state.json'));
  try {
    const h = new MqttStateHistory(config);
    h.ingest({ topic: 'power', payload: 'OFF', receiptAt: 1000, retained: false });
    h.ingest({ topic: 'power', payload: 'ON', receiptAt: 2000, retained: false });
    const restored = new MqttStateHistory(config);
    assert.equal(restored.get('power3'), null);
    restored.ingest({ topic: 'power', payload: 'ON', receiptAt: 3000, retained: false });
    assert.equal(restored.get('power3')?.lastChangedAt, 2000);
    assert.equal(fs.statSync(config.stateFile!).mode & 0o777, 0o600);
    const changedMapping = new MqttStateHistory({ ...config, url: 'mqtt://different-device' });
    changedMapping.ingest({ topic: 'power', payload: 'ON', receiptAt: 4000, retained: false });
    assert.equal(changedMapping.get('power3')?.lastChangedAt, null);
  } finally { fs.rmSync(directory, { recursive: true }); }
});
test('garage shows only POWER3, preserves its change time, and still enforces telemetry freshness', () => {
  const args = { lwt: { payload: 'Online' }, message: { receiptAt: 100000, retained: false }, relay: { value: 'OFF', lastChangedAt: 90000 }, now: 101000 };
  const r = evaluateGarage(args);
  assert.equal(r.state, 'healthy'); assert.equal(r.presentation.timestamp.at, new Date(90000).toISOString());
  assert.ok(r.reason.includes('POWER3: OFF')); assert.ok(!JSON.stringify(r).includes('POWER1'));
  assert.equal(evaluateGarage({ ...args, now: 1000000 }).state, 'critical');
  assert.equal(evaluateGarage({ ...args, lwt: { payload: 'Offline' } }).state, 'critical');
  assert.equal(evaluateGarage({ ...args, message: { ...args.message, retained: true } }).state, 'unknown');
  assert.equal(evaluateGarage({ ...args, relay: { value: 'OFF', lastChangedAt: null } }).presentation.timestamp.at, null);
});
test('tracked MQTT state cannot name a topic outside the source allowlist', () => {
  const config = ConfigSchema.parse({ schemaVersion: 1, sources: { broker: source() } });
  if (config.sources.broker?.type !== 'mqtt') throw new Error('Invalid fixture');
  config.sources.broker.topics = ['tele'];
  assert.throws(() => validateConfig({ config, secrets: { schemaVersion: 1, values: {} } }), /Tracked topics/);
});
