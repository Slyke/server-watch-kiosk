import timers from 'node:timers/promises';
import { type CheckResult, iso } from '../shared/contracts.js';

export const retryNodePing = async ({ probe, signal }: { probe: () => Promise<CheckResult>; signal: AbortSignal }): Promise<CheckResult> => {
  signal.throwIfAborted();
  const first = await probe();
  signal.throwIfAborted();
  if (first.state !== 'warning' && first.state !== 'critical') return first;
  await timers.setTimeout(5000, undefined, { signal });
  signal.throwIfAborted();
  const second = await probe();
  signal.throwIfAborted();
  return { ...second, reason: `${second.reason} (second attempt after 5s)`,
    measurements: { ...second.measurements, pingAttempts: 2 },
    evidence: [{ kind: 'ping', label: 'First ping attempt', message: first.reason }, ...(second.evidence ?? [])],
  };
};

export const nodeHealth = (ping: CheckResult, api?: CheckResult, apiPort = 6443): CheckResult => {
  if (!api) return ping;
  const probes = [ping, api];
  const state = probes.every(p => p.state === 'healthy') ? 'healthy'
    : probes.every(p => p.state === 'critical') ? 'critical'
      : probes.some(p => p.state === 'healthy' || p.state === 'warning') ? 'warning' : 'unknown';
  return { state, reason: `Ping: ${ping.reason}; API :${apiPort}: ${api.reason}`, observedAt: iso(Date.now()),
    measurements: { pingPassing: ping.state === 'healthy', apiPassing: api.state === 'healthy', ...(ping.measurements ?? {}) },
    evidence: [{ kind: 'ping', label: 'Node ping', message: ping.reason }, { kind: 'tcp', label: `API :${apiPort}`, message: api.reason }],
  };
};
