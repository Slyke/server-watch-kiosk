import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { once } from 'node:events';
import Ajv from 'ajv';
import JSON5 from 'json5';
import { ConfigSchema, validateConfig } from '../src/server/config.js';
import { CheckResultSchema } from '../src/shared/contracts.js';
import fetchModule from '../examples/plugins/custom.fetch-json.mjs';
import mqttModule from '../examples/plugins/custom.mqtt-telemetry.mjs';
import postgresModule from '../examples/plugins/custom.postgres-freshness.mjs';
import modbusModule from '../examples/plugins/custom.modbus-register.mjs';
import graphqlModule from '../examples/plugins/custom.graphql-health.mjs';
import prometheusModule from '../examples/plugins/custom.prometheus-value.mjs';
import { readRegister } from '../examples/plugins/lib/modbus-tcp.mjs';

const now = Date.parse('2026-09-25T12:00:00Z');
const clock = { now: () => new Date(now).toISOString() };
const signal = () => AbortSignal.timeout(2000);
const modules = [fetchModule, mqttModule, postgresModule, modbusModule, graphqlModule, prometheusModule];

test('example module schemas and complete lab config match runtime contracts', () => {
  const config = ConfigSchema.parse(JSON5.parse(fs.readFileSync('examples/lab/config.json5', 'utf8')));
  const secrets = JSON5.parse(fs.readFileSync('examples/lab/secrets.example.json5', 'utf8'));
  validateConfig({ config, secrets });
  const ajv = new Ajv({ strict: true, allowUnionTypes: true });
  for (const module of modules) {
    assert.equal(module.apiVersion, 1);
    const validate = ajv.compile(module.configSchema);
    const checks = Object.values(config.checks).filter(check => check.type === module.type);
    assert.ok(checks.length);
    for (const check of checks) assert.ok(validate(check.params), JSON.stringify(validate.errors));
    assert.equal(validate({ ...checks[0]!.params, unexpected: true }), false);
  }
  assert.equal(new Set(config.plugins.enabled).size, modules.length);
});

test('fetch example validates readiness, headers and payload freshness', async () => {
  let body: unknown = { ready: true, updatedAt: clock.now() }; let statusCode = 200; let headers;
  const context = { clock, secrets: { get: async ({ ref }) => { assert.equal(ref, 'token'); return 'test-token'; } },
    http: { getJson: async args => { headers = args.headers; return { body, statusCode, receivedAt: clock.now() }; } } };
  const config = { url: 'https://example.invalid/health', tokenRef: 'token', timestampPath: 'updatedAt' };
  const run = () => fetchModule.check({ config, context, signal: signal() });
  assert.equal(CheckResultSchema.parse(await run()).state, 'healthy');
  assert.equal(headers.authorization, 'Bearer test-token');
  body = { ready: false, updatedAt: clock.now() }; assert.equal((await run()).state, 'critical');
  body = { ready: 'true', updatedAt: clock.now() }; assert.equal((await run()).state, 'unknown');
  body = { ready: true, updatedAt: new Date(now - 120000).toISOString() }; assert.equal((await run()).state, 'unknown');
  statusCode = 403; assert.equal((await run()).state, 'unknown');
  statusCode = 503; assert.equal((await run()).state, 'critical');
});

test('MQTT example rejects stale/retained ambiguity and uses real producer timestamps', async () => {
  let message: any = null;
  const context = { clock, mqtt: { latest: async () => message } };
  const config = { source: 'broker', topic: 'test' };
  const run = () => mqttModule.check({ config, context });
  assert.equal((await run()).state, 'unknown');
  message = { payload: '{"temperature":42}', receiptAt: now, retained: true, epoch: 1 };
  assert.equal((await run()).state, 'unknown');
  message.retained = false; assert.equal((await run()).state, 'healthy');
  for (const [temperature, state] of [[60, 'warning'], [80, 'critical'], ['42', 'unknown']] as const) {
    message.payload = JSON.stringify({ temperature, timestamp: clock.now() }); message.retained = true;
    assert.equal((await run()).state, state);
  }
  message.payload = JSON.stringify({ temperature: 42, timestamp: new Date(now - 120000).toISOString() });
  assert.equal((await run()).state, 'unknown');
  message.payload = JSON.stringify({ temperature: 42, timestamp: new Date(now + 31000).toISOString() });
  assert.equal((await run()).state, 'unknown');
  message.payload = '{bad'; assert.equal((await run()).state, 'unknown');
});

