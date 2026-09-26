import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { ConfigSchema, CheckSchema } from '../src/server/config.js';
import { createBoard } from '../src/server/app.js';
import { Sources } from '../src/server/sources.js';
import { Kubernetes } from '../src/server/kubernetes.js';
import { Plugins } from '../src/server/plugins.js';
import { createLogger } from '../src/server/logging.js';
import { executeBuiltin } from '../src/server/checks.js';
import { readHttp } from '../src/server/network.js';
import { builtinSchemas } from '../src/server/config.js';
import { KubeConfig } from '@kubernetes/client-node';

const secret = { schemaVersion: 1 as const, values: { auth: 'top-secret-value' } };
const logger = createLogger({ secrets: secret });
const listen = async (server: http.Server) => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return 'http://127.0.0.1:' + (server.address() as { port: number }).port; };
const close = async (server: http.Server) => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
test('HTTP and GraphQL contracts: redirect, auth, errors, JSON shape and stream limits', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/ready' }); res.end(); return; }
    if (req.url === '/auth') { res.writeHead(403); res.end('secret should never surface'); return; }
    if (req.url === '/fail') { res.writeHead(503); res.end(); return; }
    if (req.url === '/large') { res.writeHead(200); res.end('x'.repeat(400000)); return; }
    if (req.url === '/gql') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: { ready: true }, errors: [{ message: 'top-secret-value' }] })); return; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ready: req.headers.authorization === secret.values.auth }));
  });
  const url = await listen(server);
  const config = ConfigSchema.parse({ schemaVersion: 1 }); const sources = new Sources(config, secret, logger); const kubernetes = new Kubernetes(sources);
  const probe = async (route: string, params = {}, type = 'http') => executeBuiltin({ check: CheckSchema.parse({ type, params: builtinSchemas[type]!.parse({ url: url + route, ...params }) }), sources, kubernetes, signal: AbortSignal.timeout(2000) });
  try {
    assert.equal((await probe('/redirect')).state, 'critical');
    assert.equal((await probe('/auth')).state, 'unknown');
    assert.equal((await probe('/fail')).state, 'critical');
    assert.equal((await probe('/gql', { query: '{ ready }' }, 'graphql')).state, 'critical');
    const ready = await probe('/ready', { headerRefs: { Authorization: 'auth' }, assertions: [{ path: 'ready', operator: 'eq', value: true }] });
    assert.equal(ready.state, 'healthy'); assert.ok(!JSON.stringify(ready).includes(secret.values.auth));
    assert.equal((await probe('/ready', { assertions: [{ path: 'absent', operator: 'eq', value: true }] })).state, 'unknown');
    await assert.rejects(readHttp({ url: url + '/large', signal: AbortSignal.timeout(2000) }), /limit/);
    const truncated = await readHttp({ url: url + '/large', signal: AbortSignal.timeout(2000), truncate: true });
    assert.equal(Buffer.byteLength(truncated.text), 262144); assert.equal(truncated.truncated, true);
  } finally { await close(server); await sources.close(); }
});
test('Kubernetes owner references, pagination, scopes and read-only log selection', async () => {
  const paths: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost'); paths.push(url.pathname);
    let body: any;
    if (url.pathname.endsWith('/deployments/app')) body = { metadata: { uid: 'deployment', generation: 1 }, spec: { replicas: 1 }, status: { readyReplicas: 1, updatedReplicas: 1, availableReplicas: 1, observedGeneration: 1 } };
    else if (url.pathname.endsWith('/replicasets')) body = { items: [{ metadata: { uid: 'replica', ownerReferences: [{ uid: 'deployment', controller: true }] } }] };
    else if (url.pathname.endsWith('/pods')) body = url.searchParams.get('continue') ? { items: [{ metadata: { uid: 'wrong', name: 'app-name-imposter', namespace: 'allowed', ownerReferences: [{ uid: 'unrelated' }] }, spec: { containers: [{ name: 'app' }] } }] } : { metadata: { continue: 'next' }, items: [{ metadata: { uid: 'pod1', name: 'correct-random-name', namespace: 'allowed', ownerReferences: [{ uid: 'replica' }] }, spec: { containers: [{ name: 'app' }] }, status: { conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{ name: 'app', ready: true, restartCount: 0 }] } }] };
    else if (url.pathname.endsWith('/log')) { res.end('plain text logs'); return; }
    else { res.writeHead(404); res.end(); return; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body));
  });
  const url = await listen(server);
  const config = ConfigSchema.parse({ schemaVersion: 1, sources: { cluster: { type: 'kubernetes', kubeconfigFile: '/not-used', namespaces: ['allowed'] } } });
  const sources = new Sources(config, secret, logger); const kubernetes = new Kubernetes(sources); const kube = new KubeConfig();
  kube.loadFromOptions({ clusters: [{ name: 'cluster', server: url, skipTLSVerify: true }], users: [{ name: 'reader' }], contexts: [{ name: 'ctx', cluster: 'cluster', user: 'reader' }], currentContext: 'ctx' });
  kubernetes.clients.set('cluster', kube);
  const check = CheckSchema.parse({ type: 'kubernetes.workload', source: 'cluster', params: { namespace: 'allowed', kind: 'Deployment', name: 'app' } });
  try {
    const inventory = await kubernetes.inventory({ check, signal: AbortSignal.timeout(3000) });
    assert.deepEqual(inventory.pods.map(p => p.metadata.uid), ['pod1']);
    assert.equal((await kubernetes.check({ check, signal: AbortSignal.timeout(3000) })).state, 'healthy');
    const badPod = await kubernetes.diagnose({ check, kind: 'logs', pod: 'cluster:wrong', container: 'app', previous: false, lines: 200, sinceSeconds: 900, signal: AbortSignal.timeout(3000) });
    assert.equal(badPod.availability, 'unavailable'); assert.ok(!paths.some(p => p.endsWith('/log')));
    const allowed = await kubernetes.diagnose({ check, kind: 'logs', pod: 'cluster:pod1', container: 'app', previous: false, lines: 200, sinceSeconds: 900, signal: AbortSignal.timeout(3000) });
    assert.equal(allowed.text, 'plain text logs');
    assert.equal((await kubernetes.check({ check: { ...check, params: { ...check.params, namespace: 'forbidden' } }, signal: AbortSignal.timeout(3000) })).state, 'unknown');
  } finally { await close(server); await sources.close(); }
});
test('demo API is offline, bounded and keeps secrets out of status/metrics/probes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'board-demo-'));
  await fs.writeFile(path.join(directory, 'custom.trap.mjs'), 'throw new Error("must not import in demo");');
  const board = await createBoard({ config: ConfigSchema.parse({ schemaVersion: 1, plugins: { directory, enabled: ['custom.trap'] } }), secrets: secret });
  const server = http.createServer(board.app); const url = await listen(server);
  try {
    const status = await (await fetch(url + '/api/v1/status')).json();
    assert.equal(status.services.length, 34); assert.equal(status.mode, 'demo');
    assert.equal(status.services.find((s: any) => s.id === 'garmin').state, 'critical');
    assert.ok(!JSON.stringify(status).includes(secret.values.auth)); assert.equal(board.plugins.workers.size, 0);
    const metrics = await (await fetch(url + '/metrics')).text(); assert.ok(!metrics.includes('service_board_service_state'));
    const probe = await (await fetch(url + '/readyz')).json(); assert.equal(probe.ok, true); assert.ok(probe.correlation_id); assert.equal(probe.service, 'service-watcher-kiosk');
    assert.equal((await fetch(url + '/api/v1/services/garmin/diagnostics/logs?pod=arbitrary')).status, 400);
    assert.equal((await fetch(url + '/api/v1/services/garmin/diagnostics/logs?lines=2001')).status, 400);
    assert.equal((await fetch(url + '/api/v1/services/garmin/diagnostics/probes?url=http://example.com')).status, 400);
    assert.equal((await fetch(url + '/api/v1/runtime', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ action: 'refresh' }) })).status, 403);
    await fetch(url + '/api/v1/runtime', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'scenario', scenario: 'collector-disconnect' }) });
    assert.equal((await (await fetch(url + '/readyz')).json()).ok, true);
  } finally { await board.close(); await close(server); await fs.rm(directory, { recursive: true }); }
});
test('isolated modules survive import loops, execution loops, bad output and hot reload', { timeout: 20000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'board-modules-'));
  const definition = (body: string, properties = '') => `export default { apiVersion: 1, type: 'custom.test', configSchema: { type: 'object', additionalProperties: false, properties: { ${properties} } }, check: async ({ context }) => { ${body} } };`;
  await fs.writeFile(path.join(directory, 'custom.test.mjs'), definition("return { state: 'healthy', reason: 'v1' };"));
  await fs.writeFile(path.join(directory, 'custom.loop.mjs'), 'while(true) {}');
  const config = ConfigSchema.parse({ schemaVersion: 1, demo: { enabled: false }, plugins: { directory, enabled: ['custom.test', 'custom.loop'], allowHotReload: true, importTimeout: '300ms' }, checks: { a: { type: 'custom.test' } }, services: [{ id: 's', name: 'Service', checks: [{ id: 'a' }] }] });
  const sources = new Sources(config, secret, logger); const plugins = new Plugins(config, sources, logger);
  try {
    await plugins.initialize();
    assert.ok(plugins.errors.has('custom.loop'));
    const check = config.checks.a!;
    assert.equal((await plugins.execute({ check, signal: AbortSignal.timeout(1000) })).reason, 'v1');
    await fs.writeFile(path.join(directory, 'custom.test.mjs'), definition("return { state: 'healthy', reason: 'v2', presentation: { icon: '★' } };"));
    await plugins.reload();
    assert.equal((await plugins.execute({ check, signal: AbortSignal.timeout(1000) })).reason, 'v2');
    await fs.writeFile(path.join(directory, 'custom.test.mjs'), definition("return { state: 'healthy', reason: await context.secrets.get({ ref: 'auth' }) };"));
    await plugins.reload();
    await assert.rejects(plugins.execute({ check, signal: AbortSignal.timeout(1000) }), /execution failed/);
    await fs.writeFile(path.join(directory, 'custom.test.mjs'), definition('while(true) {}'));
    await plugins.reload();
    const start = performance.now();
    await assert.rejects(plugins.execute({ check, signal: AbortSignal.timeout(200) }), /deadline/);
    assert.ok(performance.now() - start < 1200);
    await fs.writeFile(path.join(directory, 'custom.test.mjs'), definition("return { state: 'purple', reason: 'bad' };"));
    await plugins.reload();
    await assert.rejects(plugins.execute({ check, signal: AbortSignal.timeout(1000) }), /Invalid module result/);
  } finally { await plugins.close(); await sources.close(); await fs.rm(directory, { recursive: true }); }
});
