import { atPath, timestamp, validThresholds, highState, unknown } from './lib/values.mjs';

export default {
  apiVersion: 1, type: 'custom.mqtt-telemetry',
  configSchema: {
    type: 'object', additionalProperties: false, required: ['source', 'topic'],
    properties: {
      source: { type: 'string', minLength: 1 }, topic: { type: 'string', minLength: 1, maxLength: 256 },
      valuePath: { type: 'string', minLength: 1, maxLength: 128 }, timestampPath: { type: 'string', minLength: 1, maxLength: 128 },
      warning: { type: 'number', minimum: 0 }, critical: { type: 'number', exclusiveMinimum: 0 },
      maxAgeSeconds: { type: 'number', minimum: 1, maximum: 86400 },
    },
  },
  check: async ({ config, context }) => {
    const warning = config.warning ?? 60; const critical = config.critical ?? 80;
    if (!validThresholds({ warning, critical })) return unknown({ reason: 'Temperature thresholds require warning < critical' });
    // One shared host subscription; this module never connects or publishes.
    const message = await context.mqtt.latest({ source: config.source, topic: config.topic });
    if (!message) return unknown({ reason: 'Waiting for telemetry in the current broker connection' });
    let payload;
    try { payload = JSON.parse(message.payload); } catch { return unknown({ reason: 'Telemetry is not valid JSON' }); }
    const suppliedTime = atPath({ value: payload, path: config.timestampPath ?? 'timestamp' });
    const time = suppliedTime === undefined && !message.retained ? message.receiptAt : timestamp({ value: suppliedTime });
    const now = Date.parse(context.clock.now());
    if (!Number.isFinite(time) || time > now + 30000 || now - time >= (config.maxAgeSeconds ?? 120) * 1000) return unknown({ reason: 'Telemetry is stale or lacks a trustworthy producer timestamp' });
    const value = atPath({ value: payload, path: config.valuePath ?? 'temperature' });
    if (typeof value !== 'number' || !Number.isFinite(value)) return unknown({ reason: 'Temperature must be a finite JSON number' });
    return { state: highState({ value, warning, critical }), reason: 'Temperature ' + value.toFixed(1) + ' °C',
      observedAt: new Date(time).toISOString(), measurements: { temperatureC: value, ageSeconds: Math.max(0, now - time) / 1000 },
      evidence: [{ kind: 'mqtt', label: 'Telemetry', message: message.retained ? 'Timestamped retained sample' : 'Live sample' }],
      presentation: { icon: '♨', text: value.toFixed(1) + ' °C', textMode: 'wrap' } };
  },
};
