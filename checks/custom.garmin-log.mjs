import { KubeConfig } from '@kubernetes/client-node';
import https from 'node:https';

export function evaluateGarminLog(log, now) {
  const lines = log.split('\n');
  const writes = lines.filter(line => /Success : updated influxDB database with new points/.test(line))
    .map(line => Date.parse(line.split(' ')[0])).filter(time => Number.isFinite(time) && time <= now + 30000);
  if (!writes.length) {
    const times = lines.map(line => Date.parse(line.split(' ')[0])).filter(time => Number.isFinite(time) && time <= now);
    const covered = times.length && now - Math.min(...times) >= 86400000;
    return { state: covered ? 'critical' : 'unknown', reason: covered ? 'No successful Garmin DB write in at least 24 hours' : 'No successful DB write timestamp in available Garmin logs' };
  }
  const last = Math.max(...writes); const hours = Math.max(0, now - last) / 3600000;
  return { state: hours >= 24 ? 'critical' : hours >= 20 ? 'warning' : 'healthy',
    reason: `Garmin DB write ${hours.toFixed(1)}h ago; daily limit 24h`,
    observedAt: new Date(now).toISOString(), eventAt: new Date(last).toISOString(),
    measurements: { hoursSinceWrite: Number(hours.toFixed(2)) },
    presentation: { text: `DB updated ${hours.toFixed(1)}h ago; alert after 24h`, textMode: 'wrap' },
    evidence: [{ kind: 'kubernetes', label: 'Garmin importer', message: 'Successful InfluxDB write confirmed by timestamped application log' }],
  };
}
async function request(kube, path, signal) {
  const options = { signal };
  await kube.applyToHTTPSOptions(options);
  return new Promise((resolve, reject) => {
    const req = https.get(kube.getCurrentCluster().server.replace(/\/$/, '') + path, options, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error('Kubernetes observation unavailable')); return; }
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 400000) req.destroy(new Error('Log budget exceeded')); else chunks.push(chunk); });
      response.on('error', reject); response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
  });
}
export default {
  apiVersion: 1, type: 'custom.garmin-log',
  configSchema: { type: 'object', additionalProperties: false, required: ['kubeconfigFile'], properties: { kubeconfigFile: { type: 'string' } } },
  check: async ({ config, context, signal }) => {
    const kube = new KubeConfig(); kube.loadFromFile(config.kubeconfigFile);
    if (kube.getCurrentUser()?.exec || kube.getCurrentUser()?.authProvider) throw new Error('Static observer credentials required');
    const pods = JSON.parse(await request(kube, '/api/v1/namespaces/health/pods?labelSelector=app%3Dgarmin-data', signal)).items;
    const pod = pods.filter(p => p.status?.phase === 'Running').sort((a, b) => b.metadata.creationTimestamp.localeCompare(a.metadata.creationTimestamp))[0];
    if (!pod) return { state: 'unknown', reason: 'No running Garmin importer to observe' };
    const log = await request(kube, `/api/v1/namespaces/health/pods/${encodeURIComponent(pod.metadata.name)}/log?container=garmin-data&timestamps=true&sinceSeconds=172800&tailLines=12000&limitBytes=350000`, signal);
    return evaluateGarminLog(log, Date.parse(context.clock.now()));
  },
};
