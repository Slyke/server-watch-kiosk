import type { Request } from 'express';
import { type Snapshot, type ServiceView, type DiagnosticIndex, type DiagnosticSection, iso } from '../shared/contracts.js';
import { createHash, timingSafeEqual } from 'node:crypto';

export const unlockVerifier = (code = '') => {
  if (code && !/^[!-~]{1,512}$/.test(code)) throw new Error('SERVICE_BOARD_UNLOCK_CODE must contain 1–512 printable non-space ASCII characters');
  const digest = code ? createHash('sha256').update(code).digest() : null;
  return {
    enabled: Boolean(digest),
    accepts: (authorization?: string): boolean => {
      const match = authorization?.match(/^Bearer ([!-~]{1,512})$/);
      return Boolean(digest && match && timingSafeEqual(digest, createHash('sha256').update(match[1]!).digest()));
    },
  };
};

export const isLocalRequest = (req: Pick<Request, 'socket' | 'headers'>): boolean => {
  // Never trust forwarded headers. Check Host too so DNS rebinding cannot expose local diagnostics.
  const address = req.socket.remoteAddress;
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? '')
    && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.headers.host ?? '');
};

export const statusOnlyPath = (method: string, path: string): boolean => ['GET', 'HEAD'].includes(method)
  && (['/', '/index.html', '/favicon.svg', '/api/v1/status', '/api/v1/status/locked', '/api/v1/access', '/livez', '/readyz'].includes(path)
    || /^\/api\/v1\/services\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}\/diagnostics(?:\/(?:checks|probes))?$/.test(path)
    || /^\/assets\/[a-zA-Z0-9_.-]+\.(js|css|svg|png|woff2?)$/.test(path));

const statusOnlyService = (service: ServiceView): ServiceView => ({
  ...service, links: [], checks: service.checks.map(({ evidence, measurements, ...check }) => check),
});

export const statusOnlySnapshot = (snapshot: Snapshot): Snapshot => ({
  ...snapshot,
  // Display summaries are intentional; raw evidence, measurements and internal URLs stay local.
  services: snapshot.services.map(statusOnlyService),
  sources: [],
  ui: { ...snapshot.ui, optionsEnabled: false, diagnosticsEnabled: true, autoDiagnostics: false, allowHotReload: false },
});

export const lockedScreenSnapshot = (snapshot: Snapshot) => ({
  ...statusOnlySnapshot(snapshot),
  diagnostics: Object.fromEntries(snapshot.services.map(service => [service.id, {
    checks: statusOnlyDiagnostics(service, 'checks'), probes: statusOnlyDiagnostics(service, 'probes'),
  }])),
});

// Build public diagnostics directly from observations. Never run discovery, fetch logs,
// call a plugin's diagnostic handler, or reuse full-access diagnostic cache entries.
export const statusOnlyDiagnostics = (service: ServiceView, kind?: string, discover = false): DiagnosticIndex | DiagnosticSection => {
  if (!kind) return { kinds: ['checks', 'probes'], pods: [], notices: [], ...(discover ? { preferred: { kind: 'checks' as const } } : {}) };
  if (kind !== 'checks' && kind !== 'probes') throw new Error('Restricted diagnostic category');
  const view = statusOnlyService(service);
  const text = kind === 'checks'
    ? JSON.stringify({ checks: view.checks, dependencies: view.dependencies }, null, 2)
    : view.checks.map((check, i) => `${check.label} · ${check.state}\n${check.reason}\n${JSON.stringify({
      observedAt: check.observedAt, lastAttempt: check.lastAttempt, completedAt: check.completedAt,
      elapsedMs: check.elapsedMs, ageMs: check.ageMs,
      evidence: (service.checks[i]!.evidence ?? []).map(({ kind, statusCode, durationMs }) => ({ kind, statusCode, durationMs })),
    }, null, 2)}`).join('\n\n');
  const truncated = Buffer.byteLength(text) > 240000;
  return { apiVersion: 1, kind, label: kind === 'checks' ? 'Check outcomes and dependencies' : 'Probe outcomes and timings',
    availability: 'available', text: truncated ? text.slice(0, 50000) : text, observedAt: iso(Date.now()), truncated };
};