test('Postgres example distinguishes observation time from old/null business events', async () => {
  let rows: any[] = [{ last_success_at: new Date(now - 5000).toISOString() }];
  const values = ["' OR 1=1 --"];
  const context = { clock, postgres: { query: async args => { assert.deepEqual(args.values, values); return rows; } } };
  const config = { source: 'db', query: 'SELECT last_success_at FROM service_heartbeats WHERE service = $1', values, warningSeconds: 10, criticalSeconds: 20 };
  const run = () => postgresModule.check({ config, context });
  assert.equal((await run()).state, 'healthy');
  rows = [{ last_success_at: new Date(now - 10000).toISOString() }]; assert.equal((await run()).state, 'warning');
  rows = [{ last_success_at: new Date(now - 20000).toISOString() }];
  const result = CheckResultSchema.parse(await run());
  assert.equal(result.state, 'critical'); assert.equal(result.observedAt, clock.now()); assert.equal(result.eventAt, rows[0].last_success_at);
  for (const invalid of [[], [{ last_success_at: null }], [{ last_success_at: '2026-09-25 12:00:00' }], [{ last_success_at: new Date(now + 31000).toISOString() }], [rows[0], rows[0]]]) {
    rows = invalid; assert.equal((await run()).state, 'unknown');
  }
});

test('GraphQL and Prometheus examples reject incomplete, duplicate and nonfinite evidence', async () => {
  let gql: any = { data: { health: { ready: true } } };
  const gcontext = { clock, graphql: { query: async () => gql } };
  const grun = () => graphqlModule.check({ config: { url: 'https://example.invalid', query: '{health{ready}}' }, context: gcontext, signal: signal() });
  assert.equal((await grun()).state, 'healthy');
  gql.errors = [{ message: 'partial response' }]; assert.equal((await grun()).state, 'unknown');
  gql = { data: { health: { ready: false } } }; assert.equal((await grun()).state, 'critical');
  let rows = [{ value: [now / 1000, '42'] }];
  const pcontext = { clock, prometheus: { query: async () => ({ status: 'success', data: { resultType: 'vector', result: rows } }) } };
  const prun = () => prometheusModule.check({ config: { source: 'metrics', query: 'queue_depth' }, context: pcontext });
  assert.equal((await prun()).state, 'healthy');
  for (const invalid of [[], [rows[0], rows[0]], [{ value: [now / 1000, 'NaN'] }], [{ value: [now / 1000, ''] }], [{ value: [(now - 120000) / 1000, '42'] }]]) {
    rows = invalid; assert.equal((await prun()).state, 'unknown');
  }
});

test('Modbus example handles fragmented frames, wrong IDs, exceptions, EOF and cancellation without writes', async () => {
  let mode = 'good'; const seen: number[] = []; const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    let input = Buffer.alloc(0);
    socket.on('data', chunk => {
      input = Buffer.concat([input, chunk]); if (input.length < 12) return;
      assert.equal(input.readUInt16BE(10), 1); seen.push(input[7]!);
      const response = Buffer.alloc(mode === 'exception' ? 9 : 11);
      input.copy(response, 0, 0, 7); response.writeUInt16BE(response.length - 6, 4);
      response[7] = mode === 'exception' ? (input[7]! | 0x80) : input[7]!;
      response[8] = 2; if (response.length === 11) response.writeUInt16BE(0xff9c, 9);
      if (mode === 'wrong-id') response.writeUInt16BE((input.readUInt16BE(0) + 1) % 65536, 0);
      if (mode === 'wrong-unit') response[6] = 2;
      if (mode === 'wrong-protocol') response.writeUInt16BE(1, 2);
      if (mode === 'wrong-length') response.writeUInt16BE(255, 4);
      if (mode === 'wrong-count') response[8] = 4;
      if (mode === 'hang') return;
      if (mode === 'eof') { socket.end(response.subarray(0, 8)); return; }
      socket.write(response.subarray(0, 3));
      setTimeout(() => socket.end(response.subarray(3)), 5);
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port;
  const base = { host: '127.0.0.1', port, address: 100, timeoutMs: 250 };
  try {
    assert.equal(await readRegister({ ...base, signal: signal() }), 65436);
    const result = await modbusModule.check({ config: { ...base, signed: true, scale: 0.1, functionCode: 3 }, context: { clock }, signal: signal() });
    assert.equal(CheckResultSchema.parse(result).measurements?.value, -10);
    assert.equal((await modbusModule.diagnose({ config: base, context: { clock }, signal: signal() })).availability, 'available');
    for (mode of ['wrong-id', 'wrong-unit', 'wrong-protocol', 'wrong-length', 'wrong-count', 'exception', 'eof']) await assert.rejects(readRegister({ ...base, signal: signal() }));
    mode = 'hang';
    const controller = new AbortController(); const pending = readRegister({ ...base, signal: controller.signal });
    controller.abort(); await assert.rejects(pending, /canceled/);
    await assert.rejects(readRegister({ ...base, timeoutMs: 30 }), /timed out/);
    await assert.rejects(readRegister({ ...base, functionCode: 6 }), /Invalid/);
    assert.ok(seen.every(value => value === 3 || value === 4));
  } finally { for (const socket of sockets) socket.destroy(); server.close(); await once(server, 'close'); }
});
