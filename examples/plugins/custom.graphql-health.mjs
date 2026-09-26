import { atPath, unknown } from './lib/values.mjs';

export default {
  apiVersion: 1, type: 'custom.graphql-health',
  configSchema: {
    type: 'object', additionalProperties: false, required: ['url', 'query'],
    properties: {
      url: { type: 'string', pattern: '^https?://', maxLength: 2048 }, query: { type: 'string', minLength: 1, maxLength: 16000 },
      variables: { type: 'object', additionalProperties: true, maxProperties: 20 },
      readyPath: { type: 'string', minLength: 1, maxLength: 128 },
    },
  },
  check: async ({ config, context, signal }) => {
    const body = await context.graphql.query({ url: config.url, query: config.query, variables: config.variables ?? {}, signal });
    if (!body || typeof body !== 'object') return unknown({ reason: 'Invalid GraphQL response' });
    if (body.errors !== undefined && (!Array.isArray(body.errors) || body.errors.length)) return unknown({ reason: 'GraphQL returned errors; partial data is not accepted' });
    const ready = atPath({ value: body, path: config.readyPath ?? 'data.health.ready' });
    if (typeof ready !== 'boolean') return unknown({ reason: 'GraphQL readiness field is missing or is not a boolean' });
    return { state: ready ? 'healthy' : 'critical', reason: ready ? 'GraphQL application ready' : 'GraphQL application not ready',
      observedAt: context.clock.now(), evidence: [{ kind: 'graphql', label: 'Readiness query' }], presentation: { icon: '◇' } };
  },
};
