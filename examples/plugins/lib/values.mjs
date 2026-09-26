// Shared helpers: no credentials, I/O, implicit number conversion or HTML.
export const atPath = ({ value, path }) => path.split('.').reduce((current, key) =>
  current && typeof current === 'object' && Object.hasOwn(current, key) && !['__proto__', 'prototype', 'constructor'].includes(key) ? current[key] : undefined, value);
export const timestamp = ({ value }) => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
export const validThresholds = ({ warning, critical }) => Number.isFinite(warning) && Number.isFinite(critical) && warning >= 0 && warning < critical;
export const highState = ({ value, warning, critical }) => value >= critical ? 'critical' : (value >= warning ? 'warning' : 'healthy');
export const unknown = ({ reason }) => ({ state: 'unknown', reason });
