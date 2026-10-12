import type { Request } from 'express';
import type { Snapshot } from '../shared/contracts.js';
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
  && (['/', '/index.html', '/favicon.svg', '/api/v1/status', '/api/v1/access', '/livez', '/readyz'].includes(path)
    || /^\/assets\/[a-zA-Z0-9_.-]+\.(js|css|svg|png|woff2?)$/.test(path));

export const statusOnlySnapshot = (snapshot: Snapshot): Snapshot => ({
  ...snapshot,
  // Display summaries are intentional; raw evidence, measurements and internal URLs stay local.
  services: snapshot.services.map(service => ({ ...service, links: [], checks: service.checks.map(({ evidence, measurements, ...check }) => check) })),
  sources: [],
  ui: { ...snapshot.ui, optionsEnabled: false, diagnosticsEnabled: false, autoDiagnostics: false, allowHotReload: false },
});
