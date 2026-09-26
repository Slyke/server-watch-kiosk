import { readRegister } from './lib/modbus-tcp.mjs';
import { validThresholds, highState, unknown } from './lib/values.mjs';

const inspect = async ({ config, context, signal }) => {
  const warning = config.warning ?? 60; const critical = config.critical ?? 80;
  if (!validThresholds({ warning, critical })) return unknown({ reason: 'Register thresholds require warning < critical' });
  try {
    const raw = await readRegister({ ...config, signal });
    const signed = config.signed && raw >= 32768 ? raw - 65536 : raw;
    const value = signed * (config.scale ?? 1) + (config.offset ?? 0);
    return { state: highState({ value, warning, critical }), reason: 'Register ' + config.address + ': ' + value.toFixed(2),
      observedAt: context.clock.now(), measurements: { value, raw },
      evidence: [{ kind: 'custom', label: 'Modbus TCP', message: 'Read one register with function ' + (config.functionCode ?? 4) }],
      presentation: { icon: '⌁', text: value.toFixed(2), textMode: 'wrap' } };
  } catch {
    // Transport/exception failures are unknown evidence, not a claimed equipment failure.
    return unknown({ reason: 'Modbus read unavailable, canceled or invalid' });
  }
};
export default {
  apiVersion: 1, type: 'custom.modbus-register',
  configSchema: {
    type: 'object', additionalProperties: false, required: ['host', 'address'],
    properties: {
      host: { type: 'string', minLength: 1, maxLength: 253 }, port: { type: 'integer', minimum: 1, maximum: 65535 },
      unitId: { type: 'integer', minimum: 1, maximum: 247 }, address: { type: 'integer', minimum: 0, maximum: 65535 },
      functionCode: { enum: [3, 4] }, signed: { type: 'boolean' },
      scale: { type: 'number', minimum: -1000000, maximum: 1000000 }, offset: { type: 'number', minimum: -1000000000, maximum: 1000000000 },
      warning: { type: 'number', minimum: 0 }, critical: { type: 'number', exclusiveMinimum: 0 },
      timeoutMs: { type: 'integer', minimum: 100, maximum: 10000 },
    },
  },
  capabilities: { diagnostics: ['probes'] },
  check: inspect,
  diagnose: async args => {
    const result = await inspect(args);
    return { apiVersion: 1, kind: 'probes', label: 'Modbus register', availability: result.state === 'unknown' ? 'unavailable' : 'available',
      observedAt: args.context.clock.now(), text: result.reason, truncated: false };
  },
};
