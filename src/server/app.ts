import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Config, Secrets } from './config.js';
import { HealthEngine } from './health.js';
import { Sources } from './sources.js';
import { Kubernetes } from './kubernetes.js';
import { Plugins } from './plugins.js';
import { Scheduler } from './scheduler.js';
import { Diagnostics } from './diagnostics.js';
import { Demo, demoConfig } from '../demo/fixtures.js';
import { createLogger } from './logging.js';
import { type Snapshot, iso, ms } from '../shared/contracts.js';
import { isLocalRequest, statusOnlyPath, statusOnlySnapshot, statusOnlyDiagnostics, unlockVerifier } from './access.js';
import { SharedDisplaySettings } from './display-settings.js';
import { DisplaySettingsSchema } from '../shared/display-settings.js';

export const buildInfo = () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  try { return JSON.parse(fs.readFileSync('build-info.json', 'utf8')) as { version: string; buildHash: string }; }
  catch { return { version: pkg.version as string, buildHash: process.env.BUILD_HASH ?? 'unknown' }; }
};
const querySchema = z.object({
  pod: z.string().max(256).optional(), container: z.string().max(128).optional(),
  previous: z.enum(['true', 'false']).optional(), lines: z.coerce.number().int().min(1).max(2000).optional(),
  sinceSeconds: z.coerce.number().int().min(1).max(86400).optional(), discover: z.enum(['true', 'false']).optional(),
}).strict();
export const createBoard = async ({ config: input, secrets, unlockCode = process.env.SERVICE_BOARD_UNLOCK_CODE ?? '' }: { config: Config; secrets: Secrets; unlockCode?: string }) => {
  const config = input.demo.enabled ? demoConfig({ base: input }) : input;
  const unlock = unlockVerifier(unlockCode);
  const displaySettings = new SharedDisplaySettings(config.uiDefaults, config.server.preferencesFile);
  const logger = createLogger({ secrets: { ...secrets, values: { ...secrets.values, serviceBoardUnlockCode: unlockCode } } }); const info = buildInfo();
  const kubernetesMetadata = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => k.startsWith('K8S_') && v));
  logger.info('SERVICE_BOOT_DIAGNOSTICS', 'Service Board starting', { ...info, nodeVersion: process.version, mode: config.demo.enabled ? 'demo' : 'live', ...(process.env.LOG_K8S_METADATA_ENABLED === 'true' ? {} : { kubernetes: kubernetesMetadata }) });
  const health = new HealthEngine(config); const sources = new Sources(config, secrets, logger); const kubernetes = new Kubernetes(sources);
  const plugins = new Plugins(config, sources, logger);
  await plugins.initialize();
  const scheduler = new Scheduler(config, health, sources, kubernetes, plugins, logger);
  const demo = config.demo.enabled ? new Demo(config, health) : undefined;
  const diagnostics = new Diagnostics(config, health, kubernetes, plugins, logger, demo);
  scheduler.start();
  const app = express(); const instanceId = randomUUID(); let revision = 0;
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const incoming = req.header('x-correlation-id');
    res.locals.correlationId = incoming && /^[a-f0-9-]{36}$/i.test(incoming) ? incoming : randomUUID();
    res.set({ 'x-correlation-id': res.locals.correlationId, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'" });
    if (req.path.startsWith('/api/') || req.path.endsWith('z')) res.set('cache-control', 'no-store');
    next();
  });
  app.use((req, res, next) => {
    const authorization = req.header('authorization');
    const requiresCode = !isLocalRequest(req) || config.server.localLock;
    res.locals.unlockedWithCode = requiresCode && unlock.accepts(authorization);
    res.locals.unlockAvailable = requiresCode && unlock.enabled;
    res.locals.statusOnly = requiresCode && !res.locals.unlockedWithCode;
    res.set({ 'x-service-board-access': res.locals.unlockedWithCode ? 'code' : (res.locals.statusOnly ? 'status-only' : 'full'),
      'x-service-board-unlock-available': String(res.locals.unlockAvailable) });
    res.vary('Authorization'); res.vary('Host');
    if (requiresCode && authorization !== undefined && !res.locals.unlockedWithCode) {
      res.set('cache-control', 'no-store').status(401).json({ error: 'Invalid unlock code' }); return;
    }
    if (res.locals.statusOnly && !statusOnlyPath(req.method, req.path)) {
      res.status(403).json({ error: 'This diagnostic or control requires a configured unlock code' }); return;
    }
    next();
  });
  app.use(express.json({ limit: config.server.requestLimit }));
  const probe = (name: string, ok: boolean, res: express.Response) => res.status(ok ? 200 : 500).json({ service: 'service-watcher-kiosk', probe: name, ok, ...info, correlation_id: res.locals.correlationId });
  app.get('/livez', (_req, res) => { probe('liveness', true, res); });
  app.get('/readyz', (_req, res) => { probe('readiness', scheduler.initialized, res); });
  app.get('/api/v1/access', (_req, res) => {
    res.json({ fullAccess: !res.locals.statusOnly, unlockedWithCode: res.locals.unlockedWithCode, unlockAvailable: res.locals.unlockAvailable });
  });
  app.get('/api/v1/status', (_req, res) => {
    if (demo?.scenario === 'api-disconnect') { res.status(503).json({ error: 'Simulated API disconnect', correlation_id: res.locals.correlationId }); return; }
    demo?.tick();
    const snapshot: Snapshot = { apiVersion: 1, instanceId, revision: ++revision, mode: demo ? 'demo' : 'live', generatedAt: iso(Date.now()), pollMs: ms(config.runtime.pollInterval), staleAfterMs: ms(config.runtime.staleAfter),
      services: health.services(), sources: demo ? [{ id: 'simulated', state: 'healthy', reason: 'Offline fixtures' }] : sources.snapshot(),
      ui: { ...config.uiDefaults, diagnosticsEnabled: true, allowHotReload: config.plugins.allowHotReload, sharedPreferences: displaySettings.state } };
    const encoded = JSON.stringify(logger.sanitize(res.locals.statusOnly ? statusOnlySnapshot(snapshot) : snapshot));
    if (Buffer.byteLength(encoded) > 4194304) { res.status(503).json({ error: 'Status snapshot exceeds configured capacity' }); return; }
    res.type('json').send(encoded);
  });
  const diagnose = async (req: express.Request, res: express.Response) => {
    const id = String(req.params.id); const kind = req.params.kind ? String(req.params.kind) : undefined;
    if (!config.services.some(s => s.id === id)) { res.status(404).json({ error: 'Unknown service' }); return; }
    if (kind && !['checks', 'logs', 'description', 'events', 'probes'].includes(kind)) { res.status(404).json({ error: 'Unknown diagnostic category' }); return; }
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) { res.status(400).json({ error: 'Invalid diagnostic selection or limit' }); return; }
    const controller = new AbortController(); res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    const q = parsed.data;
    try {
      if (res.locals.statusOnly) {
        const view = health.services().find(service => service.id === id);
        if (!view) { res.status(404).json({ error: 'Unknown service' }); return; }
        res.json(logger.sanitize(statusOnlyDiagnostics(view, kind, q.discover === 'true'))); return;
      }
      const result = await diagnostics.get({ request: { id, kind, ...q, previous: q.previous === 'true', discover: q.discover === 'true' }, signal: controller.signal });
      if (!controller.signal.aborted) res.json(result);
    } catch {
      if (!controller.signal.aborted) res.status(400).json({ error: 'Diagnostics unavailable, selection invalid, or request budget exceeded', correlation_id: res.locals.correlationId });
    }
  };
  app.get('/api/v1/services/:id/diagnostics', diagnose);
  app.get('/api/v1/services/:id/diagnostics/:kind', diagnose);
  app.patch('/api/v1/preferences', (req, res) => {
    if (!config.uiDefaults.optionsEnabled) { res.sendStatus(404); return; }
    const origin = req.header('origin');
    let sameOrigin = !origin;
    try { if (origin) sameOrigin = new URL(origin).host === req.get('host'); } catch { /* Reject malformed origins. */ }
    if (!req.is('application/json') || !sameOrigin || req.header('sec-fetch-site') === 'cross-site') { res.sendStatus(403); return; }
    const parsed = DisplaySettingsSchema.partial().safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Invalid display settings' }); return; }
    try { res.json(displaySettings.patch(parsed.data)); }
    catch { res.status(503).json({ error: 'Display settings could not be saved' }); }
  });
  app.get('/api/v1/runtime', (_req, res) => {
    if (!config.uiDefaults.optionsEnabled) { res.sendStatus(404); return; }
    res.json({ watching: Boolean(plugins.watcher), modules: config.plugins.enabled.map(type => ({ type, state: plugins.workers.has(type) ? 'loaded' : (plugins.errors.has(type) ? 'unavailable' : 'idle'), reason: plugins.errors.get(type) })), scenario: demo?.scenario, ...info });
  });
  app.post('/api/v1/runtime', async (req, res) => {
    if (!config.uiDefaults.optionsEnabled) { res.sendStatus(404); return; }
    const origin = req.header('origin');
    if (!req.is('application/json') || (origin && new URL(origin).host !== req.get('host')) || req.header('sec-fetch-site') === 'cross-site') { res.status(403).json({ error: 'Same-origin JSON request required' }); return; }
    const body = z.discriminatedUnion('action', [
      z.object({ action: z.literal('reloadModules') }).strict(),
      z.object({ action: z.literal('watchModules'), enabled: z.boolean() }).strict(),
      z.object({ action: z.literal('refresh') }).strict(),
      z.object({ action: z.literal('scenario'), scenario: z.enum(['mixed', 'failure', 'recovery', 'collector-disconnect', 'api-disconnect']) }).strict(),
    ]).safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: 'Invalid runtime action' }); return; }
    try {
      if (body.data.action === 'reloadModules') { if (!config.plugins.allowHotReload) { res.sendStatus(403); return; } res.json(await plugins.reload()); diagnostics.cache.clear(); return; }
      if (body.data.action === 'watchModules') { plugins.setWatching({ enabled: body.data.enabled }); }
      if (body.data.action === 'refresh') { scheduler.refresh(); demo?.tick(true); }
      if (body.data.action === 'scenario') { if (!demo) { res.sendStatus(403); return; } demo.setScenario(body.data.scenario); diagnostics.cache.clear(); }
      res.json({ ok: true, watching: Boolean(plugins.watcher) });
    } catch { res.status(503).json({ error: 'Runtime operation failed; check module files and server logs', correlation_id: res.locals.correlationId }); }
  });
  app.get('/metrics', (_req, res) => {
    const output = ['# HELP service_board_up Service Board process readiness', '# TYPE service_board_up gauge', 'service_board_up 1', '# TYPE service_board_check_failures_total counter', `service_board_check_failures_total ${scheduler.failures}`];
    if (!demo) {
      for (const service of health.services()) {
        output.push(`service_board_service_state{service="${service.id}",state="${service.state}"} 1`);
        for (const check of service.checks) if (check.ageMs !== null) output.push(`service_board_observation_age_seconds{service="${service.id}",check="${check.id}"} ${check.ageMs / 1000}`);
      }
    }
    res.type('text/plain; version=0.0.4').send(output.join('\n') + '\n');
  });
  app.use(express.static(path.resolve('dist/web'), { index: 'index.html' }));
  app.use((_req, res) => { res.status(404).json({ error: 'Not found', correlation_id: res.locals.correlationId }); });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error('API_REQUEST_FAILED', 'API request failed', res.locals.correlationId);
    if (!res.headersSent) res.status(500).json({ error: 'Request failed', correlation_id: res.locals.correlationId });
  });
  const close = async () => { scheduler.close(); diagnostics.close(); await plugins.close(); await sources.close(); };
  return { app, close, config, scheduler, health, plugins, diagnostics, demo };
};
