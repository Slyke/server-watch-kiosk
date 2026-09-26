# Example integrations

These are operator-installed **backend check modules** for Service Board. They are normal ES modules with JSON Schema parameters, executed by the host in isolated child processes. They are not Codex plugins.

| Module | Demonstrates |
| --- | --- |
| [Fetch / JSON](./plugins/custom.fetch-json.mjs) | Auth header from a secret, application readiness, payload freshness, card text/icon |
| [MQTT telemetry](./plugins/custom.mqtt-telemetry.mjs) | Shared subscription, JSON measurement, retained timestamps, thresholds |
| [Postgres freshness](./plugins/custom.postgres-freshness.mjs) | Read-only parameterized query, business timestamp, age thresholds |
| [Modbus TCP register](./plugins/custom.modbus-register.mjs) | Custom protocol I/O, bounded framing, cancellation, signed/scaled data, diagnostics |
| [GraphQL health](./plugins/custom.graphql-health.mjs) | Application-specific query, partial/error response handling |
| [Prometheus value](./plugins/custom.prometheus-value.mjs) | Single-series cardinality, sample timestamps, thresholds |
| [Existing Garmin example](../checks/custom.garmin.mjs) | Integration-specific import query |
| [Existing kube-state-metrics example](../checks/custom.kubernetes-prometheus.mjs) | Scrape health, rollout/generation checks, duplicate exporters |

The [plugin walkthrough](./plugins/README.md) explains each module. The [SDK reference](../docs/modules.md) covers host helpers, result fields, diagnostics, isolation and hot reload.

## Try every protocol locally

The [protocol lab](./lab/README.md) uses real local MQTT and Postgres services and synthetic HTTP, GraphQL, Prometheus and Modbus endpoints. It starts the board in **live mode** so the actual scheduler, helpers and modules run. All displayed data is synthetic.

From the repository root:

```sh
docker compose -f examples/lab/compose.yml build board
docker compose -f examples/lab/compose.yml up -d --wait
# Open http://localhost:8131
docker compose -f examples/lab/compose.yml down
```

Only the dashboard is published, on loopback. Lab database storage is temporary and intentionally discarded on stop. All lab credentials are public examples.

## Adapt the modules to your services

1. Use [config.json5](./config.json5) as a template; remove integrations you do not need. This template does not inherit or merge the repository-root config.
2. Copy [secrets.example.json5](./secrets.example.json5) to `examples/secrets.json5` (ignored by Git). Provide real values there, or export its referenced environment variables.
3. Set the whole-value URL/host environment references used in config: `MQTT_URL`, `PG_HOST`, `PROMETHEUS_URL`, `API_URL`, `GRAPHQL_URL`, `MODBUS_HOST`. Set `PG_USERNAME`, `PG_PASSWORD`, `API_TOKEN` if using the secret template's environment references. Native Node does not automatically load `.env`; Compose does when configured.
4. Adapt the Postgres database/table/query, exact MQTT topic and fields, device register map, API queries and thresholds. The template is deliberately illustrative, not autodiscovery.
5. Build and run:

```sh
npm ci
npm run build
node dist/server/main.js --config examples/config.json5 --secrets examples/secrets.json5 --live
```

The module directory is resolved relative to the config file. This config's `./plugins` means `examples/plugins`. If you copy the config to the repository root, change it to `./examples/plugins`. If copying modules into another directory, copy their `lib/` directory too.

For production containers, mount the plugin directory at `/app/checks:ro` or bake it into a derived image, and set `plugins.directory` accordingly. No additional npm packages are needed for these six examples. Modules needing other packages must have those dependencies installed during the image build.

## Choose a built-in or a module

Use built-ins for a simple status-code probe, TCP/DNS/ICMP availability, standard MQTT freshness or a basic scalar assertion. Use a module when the meaning of a response needs custom logic, a database schema needs interpretation, or a protocol such as Modbus is not built in.

A service may reference several checks, including both built-ins and custom checks. The template's **Import pipeline** combines required API/database checks and an optional queue check, so component symbols show their individual states.

## Presentation and diagnostics

Set `allowPresentation: true` on the check to enable its icon/text overrides. A module may also return:

```js
presentation: {
  background: '#00682a',
  foreground: '#ffffff',
  border: '#39ff79',
  icon: '↻',
  title: 'Import worker',
  text: 'Last success 30s ago',
  textMode: 'wrap',
}
```

Colors must be six-digit hex strings. Keep state meaning and contrast readable; the host still owns the health label and component symbols. Expired observations discard presentation overrides. The Modbus module includes a `probes` diagnostic provider showing how to add bounded, plain-text evidence.

Use **Options → Reload modules** after editing. **Watch module files** notices changes to top-level module files; changes in `lib/` need a manual reload. New enabled types or config/secrets changes require a restart.

## Verify changes

```sh
npm run test:examples
npm run check
npm run build
```

Example tests use local fake peers and injected helper responses; they do not access your services. The protocol lab separately exercises all helpers against local services.
