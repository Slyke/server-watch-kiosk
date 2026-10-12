export function evaluateGarage({ lwt, message, relay, now, warningAfterSeconds = 600, criticalAfterSeconds = 900 }) {
  if (!(warningAfterSeconds > 0 && criticalAfterSeconds > warningAfterSeconds)) return { state: 'unknown', reason: 'Invalid garage telemetry thresholds' };
  if (lwt?.payload === 'Offline') return { state: 'critical', reason: 'Garage controller disconnected from MQTT' };
  // Tasmota's local Time has no timezone. Use receipt time of live messages.
  if (!message || message.retained || !relay) return { state: 'unknown', reason: 'Waiting for fresh POWER3 telemetry' };
  const age = (now - message.receiptAt) / 1000;
  if (!Number.isFinite(age) || age < 0) return { state: 'unknown', reason: 'Invalid telemetry receipt time' };
  if (!['ON', 'OFF'].includes(relay.value)) return { state: 'unknown', reason: 'Garage POWER3 state missing' };
  const state = age >= criticalAfterSeconds ? 'critical' : age >= warningAfterSeconds ? 'warning' : 'healthy';
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
    warningAfterSeconds: { type: 'number', exclusiveMinimum: 0, maximum: 86400 },
    criticalAfterSeconds: { type: 'number', exclusiveMinimum: 0, maximum: 86400 },
  } },
  check: async ({ config, context }) => {
    let lwt, message, relay;
    try {
      lwt = await context.mqtt.latest({ source: config.source, topic: config.lwtTopic });
      message = await context.mqtt.latest({ source: config.source, topic: config.topic });
      relay = await context.mqtt.state({ source: config.source, key: config.stateKey });
    } catch { return { state: 'unknown', reason: 'Garage MQTT telemetry unavailable; waiting for observer reconnect' }; }
    return evaluateGarage({ lwt, message, relay, now: Date.parse(context.clock.now()), warningAfterSeconds: config.warningAfterSeconds, criticalAfterSeconds: config.criticalAfterSeconds });
  },
};
