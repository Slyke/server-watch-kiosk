import type { Config } from './config.js';
import type { HealthEngine } from './health.js';
import type { Kubernetes } from './kubernetes.js';
import type { Plugins } from './plugins.js';
import type { Demo } from '../demo/fixtures.js';
import type { Logger } from './logging.js';
import { type DiagnosticSection, type DiagnosticIndex, type PodChoice, iso, ms, severity } from '../shared/contracts.js';
import { Gate, signalWithTimeout } from './limits.js';

export type DiagnosticRequest = { id: string; kind?: string; pod?: string; container?: string; previous?: boolean; lines?: number; sinceSeconds?: number; discover?: boolean };
export class Diagnostics {
  gate: Gate;
  cache = new Map<string, { expires: number; value: DiagnosticIndex | DiagnosticSection }>();
  inflight = new Map<string, { promise: Promise<DiagnosticIndex | DiagnosticSection>; controller: AbortController; clients: number }>();
  constructor(readonly config: Config, readonly health: HealthEngine, readonly kubernetes: Kubernetes, readonly plugins: Plugins, readonly logger: Logger, readonly demo?: Demo) {
    this.gate = new Gate(config.runtime.diagnosticsConcurrency, 32);
  }
  get = async ({ request, signal }: { request: DiagnosticRequest; signal: AbortSignal }): Promise<DiagnosticIndex | DiagnosticSection> => {
    const key = JSON.stringify(request); const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;
    let entry = this.inflight.get(key);
    if (!entry) {
      const controller = new AbortController();
      const deadline = signalWithTimeout({ signal: controller.signal, timeoutMs: ms(this.config.runtime.diagnosticsBudget) });
      const promise = this.gate.run({ signal: deadline, task: async () => {
        const raw = request.kind ? await this.section({ request, signal: deadline }) : await this.index({ id: request.id, discover: request.discover ?? false, signal: deadline });
        const value = 'text' in raw ? { ...raw, text: this.logger.redact(raw.text), label: this.logger.redact(raw.label) } : { ...raw, notices: raw.notices.map(text => this.logger.redact(text)) };
        if (Buffer.byteLength(JSON.stringify(value)) > 262144) {
          if ('text' in value) { value.text = value.text.slice(0, 50000); value.truncated = true; } else throw new Error('Diagnostics metadata exceeds response limit');
        }
        if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, { value, expires: Date.now() + ms(this.config.runtime.diagnosticsCache) }); return value;
      } }).finally(() => this.inflight.delete(key));
      entry = { promise, controller, clients: 0 }; this.inflight.set(key, entry);
    }
    entry.clients++;
    const shared = entry;
    return await new Promise((resolve, reject) => {
      let finished = false;
      const done = () => { if (finished) return false; finished = true; signal.removeEventListener('abort', abort); shared.clients--; return true; };
      const abort = () => { if (!done()) return; if (!shared.clients) shared.controller.abort(); return reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      shared.promise.then(value => { if (done()) return resolve(value); }, error => { if (done()) return reject(error); });
    });
  };
  inventory = async ({ id, signal }: { id: string; signal: AbortSignal }) => {
    const service = this.config.services.find(s => s.id === id);
    if (!service) throw new Error('Unknown service');
    const pods: PodChoice[] = []; const notices: string[] = [];
    for (const ref of service.checks) {
      const check = this.config.checks[ref.id]!;
      if (!check.type.startsWith('kubernetes.')) continue;
      try {
        const inventory = await this.kubernetes.inventory({ check, signal: signalWithTimeout({ signal, timeoutMs: ms(this.config.runtime.diagnosticsTimeout) }) });
        pods.push(...this.kubernetes.choices({ checkId: ref.id, check, pods: inventory.pods }));
      } catch { notices.push('Kubernetes choices unavailable for ' + (check.label ?? ref.id)); }
    }
    return { service, pods: [...new Map(pods.map(p => [p.uid, p])).values()], notices };
  };
  index = async ({ id, discover, signal }: { id: string; discover: boolean; signal: AbortSignal }): Promise<DiagnosticIndex> => {
    if (this.demo) return this.demo.index({ id });
    const { service, pods, notices } = await this.inventory({ id, signal });
    const kube = service.checks.some(ref => this.config.checks[ref.id]!.type.startsWith('kubernetes.'));
    const kinds = new Set<DiagnosticSection['kind']>(['checks', 'probes']);
    if (kube) { kinds.add('logs'); kinds.add('description'); kinds.add('events'); }
    for (const ref of service.checks) for (const kind of this.plugins.capabilities.get(this.config.checks[ref.id]!.type) ?? []) kinds.add(kind as DiagnosticSection['kind']);
    const index: DiagnosticIndex = { kinds: [...kinds], pods, notices };
    if (!discover) return index;
    const outcomes = this.health.services().find(s => s.id === id)!;
    const failedChecks = new Set(outcomes.checks.filter(c => c.state === 'critical').map(c => c.id));
    const relevant = pods.filter(p => !failedChecks.size || failedChecks.has(p.checkId)).sort((a, b) => Number(b.unhealthy) - Number(a.unhealthy)).slice(0, 10);
    for (const pod of relevant) {
      for (const container of [...pod.containers].sort((a, b) => b.restarts - a.restarts).slice(0, 4)) {
        for (const previous of container.restarts > 0 ? [false, true] : [false]) {
          if (signal.aborted) break;
          const logs = await this.section({ request: { id, kind: 'logs', pod: pod.uid, container: container.name, previous }, signal });
          if (logs.availability === 'available' && logs.text.trim()) return { ...index, preferred: { kind: 'logs', pod: pod.uid, container: container.name, previous } };
        }
      }
    }
    if (relevant.length && !signal.aborted) {
      const description = await this.section({ request: { id, kind: 'description', pod: relevant[0]!.uid }, signal });
      if (description.availability === 'available') return { ...index, preferred: { kind: 'description', pod: relevant[0]!.uid } };
      index.notices.push('Description unavailable; showing probe evidence');
    }
    return { ...index, preferred: { kind: outcomes.checks.some(c => c.evidence?.length || c.state !== 'healthy') ? 'probes' : 'checks' } };
  };
  section = async ({ request, signal }: { request: DiagnosticRequest; signal: AbortSignal }): Promise<DiagnosticSection> => {
    const { id, kind = 'checks', pod, container, previous = false, lines = 200, sinceSeconds = 900 } = request;
    const view = this.health.services().find(s => s.id === id);
    if (!view) throw new Error('Unknown service');
    if (kind === 'checks') return { apiVersion: 1, kind: 'checks', label: 'Check outcomes and dependencies', availability: 'available', text: JSON.stringify({ checks: view.checks, dependencies: view.dependencies }, null, 2), observedAt: iso(Date.now()), truncated: false };
    if (this.demo) {
      if (pod && !this.demo.index({ id }).pods.some(p => p.uid === pod && (!container || p.containers.some(c => c.name === container)))) throw new Error('Unknown pod/container for service');
      return this.demo.diagnose({ id, kind, pod, container, previous });
    }
    const timeout = signalWithTimeout({ signal, timeoutMs: ms(this.config.runtime.diagnosticsTimeout) });
    const service = this.config.services.find(s => s.id === id)!;
    if (['logs', 'description', 'events'].includes(kind)) {
      const { pods } = await this.inventory({ id, signal: timeout });
      if (pod && !pods.some(p => p.uid === pod && (!container || p.containers.some(c => c.name === container)))) throw new Error('Unknown pod/container for service');
      const choice = pods.find(p => p.uid === pod) ?? pods[0];
      const check = choice ? this.config.checks[choice.checkId] : service.checks.map(ref => this.config.checks[ref.id]!).find(c => c.type.startsWith('kubernetes.'));
      if (check) return this.kubernetes.diagnose({ kind, check, pod: choice?.uid, container, previous, lines, sinceSeconds, signal: timeout });
    }
    const check = [...view.checks].sort((a, b) => severity[a.state] - severity[b.state]).find(c => this.plugins.capabilities.get(c.type)?.includes(kind));
    if (check) {
      try {
        const section = await this.plugins.execute({ check: this.config.checks[check.id]!, kind: 'diagnose', request: { kind }, signal: timeout }) as DiagnosticSection;
        if (section.kind !== kind) throw new Error('Wrong diagnostic kind');
        return section;
      } catch { return { apiVersion: 1, kind: kind as DiagnosticSection['kind'], label: 'Custom diagnostics', availability: timeout.aborted ? 'timeout' : 'unavailable', text: 'Custom diagnostic operation unavailable', observedAt: iso(Date.now()), truncated: false }; }
    }
    return { apiVersion: 1, kind: 'probes', label: 'Probe evidence', availability: 'available', text: view.checks.map(c => `${c.label} · ${c.state}\n${c.reason}\n${JSON.stringify(c.evidence ?? [], null, 2)}`).join('\n\n'), observedAt: iso(Date.now()), truncated: false };
  };
  close = () => { for (const entry of this.inflight.values()) entry.controller.abort(); this.cache.clear(); };
}
