export function evaluateGarage({ lwt, message, relay, now }) {
  if (lwt?.payload === 'Offline') return { state: 'critical', reason: 'Garage controller disconnected from MQTT' };
  // Tasmota's local Time has no timezone. Use receipt time of live messages.
  if (!message || message.retained || !relay) return { state: 'unknown', reason: 'Waiting for fresh POWER3 telemetry' };
  const age = (now - message.receiptAt) / 1000;
  if (!Number.isFinite(age) || age < 0) return { state: 'unknown', reason: 'Invalid telemetry receipt time' };
  if (!['ON', 'OFF'].includes(relay.value)) return { state: 'unknown', reason: 'Garage POWER3 state missing' };
  const state = age >= 900 ? 'critical' : age >= 600 ? 'warning' : 'healthy';
  const reason = `POWER3: ${relay.value}; telemetry ${Math.round(age)}s old`;
  return { state, reason, observedAt: new Date(now).toISOString(), eventAt: new Date(message.receiptAt).toISOString(),
    measurements: { POWER3: relay.value, telemetryAgeSeconds: age },
    presentation: { text: reason, textMode: 'wrap', timestamp: { label: 'Last observed change', at: relay.lastChangedAt === null ? null : new Date(relay.lastChangedAt).toISOString() } },
  };
}
export default {
  apiVersion: 1, type: 'custom.tasmota-state',
  configSchema: { type: 'object', additionalProperties: false, required: ['source', 'topic', 'lwtTopic', 'stateKey'], properties: {
    source: { type: 'string' }, topic: { type: 'string' }, lwtTopic: { type: 'string' }, stateKey: { type: 'string' },
  } },
  check: async ({ config, context }) => {
    const lwt = await context.mqtt.latest({ source: config.source, topic: config.lwtTopic });
    const message = await context.mqtt.latest({ source: config.source, topic: config.topic });
    const relay = await context.mqtt.state({ source: config.source, key: config.stateKey });
    return evaluateGarage({ lwt, message, relay, now: Date.parse(context.clock.now()) });
  },
};
