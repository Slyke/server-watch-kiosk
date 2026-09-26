import type { Config } from '../server/config.js';
import { CheckSchema, ConfigSchema } from '../server/config.js';
import { HealthEngine } from '../server/health.js';
import { type CheckResult, type DiagnosticIndex, type DiagnosticSection, type State, iso } from '../shared/contracts.js';

const fixtures: [string, string, string, State, string][] = [
  ['nextcloud', 'Nextcloud', 'Applications', 'healthy', 'App, Postgres and Redis ready'],
  ['cryptotracker', 'CryptoTracker', 'Applications', 'healthy', 'Prices updated; API ready'],
  ['garmin', 'Garmin sync', 'Health', 'critical', 'Last import 28.0h ago; limit 24h'],
  ['mqtt', 'MQTT', 'Infrastructure', 'healthy', 'Broker connected; subscriptions acknowledged'],
  ['home-automation', 'Home automation', 'Home', 'healthy', 'Automations and device bridge ready'],
  ['mqtt-control', 'MQTT control', 'Infrastructure', 'healthy', 'Readiness endpoint passing'],
  ['teslamate', 'TeslaMate', 'Applications', 'healthy', 'Collector and Postgres ready'],
  ['gitea', 'Gitea', 'Applications', 'healthy', 'Repository service ready'],
  ['jellyfin', 'Jellyfin', 'Media', 'healthy', 'Media server ready'],
  ['pihole', 'Pi-hole', 'Network', 'healthy', 'DNS resolving correctly'],
  ['monitoring', 'Monitoring', 'Infrastructure', 'healthy', 'Prometheus and Grafana ready'],
  ['openclaw', 'OpenClaw', 'Applications', 'healthy', 'Gateway ready; heartbeat current'],
  ['bitaxe', 'Bitaxe', 'Devices', 'healthy', 'Mining at 1.2 TH/s'],
  ['tasmota', 'Tasmota', 'Devices', 'healthy', 'Live telemetry received 12s ago'],
  ['paperless', 'Paperless', 'Applications', 'critical', 'Postgres connection refused'],
  ['immich', 'Immich', 'Applications', 'warning', '1/2 replicas ready; rollout in progress'],
  ['home-assistant', 'Home Assistant', 'Home', 'critical', 'Readiness endpoint returns HTTP 503'],
  ['vaultwarden', 'Vaultwarden', 'Applications', 'healthy', 'Vault and database ready'],
  ['argocd', 'ArgoCD', 'Infrastructure', 'healthy', 'Controllers ready'],
  ['authgateway', 'Auth gateway', 'Infrastructure', 'warning', 'Authentication latency 920ms'],
  ['sonarr', 'Sonarr', 'Media', 'healthy', 'Queue and indexers ready'],
  ['radarr', 'Radarr', 'Media', 'healthy', 'Library scan complete'],
  ['backupworker', 'Backup worker', 'Jobs', 'critical', 'No successful backup for 36h'],
  ['mediaindexer', 'Media indexer', 'Jobs', 'paused', 'Scheduled maintenance'],
  ['searchapi', 'Search API', 'Applications', 'unknown', 'Kubernetes observer permission denied'],
  ['notificationworker', 'Notification worker', 'Applications', 'warning', 'HTTP 429; 9 restarts in the last hour'],
  ['garagesensor', 'Garage sensor', 'Devices', 'critical', 'Ping 100% loss; no MQTT telemetry for 37m'],
  ['solarinverter', 'Solar inverter', 'Devices', 'healthy', 'Generation telemetry current'],
  ['weatherstation', 'Weather station', 'Devices', 'unknown', 'Retained replay has no producer timestamp'],
  ['router', 'Router', 'Network', 'healthy', 'TCP and ICMP probes passing'],
  ['nas', 'NAS', 'Network', 'critical', 'Host unreachable; storage API timed out'],
  ['dnsresolver', 'DNS resolver', 'Network', 'warning', '2 of 5 DNS probes timed out'],
  ['ups', 'UPS', 'Devices', 'healthy', 'Online; battery charged'],
  ['printer', 'Printer', 'Devices', 'paused', 'Intentional overnight sleep'],
];
export const demoConfig = ({ base }: { base: Config }): Config => {
  const config = ConfigSchema.parse({ ...base, sources: {}, checks: {}, services: [] });
  for (const [id, name, group] of fixtures) {
    const ids = id === 'garmin' ? ['garmin-app', 'garmin-db', 'garmin-freshness'] : (id === 'nextcloud' ? ['nextcloud-app', 'nextcloud-db', 'nextcloud-redis'] : [id + '-check']);
    for (const checkId of ids) config.checks[checkId] = CheckSchema.parse({ type: 'demo', label: checkId.includes('freshness') ? 'Latest import · Postgres' : (checkId.endsWith('-app') ? 'App' : (checkId.endsWith('-db') ? 'Postgres' : 'Availability')), allowPresentation: id === 'bitaxe' });
    config.services.push({ id, name, group, priority: id === 'garmin' ? 100 : 20, enabled: true, maintenance: false, checks: ids.map(id => ({ id, required: true })), dependsOn: [], links: [] });
  }
  return config;
};
export class Demo {
  scenario: Config['demo']['scenario'];
  lastTick = 0;
  constructor(readonly config: Config, readonly health: HealthEngine) { this.scenario = config.demo.scenario; this.tick(true); }
  setScenario = (scenario: Config['demo']['scenario']) => { this.scenario = scenario; this.lastTick = 0; this.tick(true); };
  tick = (force = false) => {
    const now = Date.now();
    if (!force && now - this.lastTick < 4000) return;
    this.lastTick = now;
    for (const [id, , , originalState, originalReason] of fixtures) {
      let state = originalState; let reason = originalReason;
      if (this.scenario === 'recovery' && state !== 'paused') { state = 'healthy'; reason = 'Simulated recovery; all components passing'; }
      if (this.scenario === 'collector-disconnect' && state !== 'paused') { state = 'unknown'; reason = 'Simulated observer disconnect; previous evidence unavailable'; }
      if (this.scenario === 'failure' && id === 'nextcloud') { state = 'critical'; reason = 'Simulated required Postgres outage'; }
      const service = this.config.services.find(s => s.id === id)!;
      for (const [index, ref] of service.checks.entries()) {
        const componentState = id === 'garmin' && index < 2 ? (this.scenario === 'collector-disconnect' ? 'unknown' : 'healthy') : state;
        const result = (at: number): CheckResult => ({
          state: componentState, reason: componentState === 'healthy' && state !== 'healthy' ? 'Workload ready' : reason, observedAt: componentState === 'unknown' ? undefined : iso(at),
          ...(id === 'garmin' && index === 2 ? { eventAt: iso(at - (state === 'healthy' ? 3600000 : 28 * 3600000)), measurements: { ageHours: state === 'healthy' ? 1 : 28 } } : {}),
          evidence: [{ kind: id === 'garmin' ? 'postgres' : 'custom', label: 'Simulated evidence', message: reason }],
          ...(id === 'bitaxe' ? { presentation: { icon: '⚡', text: 'Mining · 1.2 TH/s', textMode: 'wrap' as const } } : {}),
        });
        if (force && state !== 'unknown') this.health.record({ id: ref.id, result: result(now - 31000), now: now - 31000 });
        this.health.record({ id: ref.id, result: result(now), now });
      }
    }
  };
  index = ({ id }: { id: string }): DiagnosticIndex => {
    const kube = ['nextcloud', 'garmin', 'paperless', 'home-assistant', 'immich', 'notificationworker', 'backupworker', 'searchapi'].includes(id);
    const checkId = this.config.services.find(s => s.id === id)!.checks[0]!.id;
    const pods = kube ? [0, 1].map(n => ({ uid: 'simulated:' + id + ':' + n, name: id + '-simulated-' + n, namespace: 'simulated', source: 'simulated-cluster', checkId, unhealthy: n === 0 && id !== 'garmin',
      containers: [{ name: 'app', restarts: n === 0 ? 2 : 0, init: false }, { name: 'sidecar', restarts: 0, init: false }, { name: 'init', restarts: 0, init: true }] })) : [];
    const kind = id === 'garmin' || !kube ? 'probes' : (['paperless', 'searchapi'].includes(id) ? 'description' : 'logs');
    return { kinds: kube ? ['checks', 'logs', 'description', 'events', 'probes'] : ['checks', 'probes'], pods, preferred: { kind, pod: pods[0]?.uid, container: 'app' }, notices: ['All names, timestamps and evidence in this demo are simulated.'] };
  };
  diagnose = ({ id, kind, pod, container, previous }: { id: string; kind: string; pod?: string; container?: string; previous?: boolean }): DiagnosticSection => {
    const service = this.health.services().find(s => s.id === id)!;
    let text = ''; let availability: DiagnosticSection['availability'] = 'available';
    if (kind === 'logs') {
      if (id === 'paperless') { availability = 'forbidden'; text = 'Simulated: pods/log permission denied. This is not a diagnosis of a real system.'; }
      else if (id === 'searchapi') { availability = 'timeout'; text = 'Simulated Kubernetes log request timeout.'; }
      else if (id === 'garmin' || container === 'sidecar') { availability = 'empty'; text = ''; }
      else text = `[SIMULATED ${previous ? 'PREVIOUS' : 'CURRENT'} LOGS]\n${iso(Date.now() - 2000)} ${pod ?? id} / ${container ?? 'app'}: starting readiness check\n${iso(Date.now() - 1000)} ${service.state === 'critical' ? 'ERROR' : 'INFO'} ${service.reason}\n${iso(Date.now())} diagnostic sample complete\nLiteral remote content: <script>alert("never executed")</script>`;
    } else if (kind === 'description') text = `SIMULATED DESCRIPTION\n\nName: ${pod ?? id}\nNamespace: simulated\nImages: example.invalid/${id}:demo\nReady: ${service.state === 'healthy'}\nRestarts: 2\nConditions: ${service.reason}\nTermination reason: ${service.state === 'critical' ? 'Error (simulated)' : 'None'}`;
    else if (kind === 'events') text = `SIMULATED EVENTS\n\n${iso(Date.now())} · ReadinessProbe · count 3\n${service.reason}`;
    else text = `SIMULATED PROBE EVIDENCE\n\n${service.reason}\n${id === 'garmin' ? 'A successful import is 28 hours old. Warning at 20h; failure at age >= 24h. App and database pods remain ready.' : 'This fixture does not connect to an upstream service.'}`;
    return { apiVersion: 1, kind: kind as DiagnosticSection['kind'], label: 'Simulated ' + kind, availability, text, observedAt: iso(Date.now()), truncated: false, previous };
  };
}
