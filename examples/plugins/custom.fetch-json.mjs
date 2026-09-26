import { atPath, timestamp, unknown } from './lib/values.mjs';

export default {
  apiVersion: 1, type: 'custom.fetch-json',
  configSchema: {
    type: 'object', additionalProperties: false, required: ['url'],
    properties: {
      url: { type: 'string', pattern: '^https?://', maxLength: 2048 },
      readyPath: { type: 'string', minLength: 1, maxLength: 128 },
      timestampPath: { type: 'string', minLength: 1, maxLength: 128 },
      maxAgeSeconds: { type: 'number', minimum: 1, maximum: 86400 },
      tokenRef: { type: 'string', minLength: 1 },
      headers: { type: 'object', additionalProperties: { type: 'string', maxLength: 4096 }, maxProperties: 20 },
    },
  },
  check: async ({ config, context, signal }) => {
    // The bounded host helper performs a JSON GET and never follows redirects.
    const headers = { ...config.headers };
    if (config.tokenRef) headers.authorization = 'Bearer ' + await context.secrets.get({ ref: config.tokenRef });
    const reply = await context.http.getJson({ url: config.url, headers, signal });
    if ([401, 403].includes(reply.statusCode)) return unknown({ reason: 'API observer authorization denied' });
    if (reply.statusCode < 200 || reply.statusCode >= 300) return { state: 'critical', reason: 'API returned HTTP ' + reply.statusCode };
    const ready = atPath({ value: reply.body, path: config.readyPath ?? 'ready' });
    if (typeof ready !== 'boolean') return unknown({ reason: 'Readiness field is missing or is not a boolean' });
    if (config.timestampPath) {
      const time = timestamp({ value: atPath({ value: reply.body, path: config.timestampPath }) });
      const now = Date.parse(context.clock.now());
      if (!Number.isFinite(time) || time > now + 30000 || now - time >= (config.maxAgeSeconds ?? 120) * 1000) return unknown({ reason: 'API payload timestamp is missing, future or stale' });
    }
    return { state: ready ? 'healthy' : 'critical', reason: ready ? 'Application reports ready' : 'Application reports not ready',
      observedAt: reply.receivedAt, evidence: [{ kind: 'http', label: 'JSON readiness', statusCode: reply.statusCode }],
      presentation: { icon: '↗', text: ready ? 'API ready' : 'API not ready', textMode: 'wrap' } };
  },
};
