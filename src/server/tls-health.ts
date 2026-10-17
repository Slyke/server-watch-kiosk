import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import { type CheckResult, iso, ms } from '../shared/contracts.js';

export type TlsParams = { host: string; port: number; servername?: string; caFile?: string; warningBefore: string };

// Complete a diagnostic handshake so even an expired certificate can be described.
// No application bytes or credentials are sent. Authorization, identity and dates
// must all pass before this probe can report healthy (or an expiry warning).
export const tlsHealth = ({ params, signal }: { params: TlsParams; signal: AbortSignal }): Promise<CheckResult> => {
  const { host, port, caFile, warningBefore } = params;
  const identity = params.servername ?? host;
  if (signal.aborted) return Promise.resolve({ state: 'critical', reason: `TCP ${port} / TLS deadline exceeded`, observedAt: iso(Date.now()) });
  return new Promise(resolve => {
    const started = performance.now(); let connected = false; let settled = false;
    const socket = tls.connect({ host, port, servername: net.isIP(identity) ? undefined : identity,
      ca: caFile ? fs.readFileSync(caFile) : undefined, rejectUnauthorized: false, minVersion: 'TLSv1.2' });
    const finish = (result: CheckResult) => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', abort); socket.destroy();
      resolve({ ...result, observedAt: iso(Date.now()), measurements: { tcpConnected: connected, certificateValid: false, ...result.measurements },
        evidence: [{ kind: 'tls', label: 'TCP / TLS certificate', durationMs: performance.now() - started }] });
    };
    const abort = () => finish({ state: 'critical', reason: connected ? `TCP ${port} connected; TLS handshake timed out` : `TCP ${port} connection timed out` });
    socket.once('connect', () => { connected = true; });
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate(); const now = Date.now();
      const validFrom = Date.parse(cert.valid_from); const validTo = Date.parse(cert.valid_to);
      const prefix = `TCP ${port} connected; `;
      if (!cert.raw || !Number.isFinite(validFrom) || !Number.isFinite(validTo)) {
        finish({ state: 'critical', reason: prefix + 'peer certificate or validity dates unavailable' }); return;
      }
      const measurements = { validFrom: iso(validFrom), validTo: iso(validTo), expiresInDays: (validTo - now) / 86400000 };
      const fail = (reason: string) => finish({ state: 'critical', reason: prefix + reason, measurements });
      if (now >= validTo) { fail(`certificate expired ${iso(validTo)}`); return; }
      if (now < validFrom) { fail(`certificate not valid until ${iso(validFrom)}`); return; }
      if (tls.checkServerIdentity(identity, cert)) { fail('certificate hostname mismatch'); return; }
      if (!socket.authorized) {
        const error = socket.authorizationError as unknown;
        const code = typeof error === 'string' ? error : (error as NodeJS.ErrnoException)?.code;
        fail(`certificate verification failed${code && /^[A-Z0-9_]{1,80}$/.test(code) ? ` (${code})` : ''}`); return;
      }
      const expiring = validTo - now <= ms(warningBefore);
      finish({ state: expiring ? 'warning' : 'healthy',
        reason: prefix + `certificate valid; expires ${iso(validTo)} (${Math.floor((validTo - now) / 86400000)} days remaining)`,
        measurements: { ...measurements, certificateValid: true } });
    });
    socket.once('error', () => finish({ state: 'critical', reason: connected ? `TCP ${port} connected; TLS handshake failed` : `TCP ${port} connection failed` }));
    socket.once('close', () => { if (!settled) finish({ state: 'critical', reason: `TCP ${port} / TLS closed before verification` }); });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
};
