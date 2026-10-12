// Pool liveness requires new accepted shares, not just a nonzero cached hashrate.
const history = new Map();
export function evaluateBitaxe(data, previous, now) {
  const valid = ['hashRate', 'sharesAccepted', 'uptimeSeconds', 'workReceived'].every(k => Number.isFinite(data[k]));
  if (!valid) return { result: { state: 'unknown', reason: 'Mining counters unavailable' }, next: undefined };
  const reset = !previous || data.uptimeSeconds < previous.uptime || data.sharesAccepted < previous.shares;
  const next = reset ? { started: now, lastShare: null, shares: data.sharesAccepted, uptime: data.uptimeSeconds, work: data.workReceived } : {
    ...previous, lastShare: data.sharesAccepted > previous.shares ? now : previous.lastShare,
    shares: data.sharesAccepted, uptime: data.uptimeSeconds, work: data.workReceived,
  };
  const age = (now - (next.lastShare ?? next.started)) / 1000;
  let state = 'healthy';
  let reason = `Pool connected; mining ${(data.hashRate / 1000).toFixed(2)} TH/s; accepted share ${Math.round(age)}s ago`;
  if (data.miningPaused === true || data.overheat_mode > 0 || data.hashRate <= 0) {
    state = 'critical'; reason = 'Mining stopped, paused, or overheated';
  } else if (age >= 600) {
    state = 'critical'; reason = 'No new pool-accepted shares for 10 minutes';
  } else if (age >= 180) {
    state = 'warning'; reason = `No new pool-accepted shares for ${Math.round(age)}s`;
  } else if (next.lastShare === null) {
    state = 'unknown'; reason = 'Hashing; waiting for a new pool-accepted share';
  }
  return { next, result: { state, reason, observedAt: new Date(now).toISOString(),
    measurements: { hashRateGHs: data.hashRate, sharesAccepted: data.sharesAccepted, secondsSinceShare: age, temperatureC: data.temp ?? -1 },
    presentation: { text: reason, textMode: 'wrap' } } };
}
export default {
  apiVersion: 1, type: 'custom.bitaxe',
  configSchema: { type: 'object', additionalProperties: false, required: ['url'], properties: { url: { type: 'string', pattern: '^https?://' } } },
  check: async ({ config, context, signal }) => {
    const response = await context.http.getJson({ url: config.url, signal });
    if (response.statusCode !== 200) return { state: 'unknown', reason: 'Bitaxe API unavailable' };
    const { result, next } = evaluateBitaxe(response.body, history.get(config.url), Date.parse(context.clock.now()));
    if (next) history.set(config.url, next);
    return result;
  },
};
