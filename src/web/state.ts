import type { ServiceView, Snapshot } from '../shared/contracts.js';
import { severity } from '../shared/contracts.js';
export type Pane = { owner: 'closed' | 'auto' | 'manual'; selected: string | null; tracked: string[] };
export const sortedServices = ({ services, mode, order = [] }: { services: ServiceView[]; mode: string; order?: string[] }) => [...services].sort((a, b) => {
  if (mode === 'custom') {
    const ai = order.indexOf(a.id); const bi = order.indexOf(b.id);
    const delta = (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi);
    if (Number.isFinite(delta) && delta !== 0) return delta;
    if (ai >= 0 && bi < 0) return -1; if (bi >= 0 && ai < 0) return 1;
  }
  if (mode === 'severity') {
    const delta = severity[a.state] - severity[b.state] || b.priority - a.priority;
    if (delta) return delta;
  }
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
});
export const currentServices = ({ snapshot, elapsed, connected }: { snapshot: Snapshot; elapsed: number; connected: boolean }): ServiceView[] => snapshot.services.map(service => {
  const stale = !connected || elapsed >= snapshot.staleAfterMs || (service.state !== 'paused' && elapsed >= service.remainingMs && service.state !== 'unknown');
  const checks = service.checks.map(check => check.state !== 'paused' && (!connected || elapsed >= check.remainingMs) ? { ...check, state: 'unknown' as const, lastKnownState: check.state, reason: 'No current evidence; previous observation is historical' } : check);
  return stale && service.state !== 'paused' ? { ...service, checks, state: 'unknown', fresh: false, confirmed: false, lastKnownState: service.state, reason: !connected ? 'Connection lost; previous state is historical' : 'Observation expired; waiting for current evidence', presentation: undefined } : { ...service, checks };
});
export const automaticPane = ({ pane, services, enabled }: { pane: Pane; services: ServiceView[]; enabled: boolean }): Pane => {
  const valid = new Set(services.map(s => s.id));
  const selected = pane.selected && valid.has(pane.selected) ? pane.selected : null;
  const failures = sortedServices({ services: services.filter(s => s.state === 'critical' && s.fresh && s.confirmed), mode: 'severity' });
  if (!enabled || pane.owner === 'manual') return { ...pane, selected };
  if (pane.owner === 'closed') return failures[0] ? { owner: 'auto', selected: failures[0].id, tracked: failures.map(s => s.id) } : { ...pane, selected };
  const tracked = [...new Set([...pane.tracked.filter(id => valid.has(id)), ...failures.map(s => s.id)])];
  const unresolved = tracked.filter(id => {
    const service = services.find(s => s.id === id)!;
    return !service.fresh || !service.confirmed || service.state === 'unknown' || service.state === 'critical' || service.checks.some(c => c.confirmation?.phase === 'recovery');
  });
  if (selected && unresolved.includes(selected)) return { owner: 'auto', selected, tracked: unresolved };
  const next = failures[0]?.id ?? unresolved[0];
  return next ? { owner: 'auto', selected: next, tracked: unresolved } : { owner: 'closed', selected, tracked: [] };
};
export const moveService = ({ ids, id, before }: { ids: string[]; id: string; before: string }) => {
  if (id === before || !ids.includes(id) || !ids.includes(before)) return ids;
  const result = ids.filter(value => value !== id); result.splice(result.indexOf(before), 0, id); return result;
};
