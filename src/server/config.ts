import fs from 'node:fs';
import path from 'node:path';
import JSON5 from 'json5';
import { z } from 'zod';
import { duration, ms, ThemeSchema } from '../shared/contracts.js';

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/);
const url = z.string().url().refine(v => { try { const parsed = new URL(v); return !parsed.username && !parsed.password; } catch { return false; } }, 'Use secret references, not URL credentials').refine(v => /^https?:\/\//.test(v), 'HTTP(S) URL required');
const headers = z.record(z.string().max(4096)).default({});
const tls = z.object({ caFile: z.string().optional(), certFile: z.string().optional(), keyFile: z.string().optional(), rejectUnauthorized: z.boolean().default(true) }).strict().optional();
const sourceBase = { concurrency: z.number().int().min(1).max(32).default(4) };
const mqttTopic = z.string().min(1).max(256).refine(v => !/[+#]/.test(v));
const trackedState = z.object({
  inputs: z.array(z.object({ topic: mqttTopic, field: z.string().min(1).max(128).optional() }).strict()).min(1).max(8),
  values: z.array(z.string().min(1).max(128)).min(2).max(32),
  availabilityTopic: mqttTopic.optional(), offlineValue: z.string().default('Offline'),
}).strict();
export const SourceSchema = z.discriminatedUnion('type', [
  z.object({ ...sourceBase, type: z.literal('kubernetes'), kubeconfigFile: z.string().optional(), inCluster: z.boolean().default(false), context: z.string().optional(), namespaces: z.array(z.string().min(1)).min(1) }).strict(),
  z.object({ ...sourceBase, type: z.literal('http'), url, headers, headerRefs: headers, tls }).strict(),
  z.object({ ...sourceBase, type: z.literal('prometheus'), url, headers, headerRefs: headers, tls }).strict(),
  z.object({ ...sourceBase, type: z.literal('postgres'), host: z.string().min(1), port: z.number().int().min(1).max(65535).default(5432), database: z.string().min(1), usernameRef: id, passwordRef: id, tls, maxRows: z.number().int().min(1).max(1000).default(100) }).strict(),
  z.object({ ...sourceBase, type: z.literal('mqtt'), url: z.string().regex(/^mqtts?:\/\//), usernameRef: id.optional(), passwordRef: id.optional(), tls, topics: z.array(mqttTopic).max(200), trackedStates: z.record(id, trackedState).refine(v => Object.keys(v).length <= 100).default({}), stateFile: z.string().optional() }).strict(),
]);
export const AssertionSchema = z.object({
  path: z.string().max(256).default(''), operator: z.enum(['eq', 'gt', 'gte', 'lt', 'lte', 'range', 'timestamp']),
  value: z.union([z.string(), z.number().finite(), z.boolean()]).optional(), min: z.number().finite().optional(), max: z.number().finite().optional(),
  warningAfter: duration.optional(), criticalAfter: duration.optional(), failureState: z.enum(['warning', 'critical']).default('critical'),
}).strict().superRefine((v, ctx) => {
  if (v.operator === 'timestamp' && (!v.criticalAfter || (v.warningAfter && ms(v.warningAfter) >= ms(v.criticalAfter)))) ctx.addIssue({ code: 'custom', message: 'Timestamp thresholds require criticalAfter > warningAfter' });
  if (v.operator === 'range' && (v.min === undefined || v.max === undefined || v.min > v.max)) ctx.addIssue({ code: 'custom', message: 'Range requires min <= max' });
  if (!['timestamp', 'range'].includes(v.operator) && v.value === undefined) ctx.addIssue({ code: 'custom', message: 'Assertion requires value' });
});
export type Assertion = z.infer<typeof AssertionSchema>;
const assertions = z.array(AssertionSchema).max(20).default([]);
const requestParams = {
  url: url.optional(), headers, headerRefs: headers, tls,
  expectedStatus: z.array(z.number().int().min(100).max(599)).min(1).optional(),
  followRedirects: z.boolean().default(false), expectedContentType: z.string().optional(),
  authFailureIsCritical: z.boolean().default(false), assertions,
  warningLatency: duration.optional(), criticalLatency: duration.optional(),
};
const host = z.string().min(1).max(253).regex(/^[a-zA-Z0-9_.:[\]-]+$/).refine(v => !v.startsWith('-'));
const namespace = z.string().min(1).max(253);
const restartPolicy = { restartWarning: z.number().int().nonnegative().default(5), restartWarningWindow: duration.refine(v => ms(v) > 0, 'Restart window must be positive').default('1h') };
const workload = { namespace, name: namespace, zeroReplicas: z.enum(['paused', 'unknown']).default('paused'), ...restartPolicy };
export const builtinSchemas: Record<string, z.ZodTypeAny> = {
  http: z.object({ ...requestParams, method: z.enum(['GET', 'HEAD']).default('GET') }).strict(),
  graphql: z.object({ ...requestParams, query: z.string().min(1).max(16000), variables: z.record(z.unknown()).default({}), allowPartialData: z.boolean().default(false) }).strict(),
  tcp: z.object({ host, port: z.number().int().min(1).max(65535) }).strict(),
  dns: z.object({ host, resolver: z.string().optional(), recordType: z.enum(['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS']).default('A'), expected: z.array(z.string()).optional() }).strict(),
  ping: z.object({ host, samples: z.number().int().min(1).max(5).default(3), warningLatency: duration.default('250ms'), criticalLoss: z.number().min(0).max(100).default(100) }).strict(),
  'network.node': z.object({ host, apiPort: z.number().int().min(1).max(65535).optional(), samples: z.number().int().min(1).max(5).default(2), warningLatency: duration.default('250ms'), criticalLoss: z.number().min(0).max(100).default(100) }).strict(),
  prometheus: z.object({ query: z.string().min(1).max(16000), reduction: z.enum(['single', 'min', 'max', 'sum']).default('single'), empty: z.enum(['unknown', 'paused']).default('unknown'), assertions }).strict(),
  postgres: z.object({ query: z.string().min(1).max(16000), values: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).max(100).default([]), column: z.string().min(1), assertions }).strict(),
  mqtt: z.object({ topic: z.string().min(1), lwtTopic: z.string().optional(), offlineValue: z.string().default('Offline'), onlineValue: z.string().default('Online'), timestampPath: z.string().optional(), timestampFormat: z.enum(['rfc3339', 'epochSeconds', 'epochMilliseconds']).default('rfc3339'), warningAfter: duration.default('10m'), criticalAfter: duration.default('15m'), assertions }).strict(),
  'kubernetes.workload': z.object({ ...workload, kind: z.enum(['Deployment', 'StatefulSet', 'DaemonSet']) }).strict(),
  'kubernetes.pods': z.object({ namespace, names: z.array(namespace).min(1).optional(), selector: z.string().min(1).optional(), empty: z.enum(['unknown', 'critical', 'paused']).default('unknown'), ...restartPolicy }).strict().refine(v => Boolean(v.names) !== Boolean(v.selector), 'Set exactly one of names or selector'),
  'kubernetes.job': z.object({ namespace, name: namespace, kind: z.enum(['Job', 'CronJob']).default('Job'), warningAfter: duration.optional(), criticalAfter: duration.default('24h') }).strict(),
};
const schedule = { interval: duration.optional(), timeout: duration.optional(), staleAfter: duration.optional(), failureAfter: duration.optional(), recoveryAfter: duration.optional() };
export const CheckSchema = z.object({
  type: id, label: z.string().max(128).optional(), source: id.optional(), sources: z.array(id).max(16).default([]), ...schedule,
  enabled: z.boolean().default(true), secretRefs: z.array(id).max(32).default([]),
  allowPresentation: z.boolean().default(false), params: z.record(z.unknown()).default({}),
}).strict();
const ref = z.object({ id, required: z.boolean().default(true) }).strict();
export const ConfigSchema = z.object({
  schemaVersion: z.literal(1),
  server: z.object({ host: z.string().default('0.0.0.0'), port: z.number().int().min(0).max(65535).default(8098), requestLimit: z.number().int().min(1024).max(65536).default(16384), remoteAccess: z.literal('status-only').default('status-only'), localLock: z.boolean().default(false) }).strict().default({}),
  runtime: z.object({
    interval: duration.default('30s'), timeout: duration.default('5s'), staleAfter: duration.default('120s'),
    failureAfter: duration.default('30s'), recoveryAfter: duration.default('30s'), futureTolerance: duration.default('30s'), pollInterval: duration.default('5s'),
    concurrency: z.number().int().min(1).max(64).default(8), diagnosticsConcurrency: z.number().int().min(1).max(16).default(4),
    diagnosticsTimeout: duration.default('5s'), diagnosticsBudget: duration.default('15s'), diagnosticsCache: duration.default('5s'),
  }).strict().default({}),
  uiDefaults: z.object({
    theme: ThemeSchema.default('reference'),
    autoDiagnostics: z.boolean().default(true), sortMode: z.enum(['severity', 'name', 'custom']).default('severity'),
    splitRatio: z.number().min(0.2).max(0.8).default(0.6),
    optionsEnabled: z.boolean().default(true),
    customOrders: z.record(z.string().min(1).max(64), z.array(id).max(1000)).default({}),
  }).strict().default({}),
  sources: z.record(id, SourceSchema).default({}),
  plugins: z.object({ directory: z.string().default('./checks'), enabled: z.array(id).max(100).default([]), allowHotReload: z.boolean().default(false), watch: z.boolean().default(false), importTimeout: duration.default('5s') }).strict().default({}),
  checks: z.record(id, CheckSchema).default({}),
  services: z.array(z.object({
    id, name: z.string().min(1).max(128), group: z.string().max(128).default('Services'), priority: z.number().finite().default(0),
    enabled: z.boolean().default(true), maintenance: z.boolean().default(false), checks: z.array(ref).max(100).default([]),
    dependsOn: z.array(z.object({ serviceId: id, required: z.boolean().default(true) }).strict()).max(100).default([]),
    links: z.array(z.object({ label: z.string().max(128), url }).strict()).max(10).default([]),
  }).strict()).max(1000).default([]),
  demo: z.object({ enabled: z.boolean().default(true), scenario: z.enum(['mixed', 'failure', 'recovery', 'collector-disconnect', 'api-disconnect']).default('mixed') }).strict().default({}),
}).strict();
export const SecretsSchema = z.object({ schemaVersion: z.literal(1), values: z.record(id, z.string().max(16384)) }).strict();
export type Config = z.infer<typeof ConfigSchema>;
export type Source = z.infer<typeof SourceSchema>;
export type CheckConfig = z.infer<typeof CheckSchema>;
export type ServiceConfig = Config['services'][number];
export type Secrets = z.infer<typeof SecretsSchema>;
export const resolveEnvironmentReferences = ({ value, env = process.env }: { value: unknown; env?: NodeJS.ProcessEnv }): unknown => {
  if (typeof value === 'string') {
    const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
    return match ? (env[match[1]!] ?? null) : value;
  }
  if (Array.isArray(value)) return value.map(item => resolveEnvironmentReferences({ value: item, env }));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveEnvironmentReferences({ value: item, env })]));
  return value;
};
export const validateConfig = ({ config, secrets }: { config: Config; secrets: Secrets }): Config => {
  const fail = (at: string, reason: string): never => { throw new Error(`config.json5:${at}: ${reason}`); };
  for (const key of ['interval', 'timeout', 'staleAfter', 'pollInterval', 'diagnosticsTimeout', 'diagnosticsBudget', 'diagnosticsCache'] as const) {
    if (ms(config.runtime[key]) <= 0 || ms(config.runtime[key]) > 86400000) fail('runtime.' + key, 'Duration must be positive and at most 24h');
  }
  const ids = new Set<string>();
  for (const service of config.services) {
    if (ids.has(service.id)) fail('services', 'Duplicate service ID');
    ids.add(service.id);
    if (new Set(service.dependsOn.map(r => r.serviceId)).size !== service.dependsOn.length) fail('services.' + service.id + '.dependsOn', 'Duplicate dependency');
    if (new Set(service.checks.map(r => r.id)).size !== service.checks.length) fail(`services.${service.id}.checks`, 'Duplicate reference');
    if (service.enabled && !service.maintenance && !service.checks.some(c => c.required) && !service.dependsOn.some(d => d.required)) fail(`services.${service.id}`, 'Active service needs a required input');
  }
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (service: ServiceConfig) => {
    if (visiting.has(service.id)) fail('services.dependsOn', 'Dependency cycle');
    if (visited.has(service.id)) return;
    visiting.add(service.id);
    for (const c of service.checks) if (!config.checks[c.id]) fail(`services.${service.id}.checks`, 'Missing check reference');
    for (const d of service.dependsOn) {
      const dep = config.services.find(s => s.id === d.serviceId);
      if (!dep) fail(`services.${service.id}.dependsOn`, 'Missing service reference');
      visit(dep!);
    }
    visiting.delete(service.id); visited.add(service.id);
  };
  config.services.forEach(visit);
  if (new Set(config.plugins.enabled).size !== config.plugins.enabled.length) fail('plugins.enabled', 'Duplicate module type');
  if (config.plugins.watch && !config.plugins.allowHotReload) fail('plugins.watch', 'Watching requires allowHotReload');
  if (config.plugins.enabled.some(type => builtinSchemas[type])) fail('plugins.enabled', 'Built-in types are reserved');
  for (const [sourceId, source] of Object.entries(config.sources)) {
    if (source.type === 'kubernetes' && Boolean(source.kubeconfigFile) === source.inCluster) fail(`sources.${sourceId}`, 'Set kubeconfigFile or inCluster, exclusively');
    if (source.type === 'mqtt') for (const track of Object.values(source.trackedStates)) {
      for (const topic of [...track.inputs.map(i => i.topic), ...(track.availabilityTopic ? [track.availabilityTopic] : [])]) if (!source.topics.includes(topic)) fail(`sources.${sourceId}.trackedStates`, 'Tracked topics must be explicitly subscribed');
    }
  }
  for (const [checkId, check] of Object.entries(config.checks)) {
    const at = `checks.${checkId}`;
    for (const key of ['interval', 'timeout', 'staleAfter'] as const) if (ms(check[key] ?? config.runtime[key]) <= 0) fail(at, 'Durations must be positive');
    const schema = builtinSchemas[check.type];
    if (schema) {
      const result = schema.safeParse(check.params);
      if (!result.success) fail(at + '.params.' + result.error.issues[0]!.path.join('.'), 'Invalid adapter parameters');
      check.params = result.data;
    } else if (!config.plugins.enabled.includes(check.type)) fail(at + '.type', 'Unknown or disabled type');
    if (check.source && !config.sources[check.source]) fail(at + '.source', 'Missing source');
    for (const sourceId of check.sources) if (!config.sources[sourceId]) fail(at + '.sources', 'Missing source');
    const expected = check.type.startsWith('kubernetes.') ? 'kubernetes' : check.type;
    if (['kubernetes', 'postgres', 'prometheus', 'mqtt'].includes(expected) && config.sources[check.source ?? '']?.type !== expected) fail(at + '.source', 'Incompatible or absent source');
    if (['http', 'graphql'].includes(check.type) && ((!check.params.url && !check.source) || (check.source && config.sources[check.source]?.type !== 'http'))) fail(at + '.source', 'HTTP URL or compatible source required');
    if (expected === 'kubernetes') {
      const source = config.sources[check.source!] as Extract<Source, { type: 'kubernetes' }>;
      if (!source.namespaces.includes(check.params.namespace as string)) fail(at + '.params.namespace', 'Namespace is outside the source allowlist');
    }
    for (const [warning, critical] of [['warningLatency', 'criticalLatency'], ['warningAfter', 'criticalAfter']]) {
      const w = check.params[warning!]; const c = check.params[critical!];
      if (typeof w === 'string' && typeof c === 'string' && ms(w) >= ms(c)) fail(at + '.params', 'Critical threshold must exceed warning threshold');
    }
    if (check.type === 'mqtt') {
      const source = config.sources[check.source!] as Extract<Source, { type: 'mqtt' }>;
      for (const topic of [check.params.topic, check.params.lwtTopic].filter(Boolean)) if (!source.topics.includes(topic as string)) fail(at, 'MQTT topic must be explicitly allowed by source');
      if (ms(check.params.warningAfter as string) >= ms(check.params.criticalAfter as string)) fail(at, 'criticalAfter must exceed warningAfter');
    }
    for (const key of check.secretRefs) if (!(key in secrets.values)) fail(at + '.secretRefs', 'Missing secret reference');
  }
  const scanRefs = (value: unknown, at: string) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key.endsWith('Ref') && typeof child === 'string' && !(child in secrets.values)) fail(at + '.' + key, 'Missing secret reference');
      if (key === 'headerRefs' && child && typeof child === 'object') for (const ref of Object.values(child)) if (!(String(ref) in secrets.values)) fail(at + '.headerRefs', 'Missing secret reference');
      if (key === 'headers' && child && typeof child === 'object' && Object.keys(child).some(h => /authorization|cookie|token|api[-_]key/i.test(h))) fail(at + '.headers', 'Use headerRefs for credentials');
      scanRefs(child, at + '.' + key);
    }
  };
  scanRefs(config.sources, 'sources'); scanRefs(config.checks, 'checks');
  for (const [name, order] of Object.entries(config.uiDefaults.customOrders)) if (new Set(order).size !== order.length || (!config.demo.enabled && order.some(id => !ids.has(id)))) fail('uiDefaults.customOrders.' + name, 'Duplicate or unknown service');
  return config;
};
export const loadConfig = ({ configFile, secretsFile, demo }: { configFile: string; secretsFile: string; demo?: boolean }) => {
  const parse = (file: string) => {
    try { return resolveEnvironmentReferences({ value: JSON5.parse(fs.readFileSync(file, 'utf8')) }); }
    catch { throw new Error(`${path.basename(file)}: unable to read or parse JSON5`); }
  };
  const validate = <T>(schema: z.ZodType<T>, value: unknown, file: string): T => {
    const result = schema.safeParse(value);
    if (!result.success) throw new Error(`${path.basename(file)}:${result.error.issues[0]!.path.join('.')}: invalid configuration value`);
    return result.data;
  };
  const config = validate(ConfigSchema, parse(configFile), configFile) as Config;
  if (demo !== undefined) config.demo.enabled = demo;
  const secrets = fs.existsSync(secretsFile) ? validate(SecretsSchema, parse(secretsFile), secretsFile) : { schemaVersion: 1 as const, values: {} };
  config.plugins.directory = path.resolve(path.dirname(configFile), config.plugins.directory);
  return { config: validateConfig({ config, secrets }), secrets };
};
