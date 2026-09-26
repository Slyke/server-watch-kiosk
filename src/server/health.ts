import type { CheckConfig, Config, ServiceConfig } from './config.js';
import { type CheckResult, type CheckView, type State, type ServiceView, ms, iso, severity } from '../shared/contracts.js';

export type HealthRecord = {
  result: CheckResult; effective: State; criticalLatch?: boolean; lastKnownState?: State; lastSuccess?: number;
  attemptedAt: number; completedAt: number; elapsedMs: number; trustedAt?: number;
  pending?: { phase: 'failure' | 'recovery'; since: number; state: State; observation: number };
};
export const transition = ({ previous, result: input, now, attemptedAt = now, elapsedMs = 0, failureMs, recoveryMs, staleMs, futureMs }: {
  previous?: HealthRecord; result: CheckResult; now: number; attemptedAt?: number; elapsedMs?: number;
  failureMs: number; recoveryMs: number; staleMs: number; futureMs: number;
}): HealthRecord => {
  let result = { ...input };
  const observed = result.observedAt ? Date.parse(result.observedAt) : now;
  const event = result.eventAt ? Date.parse(result.eventAt) : undefined;
  if (!Number.isFinite(observed) || observed > now + futureMs || now - observed >= staleMs || (event !== undefined && (!Number.isFinite(event) || event > now + futureMs))) {
    result = { state: 'unknown', reason: 'Observation timestamp is expired or untrusted' };
  }
  const trusted = !['unknown', 'paused'].includes(result.state);
  const record: HealthRecord = { result, effective: result.state, criticalLatch: previous?.criticalLatch, attemptedAt, completedAt: now, elapsedMs, trustedAt: trusted ? observed : undefined, lastSuccess: previous?.lastSuccess, lastKnownState: previous?.lastKnownState };
  if (result.state === 'unknown') return record;
  if (result.state === 'paused') return { ...record, criticalLatch: false, lastKnownState: 'paused' };
  const continuous = previous?.trustedAt !== undefined && now - previous.trustedAt < staleMs && previous.effective !== 'unknown';
  const prior = continuous ? previous : undefined;
  if (result.state === 'critical' && prior?.effective !== 'critical') {
    const pending = prior?.pending?.phase === 'failure' ? prior.pending : { phase: 'failure' as const, since: now, state: 'critical' as const, observation: observed };
    const confirmed = failureMs === 0 || (now - pending.since >= failureMs && observed > pending.observation);
    record.effective = confirmed ? 'critical' : 'warning';
    if (!confirmed) record.pending = pending;
  } else if (result.state !== 'critical' && (prior?.effective === 'critical' || previous?.criticalLatch)) {
    const pending = prior?.pending?.phase === 'recovery' && prior.pending.state === result.state ? prior.pending : { phase: 'recovery' as const, since: now, state: result.state, observation: observed };
    const confirmed = recoveryMs === 0 || (now - pending.since >= recoveryMs && observed > pending.observation);
    record.effective = confirmed ? result.state : 'critical';
    if (!confirmed) record.pending = pending;
  }
  if (result.state === 'healthy') record.lastSuccess = now;
  record.lastKnownState = record.effective;
  record.criticalLatch = record.effective === 'critical' || (Boolean(record.pending) && Boolean(previous?.criticalLatch));
  return record;
};
export class HealthEngine {
  records = new Map<string, HealthRecord>();
  constructor(readonly config: Config) {}
  record = ({ id, result, now = Date.now(), attemptedAt = now, elapsedMs = 0 }: { id: string; result: CheckResult; now?: number; attemptedAt?: number; elapsedMs?: number }) => {
    const c = this.config.checks[id]!;
    this.records.set(id, transition({ previous: this.records.get(id), result, now, attemptedAt, elapsedMs,
      failureMs: ms(c.failureAfter ?? this.config.runtime.failureAfter), recoveryMs: ms(c.recoveryAfter ?? this.config.runtime.recoveryAfter),
      staleMs: ms(c.staleAfter ?? this.config.runtime.staleAfter), futureMs: ms(this.config.runtime.futureTolerance) }));
  };
  invalidate = ({ ids, reason }: { ids: string[]; reason: string }) => { for (const id of ids) this.record({ id, result: { state: 'unknown', reason } }); };
  check = ({ id, now }: { id: string; now: number }): CheckView => {
    const c = this.config.checks[id]!;
    const r = this.records.get(id);
    const base = { id, type: c.type, label: c.label ?? id, ageMs: null, remainingMs: 0, rawState: 'unknown' as State };
    if (!c.enabled) return { ...base, state: 'paused', rawState: 'paused', reason: 'Disabled in configuration', remainingMs: Number.MAX_SAFE_INTEGER };
    if (!r) return { ...base, state: 'unknown', reason: 'Waiting for first observation' };
    const staleMs = ms(c.staleAfter ?? this.config.runtime.staleAfter);
    const remainingMs = r.trustedAt !== undefined ? Math.max(0, r.trustedAt + staleMs - now) : 0;
    const expired = r.trustedAt !== undefined && remainingMs === 0;
    if (expired) r.pending = undefined;
    return { ...r.result, ...base, presentation: c.allowPresentation ? r.result.presentation : undefined,
      rawState: r.result.state, state: expired ? 'unknown' : r.effective,
      reason: expired ? 'Observation expired; waiting for current evidence' : (r.pending?.phase === 'failure' ? `Confirming failure: ${r.result.reason}` : r.result.reason),
      ageMs: r.trustedAt === undefined ? null : Math.max(0, now - r.trustedAt), remainingMs: r.effective === 'paused' ? Number.MAX_SAFE_INTEGER : remainingMs,
      observedAt: r.trustedAt === undefined ? undefined : iso(r.trustedAt), lastAttempt: iso(r.attemptedAt), completedAt: iso(r.completedAt),
      elapsedMs: r.elapsedMs, lastSuccess: r.lastSuccess === undefined ? undefined : iso(r.lastSuccess), lastKnownState: r.lastKnownState,
      validUntil: r.trustedAt === undefined ? undefined : iso(r.trustedAt + staleMs),
      confirmation: r.pending ? { phase: r.pending.phase, since: iso(r.pending.since), remainingMs: Math.max(0, ms(r.pending.phase === 'failure' ? (c.failureAfter ?? this.config.runtime.failureAfter) : (c.recoveryAfter ?? this.config.runtime.recoveryAfter)) - (now - r.pending.since)) } : undefined,
    };
  };
  services = ({ now = Date.now() } = {}): ServiceView[] => aggregate({ services: this.config.services, checks: Object.fromEntries(Object.keys(this.config.checks).map(id => [id, this.check({ id, now })])) });
}
export const aggregate = ({ services, checks }: { services: ServiceConfig[]; checks: Record<string, CheckView> }): ServiceView[] => {
  const output = new Map<string, ServiceView>();
  const visit = (service: ServiceConfig): ServiceView => {
    const existing = output.get(service.id); if (existing) return existing;
    const own = service.checks.map(ref => ({ ...checks[ref.id]!, required: ref.required }));
    const dependencies = service.dependsOn.map(ref => {
      const dep = visit(services.find(s => s.id === ref.serviceId)!);
      return { id: dep.id, name: dep.name, state: dep.state, required: ref.required, reason: dep.reason, fresh: dep.fresh, confirmed: dep.confirmed, remainingMs: dep.remainingMs };
    });
    const required = [...own.filter(c => c.required), ...dependencies.filter(d => d.required)];
    const optional = [...own.filter(c => !c.required), ...dependencies.filter(d => !d.required)];
    let state: State = 'unknown';
    if (required.length) {
      state = [...required].sort((a, b) => severity[a.state] - severity[b.state])[0]!.state;
      if (state === 'healthy' && required.some(r => r.state === 'paused')) state = 'warning';
      if (state === 'healthy' && optional.some(r => !['healthy', 'paused'].includes(r.state))) state = 'warning';
    }
    const paused = !service.enabled || service.maintenance;
    if (paused) state = 'paused';
    const details = [...own.map(c => ({ ...c, name: c.label })), ...dependencies].filter(r => !['healthy', 'paused'].includes(r.state));
    const reason = paused ? 'Paused in configuration' : (details.length ? details.sort((a, b) => severity[a.state] - severity[b.state]).map(r => `${r.name}: ${r.reason}`).join('; ').slice(0, 1024) : (state === 'paused' ? 'All required components intentionally paused' : (required.some(r => r.state === 'paused') ? 'A required component is paused' : `All ${own.length + dependencies.length} components passing`)));
    const fresh = paused || (state === 'critical' ? required.some(r => r.state === 'critical' && r.remainingMs > 0) : required.every(r => r.state === 'paused' || (r.remainingMs > 0 && r.state !== 'unknown')));
    const confirmed = paused || (state === 'critical' && fresh) || (fresh && own.filter(c => c.required).every(c => !c.confirmation || c.state === 'critical') && dependencies.filter(d => d.required).every(d => d.confirmed));
    const remainingMs = paused ? Number.MAX_SAFE_INTEGER : (state === 'critical' ? Math.max(...required.filter(r => r.state === 'critical').map(r => r.remainingMs)) : Math.min(...required.map(r => r.remainingMs)));
    const presentation = [...own].sort((a, b) => severity[a.state] - severity[b.state]).find(c => c.presentation)?.presentation;
    const result: ServiceView = { id: service.id, name: service.name, group: service.group, priority: service.priority, state, reason, checks: own, dependencies, fresh, confirmed, remainingMs, presentation, links: service.links };
    output.set(service.id, result); return result;
  };
  return services.map(visit);
};
export const compareServices = (a: ServiceView, b: ServiceView) => severity[a.state] - severity[b.state] || b.priority - a.priority || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
