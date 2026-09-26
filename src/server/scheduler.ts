import type { Config } from './config.js';
import { builtinSchemas } from './config.js';
import { HealthEngine } from './health.js';
import { CheckResultSchema, type CheckResult, ms } from '../shared/contracts.js';
import { executeBuiltin } from './checks.js';
import type { Sources } from './sources.js';
import type { Kubernetes } from './kubernetes.js';
import type { Plugins } from './plugins.js';
import type { Logger } from './logging.js';

export class Scheduler {
  due = new Map<string, number>(); running = new Map<string, AbortController>(); epochs = new Map<string, number>();
  timer?: NodeJS.Timeout; initialized = false; active = true; failures = 0;
  constructor(readonly config: Config, readonly health: HealthEngine, readonly sources: Sources, readonly kubernetes: Kubernetes, readonly plugins: Plugins, readonly logger: Logger) {
    plugins.onInvalidate = ids => {
      for (const id of ids) { this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1); this.running.get(id)?.abort(); this.due.set(id, 0); }
      health.invalidate({ ids, reason: 'Custom module reloading; waiting for a new observation' });
    };
  }
  start = () => {
    this.initialized = true;
    if (this.config.demo.enabled) return;
    this.sources.startMqtt();
    this.timer = setInterval(this.tick, 100); this.tick();
  };
  tick = () => {
    if (!this.active) return;
    const enabledChecks = new Set(this.config.services.filter(s => s.enabled && !s.maintenance).flatMap(s => s.checks.map(c => c.id)));
    const now = performance.now();
    for (const [id, check] of Object.entries(this.config.checks)) {
      if (this.running.size >= this.config.runtime.concurrency) break;
      if (!check.enabled || !enabledChecks.has(id) || this.running.has(id) || (this.due.get(id) ?? 0) > now) continue;
      const controller = new AbortController(); this.running.set(id, controller);
      const epoch = this.epochs.get(id) ?? 0;
      this.due.set(id, now + ms(check.interval ?? this.config.runtime.interval) * (0.95 + Math.random() * 0.1));
      void this.run({ id, signal: controller.signal, epoch }).catch(() => this.logger.error('SCHEDULER_TICK_FAILED', 'Unexpected check scheduling error')).finally(() => this.running.delete(id));
    }
  };
  run = async ({ id, signal: upstream, epoch }: { id: string; signal: AbortSignal; epoch: number }) => {
    const check = this.config.checks[id]!; const started = performance.now(); const attemptedAt = Date.now();
    const signal = AbortSignal.any([upstream, AbortSignal.timeout(ms(check.timeout ?? this.config.runtime.timeout))]);
    let result: CheckResult;
    try {
      const response = builtinSchemas[check.type] ? await executeBuiltin({ check, sources: this.sources, kubernetes: this.kubernetes, signal }) : await this.plugins.execute({ check, signal });
      result = CheckResultSchema.parse(response);
    } catch {
      this.failures++; result = { state: 'unknown', reason: signal.aborted ? 'Check deadline exceeded' : 'Check unavailable or returned invalid evidence' };
      this.logger.error('CHECK_EXECUTION_FAILED', 'Check failed: ' + id);
    }
    if ((this.epochs.get(id) ?? 0) !== epoch || upstream.aborted) return;
    // Redact before retaining anything accessible to API clients.
    result = { ...result, reason: this.logger.redact(result.reason).slice(0, 1024),
      evidence: result.evidence?.map(e => ({ ...e, label: this.logger.redact(e.label).slice(0, 128), message: e.message === undefined ? undefined : this.logger.redact(e.message).slice(0, 1024) })),
      measurements: result.measurements ? Object.fromEntries(Object.entries(result.measurements).map(([key, value]) => [this.logger.redact(key), typeof value === 'string' ? this.logger.redact(value).slice(0, 128) : value])) : undefined,
      presentation: result.presentation ? { ...result.presentation, title: result.presentation.title === undefined ? undefined : this.logger.redact(result.presentation.title).slice(0, 128), text: result.presentation.text === undefined ? undefined : this.logger.redact(result.presentation.text).slice(0, 1024), icon: result.presentation.icon === undefined ? undefined : this.logger.redact(result.presentation.icon).slice(0, 8) } : undefined,
    };
    this.health.record({ id, result, attemptedAt, elapsedMs: performance.now() - started });
  };
  refresh = () => { for (const id of Object.keys(this.config.checks)) this.due.set(id, 0); this.tick(); };
  close = () => { this.active = false; if (this.timer) clearInterval(this.timer); for (const c of this.running.values()) c.abort(); };
}
