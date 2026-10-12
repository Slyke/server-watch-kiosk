const hour = 3600000;
const defaults = { warningPercent: 30, criticalPercent: 10, warningAgeDays: 14, maxAgeDays: 30, lastSeenWarningHours: 48, lastSeenMaxHours: 168 };
const timestamp = (value, now) => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= now + 30000;
const report = (message, now) => {
  try {
    const body = JSON.parse(message.payload);
    return body && !Array.isArray(body) && timestamp(body.time, now) ? body : null;
  } catch { return null; }
};
const ageText = hours => hours >= 48 ? `${Math.floor(hours / 24)}d` : hours >= 1 ? `${Math.floor(hours)}h` : `${Math.floor(hours * 60)}m`;

export function evaluateZwaveBattery({ config, level, lastActive, gateway, now }) {
  const p = { ...defaults, ...config };
  const unknown = reason => ({ state: 'unknown', reason: `${p.name}: ${reason}` });
  if (p.criticalPercent >= p.warningPercent || p.warningAgeDays >= p.maxAgeDays || p.lastSeenWarningHours >= p.lastSeenMaxHours) return unknown('Invalid battery thresholds');
  const link = report(gateway, now);
  // Gateway status changes only on connect/disconnect, so its timestamp is not a heartbeat.
  if (link?.value !== true) return unknown(link?.value === false ? 'Z-Wave gateway offline' : 'Waiting for Z-Wave gateway status');
  const battery = report(level, now);
  if (!battery || !Number.isInteger(battery.value) || (battery.value !== 255 && (battery.value < 0 || battery.value > 100))) return unknown('Battery level or report timestamp unavailable');
  const ageHours = Math.max(0, (now - battery.time) / hour);
  const valueText = battery.value === 255 ? 'LOW' : `${battery.value}%`;
  const prefix = `${p.name}: ${valueText}; report ${ageText(ageHours)} ago`;
  const base = {
    observedAt: new Date(now).toISOString(), eventAt: new Date(battery.time).toISOString(),
    measurements: { ...(battery.value === 255 ? { lowBattery: true } : { batteryPercent: battery.value }), batteryReportAgeHours: ageHours },
  };
  const result = (state, reason) => ({ ...base, state, reason,
    presentation: { text: reason, textMode: 'wrap', timestamp: { label: 'Battery report', at: base.eventAt } },
  });
  if (ageHours >= p.maxAgeDays * 24) return result('unknown', `${prefix}; battery reading expired`);
  const activity = report(lastActive, now);
  if (!activity || !timestamp(activity.value, now)) return result('unknown', `${prefix}; last-seen time unavailable`);
  const lastSeenHours = Math.max(0, (now - activity.value) / hour);
  base.measurements.lastSeenHours = lastSeenHours;
  if (lastSeenHours >= p.lastSeenMaxHours) return result('unknown', `${prefix}; no device activity for ${ageText(lastSeenHours)}`);
  const reasons = [];
  const critical = battery.value === 255 || battery.value <= p.criticalPercent;
  if (critical) reasons.push('replace battery');
  else if (battery.value <= p.warningPercent) reasons.push('low battery');
  if (ageHours >= p.warningAgeDays * 24) reasons.push('battery report overdue');
  if (lastSeenHours >= p.lastSeenWarningHours) reasons.push(`last seen ${ageText(lastSeenHours)} ago`);
  return result(critical ? 'critical' : reasons.length ? 'warning' : 'healthy', [prefix, ...reasons].join('; '));
}

const topic = { type: 'string', minLength: 1, maxLength: 256, pattern: '^[^+#]+$' };
export default {
  apiVersion: 1, type: 'custom.zwave-battery',
  configSchema: { type: 'object', additionalProperties: false, required: ['source', 'name', 'levelTopic', 'lastActiveTopic', 'gatewayTopic'], properties: {
    source: { type: 'string', minLength: 1 }, name: { type: 'string', minLength: 1, maxLength: 64 },
    levelTopic: topic, lastActiveTopic: topic, gatewayTopic: topic,
    warningPercent: { type: 'integer', minimum: 1, maximum: 100 }, criticalPercent: { type: 'integer', minimum: 0, maximum: 99 },
    warningAgeDays: { type: 'number', exclusiveMinimum: 0, maximum: 365 }, maxAgeDays: { type: 'number', exclusiveMinimum: 0, maximum: 365 },
    lastSeenWarningHours: { type: 'number', exclusiveMinimum: 0, maximum: 8760 }, lastSeenMaxHours: { type: 'number', exclusiveMinimum: 0, maximum: 8760 },
  } },
  check: async ({ config, context }) => {
    try {
      const [level, lastActive, gateway] = await Promise.all([config.levelTopic, config.lastActiveTopic, config.gatewayTopic].map(topic => context.mqtt.latest({ source: config.source, topic })));
      return evaluateZwaveBattery({ config, level, lastActive, gateway, now: Date.parse(context.clock.now()) });
    } catch { return { state: 'unknown', reason: `${config.name}: MQTT telemetry unavailable` }; }
  },
};
