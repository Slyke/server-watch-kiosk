import { KubeConfig } from '@kubernetes/client-node';
import type https from 'node:https';
import type { CheckConfig } from './config.js';
import type { Sources } from './sources.js';
import { readHttp, jsonBody, UpstreamError } from './network.js';
import { type CheckResult, type PodChoice, type DiagnosticSection, iso } from '../shared/contracts.js';
import { timestampResult } from './assertions.js';

type Resource = Record<string, any>;
const plural: Record<string, string> = { Deployment: 'deployments', StatefulSet: 'statefulsets', DaemonSet: 'daemonsets', Job: 'jobs', CronJob: 'cronjobs' };
const ownedBy = (resource: Resource, uids: Set<string>) => (resource.metadata?.ownerReferences ?? []).some((owner: Resource) => owner.controller !== false && uids.has(owner.uid));
export const evaluatePods = ({ pods, restartWarning = 5, now = Date.now() }: { pods: Resource[]; restartWarning?: number; now?: number }): CheckResult => {
  if (!pods.length) return { state: 'unknown', reason: 'No matching pods' };
  for (const pod of pods) {
    if (pod.status?.phase === 'Succeeded') continue;
    if (pod.status?.phase === 'Failed') return { state: 'critical', reason: 'Pod failed', observedAt: iso(now) };
    const statuses = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
    if (statuses.some(s => ['CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull'].includes(s.state?.waiting?.reason) || s.state?.terminated?.reason === 'OOMKilled')) return { state: 'critical', reason: 'Container cannot run or was OOM killed', observedAt: iso(now) };
    if (!pod.status?.conditions?.some((c: Resource) => c.type === 'Ready' && c.status === 'True')) return { state: 'warning', reason: 'Pod waiting for readiness or scheduling', observedAt: iso(now) };
    if (statuses.some(s => (s.restartCount ?? 0) >= restartWarning && (s.restartCount ?? 0) > 0)) return { state: 'warning', reason: 'Container restart threshold exceeded', observedAt: iso(now) };
  }
  return { state: 'healthy', reason: `All ${pods.length} pods ready or completed`, observedAt: iso(now) };
};
export const evaluateWorkload = ({ object, kind, zeroReplicas = 'paused', now = Date.now() }: { object: Resource; kind: string; zeroReplicas?: 'paused' | 'unknown'; now?: number }): CheckResult => {
  const s = object.status ?? {}; const spec = object.spec ?? {};
  const desired = kind === 'DaemonSet' ? s.desiredNumberScheduled : (spec.replicas ?? 1);
  const ready = kind === 'DaemonSet' ? (s.numberReady ?? 0) : (s.readyReplicas ?? 0);
  const available = kind === 'DaemonSet' ? (s.numberAvailable ?? 0) : (s.availableReplicas ?? ready);
  const updated = kind === 'DaemonSet' ? (s.updatedNumberScheduled ?? 0) : (s.updatedReplicas ?? 0);
  if (!Number.isFinite(desired)) return { state: 'unknown', reason: 'Workload desired count unavailable' };
  if (desired === 0) return { state: zeroReplicas, reason: 'Intentionally scaled to zero', observedAt: iso(now) };
  const result = (state: CheckResult['state'], reason: string): CheckResult => ({ state, reason, observedAt: iso(now), measurements: { desired, ready, available, updated } });
  if (ready === 0 || available === 0) return result('critical', `0/${desired} replicas available`);
  if ((s.observedGeneration ?? 0) < (object.metadata?.generation ?? 0)) return result('warning', 'Controller has not observed the current generation');
  if (s.conditions?.some((c: Resource) => c.type === 'Progressing' && c.status === 'False')) return result('critical', 'Rollout progress deadline exceeded');
  if (ready < desired || available < desired) return result('warning', `${ready}/${desired} replicas ready`);
  const onDelete = spec.updateStrategy?.type === 'OnDelete';
  const partition = kind === 'StatefulSet' ? (spec.updateStrategy?.rollingUpdate?.partition ?? 0) : 0;
  if (!onDelete && updated < Math.max(0, desired - partition)) return result('warning', 'Rollout in progress');
  return result('healthy', `${ready}/${desired} replicas ready`);
};
export class Kubernetes {
  clients = new Map<string, KubeConfig>();
  constructor(readonly sources: Sources) {}
  client = ({ source: id }: { source: string }) => {
    let client = this.clients.get(id); if (client) return client;
    const source = this.sources.config.sources[id];
    if (source?.type !== 'kubernetes') throw new UpstreamError('invalid');
    client = new KubeConfig();
    if (source.inCluster) client.loadFromCluster(); else client.loadFromFile(source.kubeconfigFile!);
    if (source.context) client.setCurrentContext(source.context);
    if (!client.getCurrentCluster()) throw new UpstreamError('invalid');
    const user = client.getCurrentUser();
    if (user?.exec || user?.authProvider) throw new UpstreamError('invalid'); // Static tokens/certificates keep authentication bounded.
    this.clients.set(id, client); return client;
  };
  request = async ({ source, path, signal, logs = false }: { source: string; path: string; signal: AbortSignal; logs?: boolean }) => {
    const client = this.client({ source });
    const options: https.RequestOptions = {};
    await client.applyToHTTPSOptions(options);
    return this.sources.run({ id: source, signal, task: async () => {
      const reply = await readHttp({ url: client.getCurrentCluster()!.server.replace(/\/$/, '') + path, signal, options, truncate: logs });
      if ([401, 403].includes(reply.status)) throw new UpstreamError('forbidden', reply.status);
      if (reply.status === 404) throw new UpstreamError('missing', 404);
      if (reply.status !== 200) throw new UpstreamError('transport', reply.status);
      return reply;
    } });
  };
  get = async ({ source, path, signal }: { source: string; path: string; signal: AbortSignal }): Promise<Resource> => {
    const body = jsonBody({ reply: await this.request({ source, path, signal }) });
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new UpstreamError('invalid');
    return body as Resource;
  };
  list = async ({ source, path, signal }: { source: string; path: string; signal: AbortSignal }): Promise<Resource[]> => {
    const items: Resource[] = []; let continuation = '';
    for (let page = 0; page < 50; page++) {
      const suffix = new URLSearchParams({ limit: '100', ...(continuation ? { continue: continuation } : {}) });
      const response = await this.get({ source, path: path + (path.includes('?') ? '&' : '?') + suffix, signal });
      if (!Array.isArray(response.items)) throw new UpstreamError('invalid');
      items.push(...response.items); continuation = response.metadata?.continue ?? '';
      if (!continuation) return items;
    }
    throw new UpstreamError('limit');
  };
  inventory = async ({ check, signal }: { check: CheckConfig; signal: AbortSignal }): Promise<{ objects: Resource[]; pods: Resource[] }> => {
    const p = check.params as Record<string, any>; const source = check.source!;
    const config = this.sources.config.sources[source];
    if (config?.type !== 'kubernetes' || !config.namespaces.includes(p.namespace)) throw new UpstreamError('forbidden');
    const ns = encodeURIComponent(p.namespace); const core = `/api/v1/namespaces/${ns}`;
    if (check.type === 'kubernetes.pods') {
      const pods = p.names ? await Promise.all(p.names.map((name: string) => this.get({ source, path: `${core}/pods/${encodeURIComponent(name)}`, signal }))) : await this.list({ source, path: `${core}/pods?labelSelector=${encodeURIComponent(p.selector)}`, signal });
      return { objects: [], pods };
    }
    const group = check.type === 'kubernetes.job' ? 'batch/v1' : 'apps/v1';
    const object = await this.get({ source, path: `/apis/${group}/namespaces/${ns}/${plural[p.kind]}/${encodeURIComponent(p.name)}`, signal });
    if (!object.metadata?.uid) throw new UpstreamError('invalid');
    const uids = new Set<string>([object.metadata.uid]); const objects = [object];
    if (p.kind === 'Deployment') {
      const replicas = await this.list({ source, path: `/apis/apps/v1/namespaces/${ns}/replicasets`, signal });
      for (const replica of replicas.filter(r => ownedBy(r, uids))) { uids.add(replica.metadata.uid); objects.push(replica); }
    }
    if (p.kind === 'CronJob') {
      const jobs = await this.list({ source, path: `/apis/batch/v1/namespaces/${ns}/jobs`, signal });
      for (const job of jobs.filter(r => ownedBy(r, uids))) { uids.add(job.metadata.uid); objects.push(job); }
    }
    const pods = (await this.list({ source, path: core + '/pods', signal })).filter(pod => ownedBy(pod, uids));
    return { objects, pods };
  };
  check = async ({ check, signal }: { check: CheckConfig; signal: AbortSignal }): Promise<CheckResult> => {
    try {
      const p = check.params as Record<string, any>;
      const { objects, pods } = await this.inventory({ check, signal });
      if (check.type === 'kubernetes.pods') return pods.length ? evaluatePods({ pods, restartWarning: p.restartWarning }) : { state: p.empty, reason: 'No pods match configured selection', observedAt: iso(Date.now()) };
      const object = objects[0]!;
      if (check.type === 'kubernetes.job') {
        if (object.spec?.suspend) return { state: 'paused', reason: 'Job scheduling intentionally suspended', observedAt: iso(Date.now()) };
        if (object.status?.conditions?.some((c: Resource) => c.type === 'Failed' && c.status === 'True')) return { state: 'critical', reason: 'Job failed', observedAt: iso(Date.now()) };
        const completion = p.kind === 'CronJob' ? object.status?.lastSuccessfulTime : object.status?.completionTime;
        if (completion) return timestampResult({ value: completion, now: Date.now(), warningAfter: p.warningAfter, criticalAfter: p.criticalAfter });
        if (object.status?.active?.length || object.status?.active > 0) return { state: 'warning', reason: 'Job running; no completed success yet', observedAt: iso(Date.now()) };
        return { state: 'unknown', reason: 'No successful job completion recorded' };
      }
      const result = evaluateWorkload({ object, kind: p.kind, zeroReplicas: p.zeroReplicas });
      const podResult = evaluatePods({ pods, restartWarning: p.restartWarning });
      return result.state === 'healthy' && podResult.state !== 'healthy' ? podResult : result;
    } catch (err) {
      return err instanceof UpstreamError && err.category === 'missing' ? { state: 'critical', reason: 'Configured Kubernetes object is missing', observedAt: iso(Date.now()) }
        : { state: 'unknown', reason: err instanceof UpstreamError && err.category === 'forbidden' ? 'Kubernetes observer permission denied' : 'Kubernetes observer unavailable or timed out' };
    }
  };
  choices = ({ checkId, check, pods }: { checkId: string; check: CheckConfig; pods: Resource[] }): PodChoice[] => pods.filter(p => p.metadata?.uid).map(p => ({
    uid: `${check.source}:${p.metadata.uid}`, name: p.metadata.name, namespace: p.metadata.namespace, source: check.source!, checkId,
    unhealthy: evaluatePods({ pods: [p] }).state !== 'healthy',
    containers: [...(p.spec?.initContainers ?? []).map((c: Resource) => ({ ...c, init: true })), ...(p.spec?.containers ?? []).map((c: Resource) => ({ ...c, init: false }))].map(c => ({
      name: c.name, init: c.init, restarts: [...(p.status?.initContainerStatuses ?? []), ...(p.status?.containerStatuses ?? [])].find(s => s.name === c.name)?.restartCount ?? 0,
    })),
  }));
  diagnose = async ({ kind, check, pod, container, previous, lines, sinceSeconds, signal }: { kind: string; check: CheckConfig; pod?: string; container?: string; previous: boolean; lines: number; sinceSeconds: number; signal: AbortSignal }): Promise<DiagnosticSection> => {
    const make = (availability: DiagnosticSection['availability'], text: string, truncated = false): DiagnosticSection => ({ apiVersion: 1, kind: kind as DiagnosticSection['kind'], label: 'Kubernetes ' + kind, availability, text, observedAt: iso(Date.now()), truncated, previous });
    try {
      const { objects, pods } = await this.inventory({ check, signal });
      const selected = pod ? pods.find(p => `${check.source}:${p.metadata?.uid}` === pod) : pods[0];
      if (pod && !selected) return make('unavailable', 'Pod was deleted or replaced; refresh the pod choices');
      const source = check.source!; const ns = encodeURIComponent(check.params.namespace as string);
      if (kind === 'logs') {
        if (!selected) return make('empty', 'No pods available');
        const containers = [...(selected.spec?.containers ?? []), ...(selected.spec?.initContainers ?? [])];
        const name = container ?? containers[0]?.name;
        if (!containers.some(c => c.name === name)) return make('unavailable', 'Container no longer exists');
        const query = new URLSearchParams({ container: name, previous: String(previous), timestamps: 'true', tailLines: String(lines), sinceSeconds: String(sinceSeconds), limitBytes: '262144' });
        const reply = await this.request({ source, path: `/api/v1/namespaces/${ns}/pods/${encodeURIComponent(selected.metadata.name)}/log?${query}`, signal, logs: true });
        return make(reply.text.trim() ? 'available' : 'empty', reply.text, reply.truncated);
      }
      if (kind === 'events') {
        const uids = new Set([...objects, ...pods].map(p => p.metadata?.uid).filter(Boolean));
        const events = (await this.list({ source, path: `/api/v1/namespaces/${ns}/events`, signal })).filter(e => uids.has(e.involvedObject?.uid)).sort((a, b) => String(b.lastTimestamp ?? b.eventTime).localeCompare(String(a.lastTimestamp ?? a.eventTime)));
        return make(events.length ? 'available' : 'empty', events.slice(0, 100).map(e => `${e.lastTimestamp ?? e.eventTime ?? ''} ${e.reason} ×${e.count ?? 1}\n${e.message}`).join('\n\n'), events.length > 100);
      }
      const describe = (o: Resource) => ({ kind: o.kind ?? 'Pod', name: o.metadata?.name, namespace: o.metadata?.namespace, generation: o.metadata?.generation, owners: o.metadata?.ownerReferences?.map((r: Resource) => ({ kind: r.kind, name: r.name })), replicas: o.spec?.replicas, conditions: o.status?.conditions, phase: o.status?.phase,
        readyReplicas: o.status?.readyReplicas, updatedReplicas: o.status?.updatedReplicas, images: [...(o.spec?.containers ?? []), ...(o.spec?.initContainers ?? [])].map(c => ({ name: c.name, image: c.image })),
        containers: [...(o.status?.containerStatuses ?? []), ...(o.status?.initContainerStatuses ?? [])].map(c => ({ name: c.name, ready: c.ready, restarts: c.restartCount, state: c.state, lastState: c.lastState })) });
      const text = JSON.stringify([...objects.slice(0, 3), ...(selected ? [selected] : [])].map(describe), null, 2);
      return make('available', text.slice(0, 200000), text.length > 200000);
    } catch (err) {
      return make(signal.aborted ? 'timeout' : (err instanceof UpstreamError && err.category === 'forbidden' ? 'forbidden' : 'unavailable'), signal.aborted ? 'Diagnostics deadline exceeded' : 'Kubernetes evidence unavailable; check observer connectivity and read permissions');
    }
  };
}
