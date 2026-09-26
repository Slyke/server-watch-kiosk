// Copy this file, match type to its filename, enable it in config.json5.
export default {
  apiVersion: 1,
  type: 'custom.example',
  configSchema: {
    type: 'object', additionalProperties: false, required: ['target'],
    properties: { target: { type: 'string', pattern: '^https?://' } },
  },
  capabilities: { diagnostics: ['probes'] },
  check: async ({ config, context, signal }) => {
    const response = await context.http.getJson({ url: config.target, signal });
    return {
      state: response.statusCode === 200 && response.body.ready === true ? 'healthy' : 'critical',
      reason: response.body.ready === true ? 'Ready' : 'Readiness condition failed',
      observedAt: response.receivedAt,
      evidence: [{ kind: 'http', label: 'Readiness', statusCode: response.statusCode }],
      // Applied only when the check instance has allowPresentation: true.
      // The board always retains the actual health label and state.
      presentation: { icon: '⚙', textMode: 'wrap' },
    };
  },
  diagnose: async ({ context }) => ({
    apiVersion: 1, kind: 'probes', label: 'Module evidence', availability: 'available',
    text: 'The readiness module evaluates HTTP status and a boolean ready field.',
    observedAt: context.clock.now(), truncated: false,
  }),
};
