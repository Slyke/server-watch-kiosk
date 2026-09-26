import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { fork, type ChildProcess } from 'node:child_process';
import { z } from 'zod';
import { type CheckConfig, type Config, builtinSchemas } from './config.js';
import { CheckResultSchema, DiagnosticSectionSchema, type CheckResult, type DiagnosticSection, iso, ms } from '../shared/contracts.js';
import { Gate } from './limits.js';
import { readHttp, jsonBody } from './network.js';
import type { Sources } from './sources.js';
import type { Logger } from './logging.js';

const metadataSchema = z.object({ event: z.literal('ready'), apiVersion: z.literal(1), type: z.string(), configSchema: z.record(z.unknown()), capabilities: z.object({ diagnostics: z.array(z.enum(['logs', 'description', 'events', 'probes'])).max(4).optional() }).strict() });
type Worker = { child: ChildProcess; gate: Gate; capabilities: string[]; generation: number };
export class Plugins {
  workers = new Map<string, Worker>(); capabilities = new Map<string, string[]>(); files = new Map<string, string>(); errors = new Map<string, string>();
  generations = new Map<string, number>(); failures = new Map<string, { count: number; retryAt: number }>();
  watcher?: fs.FSWatcher; watchTimer?: NodeJS.Timeout; reloadGate = new Gate(1, 2); closing = false; sequence = 0;
  loading = new Map<string, Promise<void>>(); reloading = false; children = new Set<ChildProcess>();
  onInvalidate: (ids: string[]) => void = () => {};
  constructor(readonly config: Config, readonly sources: Sources, readonly logger: Logger) {}
  discover = () => {
    const files = fs.existsSync(this.config.plugins.directory) ? fs.readdirSync(this.config.plugins.directory).filter(f => /\.(m?js)$/.test(f)).sort() : [];
    this.files.clear();
    for (const type of this.config.plugins.enabled) {
      if (builtinSchemas[type]) throw new Error('plugins.enabled: Built-in types are reserved');
      const matches = files.filter(file => file.replace(/\.(m?js)$/, '') === type);
      if (matches.length !== 1) throw new Error('plugins.enabled: Enabled module must have exactly one .js/.mjs file: ' + type);
      const resolved = fs.realpathSync(path.join(this.config.plugins.directory, matches[0]!));
      const root = fs.realpathSync(this.config.plugins.directory) + path.sep;
      if (!resolved.startsWith(root)) throw new Error('plugins.directory: Modules must reside within the configured directory');
      this.files.set(type, resolved);
    }
  };
  send = ({ child, message }: { child: ChildProcess; message: Record<string, unknown> }) => {
    if (!child.connected) return false;
    try { child.send(message, error => { if (error) child.kill('SIGKILL'); }); return true; }
    catch { child.kill('SIGKILL'); return false; }
  };
  load = (args: { type: string; startup?: boolean }) => {
    const existing = this.loading.get(args.type); if (existing) return existing;
    const pending = this.loadWorker(args).finally(() => this.loading.delete(args.type));
    this.loading.set(args.type, pending); return pending;
  };
  loadWorker = async ({ type, startup = false }: { type: string; startup?: boolean }) => {
    if (this.closing) return;
    const file = this.files.get(type); if (!file) throw new Error('Module file absent');
    const old = this.workers.get(type); this.workers.delete(type);
    if (old && old.child.exitCode === null && old.child.signalCode === null) {
      const ended = once(old.child, 'exit'); old.child.kill('SIGKILL'); await ended;
    }
    if (this.children.size >= this.config.runtime.concurrency) {
      const idle = [...this.workers.entries()].find(([, worker]) => worker.gate.active === 0);
      if (!idle) throw new Error('Custom worker capacity reached');
      this.workers.delete(idle[0]);
      const ended = once(idle[1].child, 'exit'); idle[1].child.kill('SIGKILL'); await ended;
    }
    const generation = (this.generations.get(type) ?? 0) + 1; this.generations.set(type, generation);
    const child = fork(new URL('./plugin-worker.mjs', import.meta.url), [file], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: ['--max-old-space-size=96'], env: { NODE_ENV: 'production', PATH: process.env.PATH } });
    this.children.add(child);
    child.once('exit', () => this.children.delete(child));
    child.on('error', () => { this.errors.set(type, 'Module worker process unavailable'); child.kill('SIGKILL'); });
    let outputBytes = 0;
    const stopNoisy = (chunk: Buffer) => { outputBytes += chunk.length; if (outputBytes > 65536) child.kill('SIGKILL'); };
    child.stdout?.on('data', stopNoisy); child.stderr?.on('data', stopNoisy);
    try {
      const metadata = await new Promise<z.infer<typeof metadataSchema>>((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); child.kill('SIGKILL'); return reject(new Error('Module import deadline exceeded')); }, ms(this.config.plugins.importTimeout));
        const cleanup = () => { clearTimeout(timer); child.off('message', message); child.off('exit', exit); child.off('error', exit); };
        const exit = () => { cleanup(); return reject(new Error('Module import failed')); };
        const message = (value: unknown) => {
          if ((value as { event?: string })?.event === 'loadError') { cleanup(); return reject(new Error('Module import failed')); }
          const result = metadataSchema.safeParse(value);
          if (!result.success) { cleanup(); return reject(new Error('Invalid module API contract')); }
          cleanup(); return resolve(result.data);
        };
        child.on('message', message); child.once('exit', exit); child.once('error', exit);
      });
      if (metadata.type !== type || !metadata.configSchema || metadata.configSchema.type !== 'object') throw new Error('Module exported type or schema does not match');
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); child.off('message', message); child.off('exit', exit); };
        const exit = () => { cleanup(); return reject(new Error('Module validation failed')); };
        const timer = setTimeout(() => { cleanup(); child.kill('SIGKILL'); return reject(new Error('Module validation deadline exceeded')); }, ms(this.config.plugins.importTimeout));
        const message = (value: any) => {
          if (value?.event !== 'validation') return;
          cleanup();
          if (!value.valid) return reject(new Error('Invalid custom parameters at checks.' + String(value.at).slice(0, 96) + '.params'));
          return resolve();
        };
        child.on('message', message); child.once('exit', exit);
        this.send({ child, message: { op: 'validate', configs: Object.entries(this.config.checks).filter(([, check]) => check.type === type).map(([id, check]) => ({ id, params: check.params })) } });
      });
      const worker = { child, gate: new Gate(1, 32), capabilities: metadata.capabilities.diagnostics ?? [], generation };
      child.on('exit', () => { if (this.workers.get(type) === worker) { this.workers.delete(type); this.errors.set(type, 'Module worker exited'); } });
      this.workers.set(type, worker); this.capabilities.set(type, worker.capabilities); this.errors.delete(type);
    } catch (err) {
      child.kill('SIGKILL');
      const message = err instanceof Error ? err.message : 'Module load failed';
      this.errors.set(type, message);
      const count = (this.failures.get(type)?.count ?? 0) + 1;
      this.failures.set(type, { count, retryAt: Date.now() + Math.min(60000, 1000 * 2 ** Math.min(count, 6)) });
      this.logger.error('PLUGIN_LOAD_FAILED', `Custom module ${type} unavailable`);
      if (startup && (message.startsWith('Invalid custom parameters') || message.startsWith('Module exported') || message === 'Invalid module API contract')) throw err;
    }
  };
  initialize = async () => {
    if (this.config.demo.enabled) return;
    this.discover();
    for (const type of this.config.plugins.enabled) await this.load({ type, startup: true });
    if (this.config.plugins.watch) this.setWatching({ enabled: true });
  };
  setWatching = ({ enabled }: { enabled: boolean }) => {
    if (enabled && !this.config.plugins.allowHotReload) throw new Error('Module hot reload disabled in config');
    this.watcher?.close(); this.watcher = undefined;
    if (this.watchTimer) clearTimeout(this.watchTimer);
    if (!enabled || this.config.demo.enabled) return;
    this.watcher = fs.watch(this.config.plugins.directory, () => {
      clearTimeout(this.watchTimer);
      this.watchTimer = setTimeout(() => { void this.reload().catch(() => this.logger.error('PLUGIN_RELOAD_FAILED', 'Module reload failed')); }, 250);
    });
    this.watcher.on('error', () => { this.watcher?.close(); this.watcher = undefined; this.logger.error('PLUGIN_WATCH_FAILED', 'Module file watcher unavailable'); });
  };
  reload = async () => {
    if (!this.config.plugins.allowHotReload) throw new Error('Module hot reload disabled');
    if (this.config.demo.enabled) return { reloaded: [], errors: {} };
    return this.reloadGate.run({ signal: AbortSignal.timeout(30000), task: async () => {
      this.reloading = true;
      try {
      await Promise.allSettled(this.loading.values());
      const ids = Object.entries(this.config.checks).filter(([, c]) => this.config.plugins.enabled.includes(c.type)).map(([id]) => id);
      this.onInvalidate(ids);
      await Promise.allSettled([...this.children].map(async child => { const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended; }));
      this.workers.clear(); this.capabilities.clear();
      this.discover();
      for (const type of this.config.plugins.enabled) await this.load({ type });
      this.failures.clear();
      return { reloaded: [...this.workers.keys()], errors: Object.fromEntries(this.errors) };
      } finally { this.reloading = false; }
    } });
  };
  helper = async ({ method, args, check, signal }: { method: string; args: any; check: CheckConfig; signal: AbortSignal }): Promise<unknown> => {
    signal.throwIfAborted();
    if (Buffer.byteLength(JSON.stringify(args)) > 32768) throw new Error('Helper request too large');
    if (method === 'secrets.get') {
      if (!check.secretRefs.includes(args.ref)) throw new Error('Undeclared secret reference');
      return this.sources.secrets.values[args.ref];
    }
    if (method.startsWith('logger.')) { this.logger.info('MODULE_LOG', String(args.message).slice(0, 1024), { type: check.type }); return null; }
    if (['postgres.query', 'prometheus.query', 'mqtt.latest'].includes(method) && ![check.source, ...check.sources].includes(args.source)) throw new Error('Undeclared source');
    if (method === 'postgres.query') return this.sources.queryPostgres({ ...args, signal });
    if (method === 'prometheus.query') return this.sources.queryPrometheus({ ...args, signal });
    if (method === 'mqtt.latest') return this.sources.latest(args);
    if (method === 'http.getJson' || method === 'graphql.query') {
      const reply = await readHttp({ url: args.url, signal, headers: { ...(method === 'graphql.query' ? { 'content-type': 'application/json' } : {}), ...args.headers }, method: method === 'graphql.query' ? 'POST' : 'GET', body: method === 'graphql.query' ? JSON.stringify({ query: args.query, variables: args.variables }) : undefined });
      const body = jsonBody({ reply });
      return method === 'graphql.query' ? body : { body, statusCode: reply.status, receivedAt: iso(Date.now()) };
    }
    throw new Error('Unknown helper');
  };
  execute = async ({ check, kind = 'check', request, signal }: { check: CheckConfig; kind?: 'check' | 'diagnose'; request?: { kind: string }; signal: AbortSignal }): Promise<CheckResult | DiagnosticSection> => {
    if (this.reloading || this.closing) throw new Error('Modules are reloading or shutting down');
    const failure = this.failures.get(check.type);
    if (failure && Date.now() < failure.retryAt) throw new Error('Module worker restarting with backoff');
    if (!this.workers.has(check.type)) await this.load({ type: check.type });
    const worker = this.workers.get(check.type);
    if (!worker) throw new Error('Module unavailable or parameters invalid');
    try {
      const output = await worker.gate.run({ signal, task: () => new Promise<CheckResult | DiagnosticSection>((resolve, reject) => {
        const id = ++this.sequence; let helpers = 0; let totalHelpers = 0; let completed = false;
        const stop = (error?: Error, value?: CheckResult | DiagnosticSection) => {
          if (completed) return; completed = true;
          signal.removeEventListener('abort', abort); worker.child.off('message', message); worker.child.off('exit', exit);
          if (error) return reject(error);
          return resolve(value!);
        };
        const abort = () => { worker.child.kill('SIGKILL'); stop(new Error('Module execution deadline exceeded')); };
        const exit = () => stop(new Error('Module worker exited'));
        const message = async (value: any) => {
          if (value?.event === 'helper' && value.requestId === id) {
            if (++helpers > 4 || ++totalHelpers > 32) { abort(); return; }
            try {
              const result = await this.helper({ method: value.method, args: value.args, check, signal });
              if (!completed && worker.child.connected) this.send({ child: worker.child, message: { op: 'helperResult', id: value.id, value: result } });
            } catch { if (!completed && worker.child.connected) this.send({ child: worker.child, message: { op: 'helperResult', id: value.id, error: 'Helper unavailable, denied, or exceeded limits' } }); }
            finally { helpers--; }
            return;
          }
          if (value?.event !== 'result' || value.id !== id) return;
          if (value.error) { stop(new Error('Custom module execution failed')); return; }
          const result = (kind === 'check' ? CheckResultSchema : DiagnosticSectionSchema).safeParse(value.value);
          if (!result.success) { stop(new Error('Invalid module result')); return; }
          stop(undefined, result.data);
        };
        worker.child.on('message', message); worker.child.once('exit', exit); signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted || this.workers.get(check.type) !== worker) { abort(); return; }
        if (!this.send({ child: worker.child, message: { op: 'run', id, kind, config: check.params, request } })) stop(new Error('Module worker unavailable'));
      }) });
      this.failures.delete(check.type);
      return output;
    } catch (err) {
      const count = (this.failures.get(check.type)?.count ?? 0) + 1;
      this.failures.set(check.type, { count, retryAt: Date.now() + Math.min(60000, 1000 * 2 ** Math.min(count, 6)) });
      throw err;
    }
  };
  close = async () => {
    this.closing = true; this.watcher?.close(); clearTimeout(this.watchTimer);
    for (const child of this.children) {
      this.send({ child, message: { op: 'dispose' } });
      const timer = setTimeout(() => child.kill('SIGKILL'), 200); timer.unref();
    }
  };
}
