// Garmin-specific query semantics belong to a custom module.
export default {
  apiVersion: 1, type: 'custom.garmin',
  configSchema: {
    type: 'object', additionalProperties: false, required: ['source', 'query'],
    properties: {
      source: { type: 'string' }, query: { type: 'string', minLength: 1 },
      values: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] }, maxItems: 20 },
      column: { type: 'string', default: 'last_success_at' },
      warningHours: { type: 'number', minimum: 0, default: 20 },
      criticalHours: { type: 'number', exclusiveMinimum: 0, default: 24 },
    },
  },
  check: async ({ config, context }) => {
    const rows = await context.postgres.query({ source: config.source, query: config.query, values: config.values ?? [] });
    const value = rows.length === 1 ? rows[0][config.column ?? 'last_success_at'] : undefined;
    const time = typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
    const now = Date.parse(context.clock.now());
    const warning = config.warningHours ?? 20; const critical = config.criticalHours ?? 24;
    if (!Number.isFinite(time) || time > now + 30000 || warning >= critical) return { state: 'unknown', reason: 'No trusted import-success timestamp or invalid thresholds' };
    const ageHours = Math.max(0, now - time) / 3600000;
    return {
      state: ageHours >= critical ? 'critical' : (ageHours >= warning ? 'warning' : 'healthy'),
      reason: `Last successful import ${ageHours.toFixed(1)}h ago; limit ${critical}h`,
      observedAt: context.clock.now(), eventAt: new Date(time).toISOString(),
      measurements: { ageHours: Number(ageHours.toFixed(1)) },
      evidence: [{ kind: 'postgres', label: 'Import success', message: 'Read-only query returned one success timestamp' }],
      presentation: { icon: '↻', textMode: 'wrap' },
    };
  },
};
