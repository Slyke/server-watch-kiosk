import { validThresholds, highState, unknown } from './lib/values.mjs';

export default {
  apiVersion: 1, type: 'custom.prometheus-value',
  configSchema: {
    type: 'object', additionalProperties: false, required: ['source', 'query'],
    properties: {
      source: { type: 'string', minLength: 1 }, query: { type: 'string', minLength: 1, maxLength: 16000 },
      warning: { type: 'number', minimum: 0 }, critical: { type: 'number', exclusiveMinimum: 0 },
      maxAgeSeconds: { type: 'number', minimum: 1, maximum: 3600 },
    },
  },
  check: async ({ config, context }) => {
    const warning = config.warning ?? 50; const critical = config.critical ?? 100;
    if (!validThresholds({ warning, critical })) return unknown({ reason: 'Metric thresholds require warning < critical' });
    const body = await context.prometheus.query({ source: config.source, query: config.query });
    if (body?.status !== 'success' || body.warnings?.length || body.data?.resultType !== 'vector' || !Array.isArray(body.data.result) || body.data.result.length !== 1) return unknown({ reason: 'Expected exactly one metric series without query warnings' });
    const sample = body.data.result[0].value;
    if (!Array.isArray(sample) || sample.length !== 2 || typeof sample[0] !== 'number' || typeof sample[1] !== 'string' || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(sample[1])) return unknown({ reason: 'Invalid metric sample' });
    // Prometheus encodes numeric samples as strings by protocol.
    const value = Number(sample[1]); const time = sample[0] * 1000; const now = Date.parse(context.clock.now());
    if (!Number.isFinite(value) || !Number.isFinite(time) || time > now + 30000 || now - time >= (config.maxAgeSeconds ?? 120) * 1000) return unknown({ reason: 'Metric sample is nonfinite, future or stale' });
    return { state: highState({ value, warning, critical }), reason: 'Metric value ' + value.toFixed(2),
      observedAt: new Date(time).toISOString(), measurements: { value },
      evidence: [{ kind: 'prometheus', label: 'Single series' }], presentation: { icon: '∿', text: value.toFixed(2) } };
  },
};
