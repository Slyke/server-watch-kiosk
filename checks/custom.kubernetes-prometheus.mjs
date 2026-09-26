// Alternative workload observation through kube-state-metrics.
// Kubernetes API checks remain the source of scoped pod/log diagnostics.
const metricSets = {
  Deployment: ['kube_deployment_spec_replicas', 'kube_deployment_status_replicas_available', 'kube_deployment_status_replicas_updated', 'kube_deployment_metadata_generation', 'kube_deployment_status_observed_generation'],
  StatefulSet: ['kube_statefulset_replicas', 'kube_statefulset_status_replicas_ready', 'kube_statefulset_status_replicas_updated', 'kube_statefulset_metadata_generation', 'kube_statefulset_status_observed_generation'],
  DaemonSet: ['kube_daemonset_status_desired_number_scheduled', 'kube_daemonset_status_number_available', 'kube_daemonset_status_updated_number_scheduled', 'kube_daemonset_metadata_generation', 'kube_daemonset_status_observed_generation'],
};
export default {
  apiVersion: 1, type: 'custom.kubernetes-prometheus',
  configSchema: {
    type: 'object', additionalProperties: false, required: ['source', 'namespace', 'name', 'kind', 'scrapeQuery'],
    properties: {
      source: { type: 'string' }, namespace: { type: 'string' }, name: { type: 'string' },
      kind: { enum: ['Deployment', 'StatefulSet', 'DaemonSet'] },
      scrapeQuery: { type: 'string', minLength: 1 },
      staleSeconds: { type: 'number', minimum: 1, maximum: 3600 },
      partition: { type: 'integer', minimum: 0 }, onDelete: { type: 'boolean' },
    },
  },
  check: async ({ config, context }) => {
    const now = Date.parse(context.clock.now());
    const unknown = (reason) => ({ state: 'unknown', reason: 'Prometheus observer: ' + reason });
    const samples = async (query) => {
      const body = await context.prometheus.query({ source: config.source, query });
      if (body.status !== 'success' || body.warnings?.length || body.data?.resultType !== 'vector') throw new Error('Invalid Prometheus response');
      const rows = body.data.result;
      if (!rows.length || rows.some(row => !Array.isArray(row.value) || !Number.isFinite(Number(row.value[1])))) throw new Error('Missing metric coverage');
      return rows;
    };
    const up = await samples(config.scrapeQuery);
    if (up.some(row => Number(row.value[1]) !== 1 || now - Number(row.value[0]) * 1000 >= (config.staleSeconds ?? 120) * 1000)) return unknown('kube-state-metrics scrape unavailable');
    const metrics = metricSets[config.kind];
    const selector = `{__name__=~${JSON.stringify(metrics.join('|'))},namespace=${JSON.stringify(config.namespace)},${config.kind.toLowerCase()}=${JSON.stringify(config.name)}}`;
    const ageRows = await samples('timestamp(' + selector + ')');
    const oldest = Math.min(...ageRows.map(row => Number(row.value[1]) * 1000));
    if (now - oldest >= (config.staleSeconds ?? 120) * 1000 || oldest > now + 30000) return unknown('workload samples are expired or untrusted');
    const rows = await samples(selector);
    const values = metrics.map((metric, index) => {
      const found = rows.filter(row => row.metric.__name__ === metric).map(row => Number(row.value[1]));
      if (!found.length) return NaN;
      // Duplicate exporters cannot inflate readiness or hide a replica deficit.
      return [0, 3].includes(index) ? Math.max(...found) : Math.min(...found);
    });
    if (values.some(value => !Number.isFinite(value))) return unknown('required workload metrics missing');
    const [desired, ready, updated, generation, observed] = values;
    const state = desired === 0 ? 'paused' : (ready === 0 ? 'critical' : (ready < desired || observed < generation || (!config.onDelete && updated < Math.max(0, desired - (config.partition ?? 0))) ? 'warning' : 'healthy'));
    return { state, reason: `Prometheus: ${ready}/${desired} replicas available`, observedAt: new Date(oldest).toISOString(), measurements: { desired, ready, updated },
      evidence: [{ kind: 'prometheus', label: 'kube-state-metrics', message: 'Scrape health, metric coverage, sample freshness and duplicate exporters checked' }] };
  },
};
