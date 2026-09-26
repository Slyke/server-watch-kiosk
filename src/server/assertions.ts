import type { Assertion } from './config.js';
import { type CheckResult, ms, iso } from '../shared/contracts.js';

export const dataPath = ({ value, path }: { value: unknown; path: string }): unknown => {
  if (!path) return value;
  return path.split('.').reduce<unknown>((part, key) => part && typeof part === 'object' && Object.hasOwn(part, key) ? (part as Record<string, unknown>)[key] : undefined, value);
};
export const timestampResult = ({ value, now, warningAfter, criticalAfter, futureMs = 30000 }: { value: unknown; now: number; warningAfter?: string; criticalAfter: string; futureMs?: number }): CheckResult => {
  const time = value instanceof Date ? value.getTime() : (typeof value === 'number' ? value : (typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN));
  if (!Number.isFinite(time) || time > now + futureMs) return { state: 'unknown', reason: 'No trusted event timestamp' };
  const age = Math.max(0, now - time);
  return { state: age >= ms(criticalAfter) ? 'critical' : (warningAfter && age >= ms(warningAfter) ? 'warning' : 'healthy'),
    reason: `Last success ${(age / 3600000).toFixed(1)}h ago; limit ${criticalAfter}`, observedAt: iso(now), eventAt: iso(time), measurements: { ageHours: Number((age / 3600000).toFixed(1)) } };
};
export const assertValue = ({ value, assertions, now = Date.now() }: { value: unknown; assertions: Assertion[]; now?: number }): CheckResult => {
  const outcomes: CheckResult[] = assertions.map(a => {
    const target = dataPath({ value, path: a.path });
    if (target === undefined || target === null) return { state: 'unknown', reason: `Missing asserted field: ${a.path || 'value'}` };
    if (a.operator === 'timestamp') return timestampResult({ value: target, now, warningAfter: a.warningAfter, criticalAfter: a.criticalAfter! });
    if (a.operator !== 'eq' && (typeof target !== 'number' || !Number.isFinite(target))) return { state: 'unknown', reason: 'Expected a finite numeric value (no string coercion)' };
    const number = target as number; const expected = a.value as number;
    const passes = a.operator === 'eq' ? target === a.value
      : a.operator === 'gt' ? number > expected
      : a.operator === 'gte' ? number >= expected
      : a.operator === 'lt' ? number < expected
      : a.operator === 'lte' ? number <= expected
      : number >= a.min! && number <= a.max!;
    return { state: passes ? 'healthy' : a.failureState, reason: passes ? 'Assertions passing' : `Condition failed: ${a.path || 'value'} ${a.operator}`, observedAt: iso(now) };
  });
  return outcomes.sort((a, b) => ({ critical: 0, unknown: 1, warning: 2, healthy: 3, paused: 4 }[a.state] - { critical: 0, unknown: 1, warning: 2, healthy: 3, paused: 4 }[b.state]))[0] ?? { state: 'healthy', reason: 'Probe passed', observedAt: iso(now) };
};
