import { timestamp, validThresholds, highState, unknown } from './lib/values.mjs';

export default {
  apiVersion: 1, type: 'custom.postgres-freshness',
  configSchema: {
    type: 'object', additionalProperties: false, required: ['source', 'query'],
    properties: {
      source: { type: 'string', minLength: 1 }, query: { type: 'string', minLength: 1, maxLength: 16000 },
      values: { type: 'array', maxItems: 20, items: { type: ['string', 'number', 'boolean', 'null'] } },
      column: { type: 'string', minLength: 1, maxLength: 128 },
      warningSeconds: { type: 'number', minimum: 0 }, criticalSeconds: { type: 'number', exclusiveMinimum: 0 },
    },
  },
  check: async ({ config, context }) => {
    const warning = config.warningSeconds ?? 3600; const critical = config.criticalSeconds ?? 7200;
    if (!validThresholds({ warning, critical })) return unknown({ reason: 'Freshness thresholds require warning < critical' });
    // Query text is trusted configuration; all data values remain bound parameters.
    const rows = await context.postgres.query({ source: config.source, query: config.query, values: config.values ?? [] });
    if (rows.length !== 1) return unknown({ reason: 'Freshness query must return exactly one row' });
    const time = timestamp({ value: rows[0][config.column ?? 'last_success_at'] });
    const now = Date.parse(context.clock.now());
    if (!Number.isFinite(time) || time > now + 30000) return unknown({ reason: 'Success timestamp is null, missing, invalid or in the future' });
    const ageSeconds = Math.max(0, now - time) / 1000;
    return { state: highState({ value: ageSeconds, warning, critical }), reason: 'Last success ' + Math.floor(ageSeconds) + 's ago',
      observedAt: context.clock.now(), eventAt: new Date(time).toISOString(), measurements: { ageSeconds },
      evidence: [{ kind: 'postgres', label: 'Last success', message: 'One timestamp read in a bounded read-only transaction' }],
      presentation: { icon: '↻', text: 'Last success ' + Math.floor(ageSeconds) + 's ago', textMode: 'wrap' } };
  },
};
