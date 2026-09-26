import net from 'node:net';
import { Resolver } from 'node:dns/promises';
import { execFile } from 'node:child_process';
import { type CheckResult, iso, ms } from '../shared/contracts.js';
import type { CheckConfig } from './config.js';
import type { Sources } from './sources.js';
import type { Kubernetes } from './kubernetes.js';
import { assertValue, dataPath, timestampResult } from './assertions.js';
import { readHttp, jsonBody, UpstreamError } from './network.js';

export const mqttResult = ({ check, telemetry, lwt, now }: { check: CheckConfig; telemetry: { payload: string; retained: boolean; receiptAt: number } | null; lwt: { payload: string } | null; now: number }): CheckResult => {
  const p = check.params;
  if (lwt?.payload === p.offlineValue) return { state: 'critical', reason: 'Device reports Offline', observedAt: iso(now), evidence: [{ kind: 'mqtt', label: 'LWT', message: 'Offline' }] };
  if (!telemetry) return { state: 'unknown', reason: 'Waiting for telemetry; Online LWT alone is insufficient' };
  let body: unknown;
  try { body = JSON.parse(telemetry.payload); } catch { body = telemetry.payload; }
  const raw = p.timestampPath ? dataPath({ value: body, path: p.timestampPath as string }) : undefined;
  if (p.timestampPath && (raw === undefined || raw === null)) return { state: 'unknown', reason: 'Configured producer timestamp is missing' };
  if (p.timestampPath && (p.timestampFormat === 'rfc3339' ? typeof raw !== 'string' : typeof raw !== 'number')) return { state: 'unknown', reason: 'Producer timestamp does not match the configured format' };
  let event = raw;
  if (p.timestampFormat === 'epochSeconds' && typeof raw === 'number') event = raw * 1000;
  if (p.timestampFormat === 'epochMilliseconds' && typeof raw === 'number') event = raw;
  if (telemetry.retained && event === undefined) return { state: 'unknown', reason: 'Retained replay has no producer timestamp; waiting for a live message' };
  const freshness = timestampResult({ value: event ?? telemetry.receiptAt, now, warningAfter: p.warningAfter as string, criticalAfter: p.criticalAfter as string });
  if (freshness.state !== 'healthy') return { ...freshness, reason: 'Telemetry: ' + freshness.reason };
  const result = assertValue({ value: body, assertions: p.assertions as never, now });
  return { ...result, eventAt: freshness.eventAt, evidence: [{ kind: 'mqtt', label: 'Telemetry', message: telemetry.retained ? 'Retained, producer timestamp validated' : 'Live message' }] };
};
export const executeBuiltin = async ({ check, sources, kubernetes, signal, sourceHeld = false }: { check: CheckConfig; sources: Sources; kubernetes: Kubernetes; signal: AbortSignal; sourceHeld?: boolean }): Promise<CheckResult> => {
  if (['http', 'graphql'].includes(check.type) && check.source && !sourceHeld) {
    const result = await sources.run({ id: check.source, signal, task: () => executeBuiltin({ check, sources, kubernetes, signal, sourceHeld: true }) });
    if (result.state === 'unknown') sources.mark({ id: check.source, state: 'unknown', reason: 'HTTP observer evidence unavailable' });
    return result;
  }
  const p = check.params as Record<string, any>; const now = Date.now();
  const success = (reason: string): CheckResult => ({ state: 'healthy', reason, observedAt: iso(Date.now()) });
  if (check.type.startsWith('kubernetes.')) return kubernetes.check({ check, signal });
  if (['http', 'graphql'].includes(check.type)) {
    const source = sources.config.sources[check.source ?? ''];
    const reusable = source?.type === 'http' ? source : undefined;
    const headers = { ...sources.headers({ values: reusable?.headers, refs: reusable?.headerRefs }), ...sources.headers({ values: p.headers, refs: p.headerRefs }) };
    let url = String(p.url ?? reusable?.url);
    const tls = p.tls ?? reusable?.tls;
    let reply;
    try {
      for (let redirects = 0; ; redirects++) {
        reply = await readHttp({ url, method: check.type === 'graphql' ? 'POST' : p.method, signal, headers: check.type === 'graphql' ? { 'content-type': 'application/json', ...headers } : headers, tls,
          body: check.type === 'graphql' ? JSON.stringify({ query: p.query, variables: p.variables }) : undefined });
        if (!p.followRedirects || ![301, 302, 303, 307, 308].includes(reply.status) || !reply.headers.location) break;
        if (redirects >= 3) return { state: 'critical', reason: 'Too many redirects', observedAt: iso(now) };
        const next = new URL(reply.headers.location, url);
        if (next.origin !== new URL(url).origin) return { state: 'unknown', reason: 'Cross-origin redirect refused to protect credentials' };
        url = next.href;
      }
    } catch (err) {
      return { state: err instanceof UpstreamError && ['limit', 'invalid'].includes(err.category) ? 'unknown' : 'critical', reason: signal.aborted ? 'HTTP deadline exceeded' : 'HTTP connection or response failed', observedAt: iso(Date.now()) };
    }
    const evidence = [{ kind: check.type as 'http' | 'graphql', label: 'Endpoint', statusCode: reply.status, durationMs: reply.durationMs }];
    if ([401, 403].includes(reply.status) && !p.authFailureIsCritical) return { state: 'unknown', reason: 'Observer authentication or authorization denied', evidence };
    if (!(p.expectedStatus ? p.expectedStatus.includes(reply.status) : reply.status >= 200 && reply.status <= 299)) return { state: 'critical', reason: `HTTP ${reply.status}`, observedAt: iso(now), evidence };
    if (p.expectedContentType && !String(reply.headers['content-type']).includes(p.expectedContentType)) return { state: 'critical', reason: 'Unexpected content type', observedAt: iso(now), evidence };
    let result = success(`HTTP ${reply.status}`);
    if (check.type === 'graphql' || p.assertions.length) {
      let body: any;
      try { body = jsonBody({ reply }); } catch { return { state: 'unknown', reason: 'Expected valid JSON response', evidence }; }
      if (check.type === 'graphql' && Array.isArray(body?.errors) && body.errors.length && !p.allowPartialData) return { state: 'critical', reason: 'GraphQL returned errors (including partial data)', observedAt: iso(now), evidence };
      result = assertValue({ value: body, assertions: p.assertions, now });
    }
    if (result.state === 'healthy') {
      if (p.criticalLatency && reply.durationMs >= ms(p.criticalLatency)) result = { ...result, state: 'critical', reason: 'Critical response latency' };
      else if (p.warningLatency && reply.durationMs >= ms(p.warningLatency)) result = { ...result, state: 'warning', reason: 'Elevated response latency' };
    }
    return { ...result, evidence };
  }
  if (check.type === 'tcp') {
    return await new Promise<CheckResult>(resolve => {
      let settled = false;
      const socket = net.createConnection({ host: p.host, port: p.port });
      const finish = (state: 'healthy' | 'critical', reason: string) => { if (settled) return; settled = true; signal.removeEventListener('abort', abort); socket.destroy(); return resolve({ state, reason, observedAt: iso(Date.now()) }); };
      const abort = () => finish('critical', 'TCP connection timed out');
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) { abort(); return; }
      socket.once('connect', () => finish('healthy', 'TCP connection accepted'));
      socket.once('error', () => finish('critical', 'TCP connection refused or unreachable'));
    });
  }
  if (check.type === 'dns') {
    const resolver = new Resolver({ timeout: 2000, tries: 1 });
    if (p.resolver) resolver.setServers([p.resolver]);
    const abort = () => resolver.cancel(); signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      const answers = await resolver.resolve(p.host, p.recordType);
      const flat = answers.flat().map(v => typeof v === 'string' ? v : JSON.stringify(v));
      return p.expected && !p.expected.every((v: string) => flat.includes(v)) ? { state: 'critical', reason: 'DNS answers differ from expected values', observedAt: iso(now) } : success(`DNS resolved ${flat.length} answers`);
    } catch { return { state: 'critical', reason: 'DNS lookup failed or timed out', observedAt: iso(now) }; }
    finally { signal.removeEventListener('abort', abort); }
  }
  if (check.type === 'ping') {
    return new Promise(resolve => {
      execFile('ping', ['-n', '-c', String(p.samples), '-W', '1', '--', p.host], { signal, timeout: 6000, maxBuffer: 8192, env: { ...process.env, LC_ALL: 'C' } }, (err, stdout, stderr) => {
        if (/permitted|permission|not found/i.test(stderr) || (err as NodeJS.ErrnoException)?.code === 'ENOENT') return resolve({ state: 'unknown', reason: 'ICMP unavailable; check ping installation and NET_RAW permission' });
        const loss = Number(/([\d.]+)% packet loss/.exec(stdout)?.[1] ?? 100);
        const latency = Number(/= [\d.]+\/([\d.]+)\//.exec(stdout)?.[1] ?? 0);
        return resolve({ state: loss >= p.criticalLoss ? 'critical' : (loss > 0 || latency >= ms(p.warningLatency) ? 'warning' : 'healthy'), reason: `Ping ${loss}% loss; ${latency}ms average`, observedAt: iso(Date.now()), measurements: { loss, latencyMs: latency } });
      });
    });
  }
  if (check.type === 'mqtt') {
    try { return mqttResult({ check, telemetry: sources.latest({ source: check.source!, topic: p.topic }), lwt: p.lwtTopic ? sources.latest({ source: check.source!, topic: p.lwtTopic }) : null, now }); }
    catch { return { state: 'unknown', reason: 'MQTT broker disconnected or subscription unavailable' }; }
  }
  if (check.type === 'postgres') {
    try {
      const rows = await sources.queryPostgres({ source: check.source!, query: p.query, values: p.values, signal });
      if (rows.length !== 1) return { state: 'unknown', reason: 'Expected exactly one database row' };
      return assertValue({ value: rows[0]?.[p.column], assertions: p.assertions, now });
    } catch { return { state: 'unknown', reason: 'Read-only database query unavailable or exceeded limits' }; }
  }
  if (check.type === 'prometheus') {
    try {
      const body: any = await sources.queryPrometheus({ source: check.source!, query: p.query, signal });
      if (body?.status !== 'success' || body.warnings?.length) return { state: 'unknown', reason: 'Prometheus query failed or returned warnings' };
      const samples = body.data.resultType === 'scalar' ? [body.data.result] : (body.data.resultType === 'vector' ? body.data.result.map((v: any) => v.value) : []);
      if (!samples.length) return { state: p.empty, reason: 'No Prometheus samples' };
      if (p.reduction === 'single' && samples.length !== 1) return { state: 'unknown', reason: 'Expected exactly one Prometheus sample' };
      if (samples.some((v: any) => !Array.isArray(v) || !Number.isFinite(Number(v[1])) || !Number.isFinite(v[0]) || now - v[0] * 1000 >= ms(check.staleAfter ?? sources.config.runtime.staleAfter) || v[0] * 1000 > now + ms(sources.config.runtime.futureTolerance))) return { state: 'unknown', reason: 'Prometheus sample invalid or stale' };
      const values = samples.map((v: any) => Number(v[1]));
      const value = p.reduction === 'min' ? Math.min(...values) : (p.reduction === 'max' ? Math.max(...values) : (p.reduction === 'sum' ? values.reduce((a: number, b: number) => a + b, 0) : values[0]));
      return { ...assertValue({ value, assertions: p.assertions, now }), observedAt: iso(Math.min(...samples.map((v: any) => v[0] * 1000))), evidence: [{ kind: 'prometheus', label: 'Prometheus', message: 'Configured instant query' }] };
    } catch { return { state: 'unknown', reason: 'Prometheus observer unavailable' }; }
  }
  return { state: 'unknown', reason: 'Unsupported built-in type' };
};
