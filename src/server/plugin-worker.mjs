// Trusted operator code executes here, never on the API event loop.
import { pathToFileURL } from 'node:url';
import Ajv from 'ajv';
let validateConfig;
let moduleDefinition;
let current;
const pending = new Map();
let sequence = 0;
const send = (message) => {
  const encoded = JSON.stringify(message);
  if (Buffer.byteLength(encoded) > 262144) throw new Error('Module output exceeds 256 KiB');
  process.send?.(message);
};
const rpc = (method, args) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  send({ event: 'helper', id, method, args, requestId: current.id });
});
const context = {
  clock: { now: () => new Date().toISOString() },
  logger: { info: (message) => { void rpc('logger.info', { message }).catch(() => {}); }, warn: (message) => { void rpc('logger.warn', { message }).catch(() => {}); } },
  secrets: { get: (args) => rpc('secrets.get', args) },
  http: { getJson: ({ signal, ...args }) => rpc('http.getJson', args) },
  graphql: { query: ({ signal, ...args }) => rpc('graphql.query', args) },
  postgres: { query: (args) => rpc('postgres.query', args) },
  prometheus: { query: (args) => rpc('prometheus.query', args) },
  mqtt: { latest: (args) => rpc('mqtt.latest', args), state: (args) => rpc('mqtt.state', args) },
};
process.on('message', async (message) => {
  if (message.op === 'helperResult') {
    const promise = pending.get(message.id); if (!promise) return; pending.delete(message.id);
    if (message.error) return promise.reject(new Error(message.error));
    return promise.resolve(message.value);
  }
  if (message.op === 'validate') {
    const invalid = message.configs.find(item => !validateConfig(item.params));
    send({ event: 'validation', valid: !invalid, at: invalid?.id });
    return;
  }
  if (message.op === 'dispose') {
    try { await moduleDefinition?.dispose?.({ context }); } finally { process.exit(0); }
  }
  if (message.op !== 'run' || current) return;
  current = { id: message.id, controller: new AbortController() };
  try {
    if (!validateConfig(message.config)) throw new Error('Invalid module parameters');
    const handler = message.kind === 'check' ? moduleDefinition.check : moduleDefinition.diagnose;
    if (!handler) throw new Error('Module does not provide this operation');
    const value = await handler({ config: message.config, context, signal: current.controller.signal, request: message.request });
    send({ event: 'result', id: message.id, value });
  } catch { send({ event: 'result', id: message.id, error: 'Custom module execution failed' }); }
  finally { current = undefined; }
});
try {
  moduleDefinition = (await import(pathToFileURL(process.argv[2]).href)).default;
  if (!moduleDefinition || moduleDefinition.apiVersion !== 1 || typeof moduleDefinition.check !== 'function') { send({ event: 'contractError' }); process.exit(1); }
  try { validateConfig = new Ajv({ strict: true, allowUnionTypes: true }).compile(moduleDefinition.configSchema); } catch { send({ event: 'contractError' }); process.exit(1); }
  send({ event: 'ready', apiVersion: moduleDefinition.apiVersion, type: moduleDefinition.type, configSchema: moduleDefinition.configSchema, capabilities: moduleDefinition.capabilities ?? {} });
} catch { send({ event: 'loadError' }); process.exit(1); }
