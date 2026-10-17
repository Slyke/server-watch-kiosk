import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { tlsHealth } from '../src/server/tls-health.js';
import { builtinSchemas } from '../src/server/config.js';
import { CheckResultSchema } from '../src/shared/contracts.js';

test('TLS probe requires a reachable port, trusted chain, matching identity and current validity', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-tls-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const openssl = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '365', '-subj', '/CN=Service Board Test CA');
  openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=localhost');
  fs.writeFileSync(path.join(dir, 'index'), '');
  fs.writeFileSync(path.join(dir, 'serial'), '01\n');
  fs.writeFileSync(path.join(dir, 'index.attr'), 'unique_subject = no\n');
  fs.writeFileSync(path.join(dir, 'ca.cnf'), `[ca]
default_ca = ca_local
[ca_local]
database = index
serial = serial
new_certs_dir = .
certificate = ca.crt
private_key = ca.key
default_md = sha256
policy = policy_local
x509_extensions = leaf
[policy_local]
commonName = supplied
[leaf]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost
`);
  const date = (days: number) => new Date(Date.now() + days * 86400000).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '');
  for (const [name, from, to] of [['valid', -1, 30], ['expiring', -1, 1], ['expired', -2, -1], ['future', 1, 30]] as const) {
    openssl('ca', '-batch', '-config', 'ca.cnf', '-in', 'server.csr', '-out', `${name}.crt`, '-startdate', date(from), '-enddate', date(to), '-notext');
  }
  const key = fs.readFileSync(path.join(dir, 'server.key'));
  const fixture = async (cert: string) => {
    let bytes = 0; const sockets = new Set<net.Socket>();
    const server = tls.createServer({ key, cert: fs.readFileSync(path.join(dir, cert + '.crt')) }, socket => {
      socket.on('data', data => { bytes += data.length; });
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.on('tlsClientError', () => {});
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = (server.address() as net.AddressInfo).port;
    return { server, port, bytes: () => bytes, close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    } };
  };
  for (const [cert, trust, servername, state, reason] of [
    ['valid', true, 'localhost', 'healthy', /certificate valid/],
    ['expiring', true, 'localhost', 'warning', /certificate valid/],
    ['expired', true, 'localhost', 'critical', /certificate expired/],
    ['future', true, 'localhost', 'critical', /certificate not valid until/],
    ['valid', true, 'wrong.example', 'critical', /hostname mismatch/],
    ['valid', false, 'localhost', 'critical', /verification failed/],
  ] as const) {
    await t.test(`${cert}, trusted=${trust}, identity=${servername}`, async () => {
      const f = await fixture(cert);
      try {
        const result = await tlsHealth({ params: { host: '127.0.0.1', port: f.port, servername, warningBefore: '14d', ...(trust ? { caFile: path.join(dir, 'ca.crt') } : {}) }, signal: AbortSignal.timeout(3000) });
        assert.equal(result.state, state); assert.match(result.reason, reason);
        assert.equal(result.measurements?.tcpConnected, true);
        assert.equal(result.measurements?.certificateValid, state !== 'critical');
        assert.equal(CheckResultSchema.safeParse(result).success, true);
        assert.equal(f.bytes(), 0, 'Certificate inspection must not send HTTP or credentials');
      } finally { await f.close(); }
    });
  }
  const closed = await fixture('valid'); const port = closed.port; await closed.close();
  const refused = await tlsHealth({ params: { host: '127.0.0.1', port, warningBefore: '14d' }, signal: AbortSignal.timeout(1000) });
  assert.equal(refused.state, 'critical'); assert.equal(refused.measurements?.tcpConnected, false);
  assert.match(refused.reason, /connection failed/);
});

test('TLS handshake timeout and pre-cancellation never leave a healthy result or an open socket', async () => {
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.resume(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const params = { host: '127.0.0.1', port: (server.address() as net.AddressInfo).port, warningBefore: '14d' };
  try {
    const controller = new AbortController();
    const result = tlsHealth({ params, signal: controller.signal });
    await once(server, 'connection'); controller.abort();
    assert.match((await result).reason, /timed out/);
    const pre = await tlsHealth({ params, signal: AbortSignal.abort() });
    assert.equal(pre.state, 'critical'); assert.match(pre.reason, /deadline/);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('TLS configuration defaults to port 443 and a two-week expiry warning, with no validation bypass', () => {
  assert.deepEqual(builtinSchemas.tls!.parse({ host: 'example.com' }), { host: 'example.com', port: 443, warningBefore: '14d' });
  assert.equal(builtinSchemas.tls!.safeParse({ host: 'example.com', rejectUnauthorized: false }).success, false);
  assert.equal(builtinSchemas.tls!.safeParse({ host: 'example.com', warningBefore: '0d' }).success, false);
});
