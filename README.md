# Service Board

A Node 24 / TypeScript / Svelte kiosk dashboard for logical service health. One process serves the compiled frontend and JSON API; no application accounts or database. The default configuration starts a completely offline, 34-service demo.

## Start

```sh
# Node 24 LTS
npm ci
npm run build
npm start
# Open http://localhost:8098
```

For WSL, load nvm first if Node is not on the noninteractive shell path:

```sh
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
```

`npm run dev` watches backend files; run `npx vite --host 127.0.0.1` in another terminal for frontend development. Vite proxies /api to localhost:8098. Production uses one origin.

```sh
docker compose up -d --build
# Optional port override if the prototype already occupies 8098:
BOARD_PORT=8129 docker compose up -d --build
```

Compose loads a root `.env` if present, runs as UID 1000, drops capabilities, uses a read-only filesystem and bounded /tmp, and mounts config/modules read-only. It does not require `secrets.json5` for the demo. No upstream sources, brokers, databases or custom modules are initialized in demo mode.

## Configuration

Edit [config.json5](./config.json5); put credentials in an ignored `secrets.json5` using [secrets.example.json5](./secrets.example.json5). Config paths are selected with `--config` / `--secrets` or `CONFIG_FILE` / `SECRETS_FILE`. `--demo` / `--live` override the mode. All other values come from JSON5.

References like `'${API_TOKEN}'` expand only when they occupy the entire string, recursively after JSON5 parsing and before validation. Missing variables become null, empty variables remain empty, and values are never coerced. Partial strings are untouched. Use `headerRefs`, `usernameRef`, `passwordRef` and explicit plugin `secretRefs`; do not put credentials in normal config or URLs.

Schemas live in [config](./config). `npm run schema` regenerates them from the runtime contracts. Runtime validation also checks references, cycles, source compatibility, adapter parameters and module schemas. Invalid live configuration fails startup. A module import failure or deadline leaves its checks unknown; an available module with an invalid API contract or invalid instance parameters fails validation.

The plugin directory is relative to the config file. Credential/certificate mount paths should be absolute. Copying a file from `config/` to the repository root requires changing `plugins.directory` from `../checks` to `./checks`.

The [minimal live example](./config/live.example.json5) and [integration template](./config/integrations.example.json5) deliberately require your endpoint variables. Supply source addresses, namespaces, credentials, queries and thresholds before switching to live mode. The previous prototype's addresses are not assumed current. No agent kubeconfig or credentials are included.

## Themes and custom layouts

Set the default `uiDefaults.theme` in `config.json5`:

| Value | Appearance |
| --- | --- |
| `reference` | Reference layout with saturated green, orange, red and blue cards |
| `dark` | Phox styleguide dark surfaces and semantic neon accents |
| `light` | Phox styleguide light surfaces and ink colors |
| `contrast` | Near-black surfaces, stronger borders and high-contrast status text |
| `tron` | Midnight surfaces, cyan controls and bright status-colored outlines |

Choose **Options → Theme** to override the default for every browser. Theme and compact mode sync on the next status poll and survive backend restarts; choose **Use default** to follow `config.json5` again.

Theme and font tokens are root-driven. The whole application uses the styleguide's monospace stack, including the reference theme. The compact toolbar and card grid intentionally replace the styleguide demo's hero layout. Status fills are intentionally more saturated for viewing from a distance. Names lead each card; compact mode halves the grid gaps and reduces padding, card height and supporting text. Each component has a labeled state symbol: ■ healthy, ▲ degraded, × failed, ? unknown, Ⅱ paused. Additional components beyond eight are counted and available in the tooltip and diagnostics.

Choose **Order → Custom**, then **Arrange cells**. Save multiple named layouts, select them in the toolbar, rename/delete them, drag cards, or use the accessible up/down controls. New inventory entries append alphabetically; missing IDs never render phantom cards. Saved display preferences and named orders are shared through the backend. Locked clients receive updates but cannot edit them. Server defaults can seed `uiDefaults.customOrders: { "Wall": ["garmin", "nextcloud"] }`. Inventory and check policy cannot be overridden from localStorage.

Diagnostics open automatically for fresh confirmed failures. Manual tile/tab/pod/container selection takes ownership; refreshes do not steal it. Explicitly closing the pane disables Auto. Re-enable Auto to return ownership. Unknown observations and API disconnects never count as recovery. Drag the divider or use arrows/Home/End; small screens use a drawer. Clicking a tile with the pane closed opens a native, focus-trapped modal.

## Checks and integrations

Built-ins cover reusable protocols: HTTP/GraphQL assertions, TCP, DNS, bounded ICMP, MQTT subscriptions, Prometheus scalar/vector queries, parameterized read-only Postgres, and Kubernetes workloads/pods/jobs. Complex integration logic belongs in [custom modules](./docs/modules.md). Garmin has an example module instead of application-specific backend/UI code.

Checks support `interval`, `timeout`, `staleAfter`, `failureAfter` and `recoveryAfter` overrides with explicit units. First trustworthy success can pass immediately. First failure becomes degraded; a later consecutive observation at/after the confirmation window promotes it. Recovery also requires evidence across its window. Old sample timestamps cannot advance a transition. Stale or untrusted evidence is unknown.

Required inputs roll up critical → unknown → warning → healthy. Optional failures can only degrade an otherwise healthy service. Required paused inputs degrade running services; all paused becomes paused. Dependencies are explicit and acyclic. A service's status does not get a second debounce window.

- HTTP defaults to GET, no redirects, verified TLS, and 2xx success. Status 401/403 is an observer authorization problem unless explicitly configured as target failure. Header values may come from secrets. Cross-origin redirects never forward credentials.
- GraphQL checks use configured queries/variables; nonempty errors fail even with HTTP 200. No browser-supplied queries.
- Assertions use dotted own-property paths and eq/gt/gte/lt/lte/range/timestamp operators. Numbers are not coerced from strings. Missing/null fields are unknown. Timestamp strings require timezone offsets; numeric timestamps are epoch milliseconds.
- MQTT shares one connection per named broker, uses exact declared topics, acknowledges subscriptions and never publishes. LWT Online is insufficient for freshness. Retained messages require trustworthy producer timestamps; otherwise wait for live telemetry. Local-time timestamps must be normalized by the producer or a module.
- Postgres uses bounded pools, read-only transactions, bound parameters, a 10s statement ceiling, check deadlines, at most configured maxRows (default 100), and a 256 KiB returned-data budget. Always use a read-only database role. Use the module helper for integration-specific queries.
- Kubernetes supports named clusters, explicit namespace allowlists and static token/client-certificate kubeconfigs or explicitly configured in-cluster credentials. Exec/OIDC credential providers are intentionally unsupported because their refresh processes cannot be reliably canceled. Namespace discovery, exec and mutations are absent. Owner references scope Deployment → ReplicaSet → Pod and CronJob → Job → Pod relationships.
- [custom.kubernetes-prometheus.mjs](./checks/custom.kubernetes-prometheus.mjs) is the alternate kube-state-metrics observer; it checks scrape health, sample freshness, metric coverage and duplicate exporters. Pair it with a Kubernetes API check when pod diagnostics are needed.
- ICMP uses iputils ping with validated argument arrays. If the host requires it, opt into only NET_RAW in Compose. Unavailable ICMP reports unknown.

## Runtime options and modules

`uiDefaults.optionsEnabled` controls the Options sidebar and runtime API. It contains theme overrides, compact cells, keep-screen-awake status, pause browser updates, refresh checks, module watch/reload, and demo scenarios. `plugins.allowHotReload` enables module controls; `plugins.watch` starts watching at boot. Server runtime toggles are memory-only and reset at restart; shared display preferences persist in display-settings.json beside the config (override with server.preferencesFile or DISPLAY_SETTINGS_FILE). Fullscreen, diagnostic selections and unlock credentials remain browser-local.

Reloads replace isolated workers, invalidate old health/diagnostics, validate the new schema and discard pre-reload results. File changes for already enabled modules can be watched. Adding/removing enabled types or changing inventory/config/secrets still requires a restart. Config files are never edited in the browser. [Module SDK and examples](./docs/modules.md) describe declarative card overrides and diagnostic extensions.

See [kiosk display and screen sleep](./docs/kiosk.md) for browser wake locks, HTTPS requirements and OS logout limitations.

## Example plugins

The [examples gallery](./examples/README.md) includes MQTT, Postgres, fetch/JSON, Modbus TCP, GraphQL and Prometheus modules with complete config/secrets templates. The [local protocol lab](./examples/lab/README.md) exercises all six without production credentials or devices.

## Diagnostics, API and operations

See [API and operational limits](./docs/operations.md). Logs are fetched only for a selected service, bounded and rendered as text. Known configured secrets are redacted. Remote logs can still contain unknown sensitive data; this is an internal board.

Network clients always receive a read-only status view until unlocked. Set the optional `SERVICE_BOARD_UNLOCK_CODE` backend environment variable to enable an **Unlock** button for full diagnostics and runtime controls. Checks and filtered Probes remain visible while locked; logs, descriptions, events, raw evidence and controls require unlocking. After validation, the code is remembered under `service-board.unlock-code` in browser local storage; **Lock UI** removes it. Every API request is checked by the server, and changing the code invalidates old saved codes. With no environment key, LAN unlocking is disabled. Localhost keeps full access by default; set `server.localLock: true` to require the same key locally. `server.remoteAccess: 'full'` is no longer accepted. Status summaries still disclose service names and monitored device states.

Prefer running outside the monitored cluster so a cluster outage does not remove the board. External hosts need routable Kubernetes, MQTT, database and Prometheus addresses; ClusterIP and `*.svc.cluster.local` addresses do not normally work outside the cluster. No live endpoints are assumed or probed by the demo.

The optional [Kubernetes examples](./deploy/k8s) contain a Deployment, Service, ConfigMap, optional Secret mount and namespace-scoped read-only RBAC. Review and adapt them in your normal deployment workflow. No live cluster resources are modified.

## Probes

`GET /livez` returns HTTP 200 when the process and listener can answer, without contacting upstream services. `GET /readyz` returns HTTP 200 once configuration and the scheduler are initialized, or HTTP 500 when not ready. Both include `ok`, service/probe names, version, build hash and matching correlation metadata. A monitored target outage leaves both probes healthy because displaying outages is the board's job.

```sh
curl -f http://localhost:8098/livez
curl -f http://localhost:8098/readyz
```

## Verification and release

```sh
npm ci
npm run schema
npm run check
npm test
npm run build
npx playwright install chromium
npm run test:browser
npm run test:docker # Optional disposable Postgres container; requires Docker.
docker compose config --quiet
docker build --build-arg BUILD_HASH="$(git rev-parse --short=12 HEAD)" -t service-watcher-kiosk:local .
node scripts/smoke-container.mjs service-watcher-kiosk:local
```

Browser tests create their own offline test configuration and use port 8128. Backend integration tests use ephemeral local servers, a simulated MQTT broker and isolated workers; they need no production credentials. The separate Docker test starts and removes a disposable Postgres container to verify read-only transactions, bound values, row limits and cancellation. Fixtures cover all five states, 34 services, stale Garmin import, 503/429, observer failures, retained MQTT replay, logs/containers/events and recovery/API outage scenarios.

Build metadata is generated at build time and included in startup logs, /livez and /readyz. Monitored outages do not fail readiness because monitored targets are not dependencies for serving this board. Following the newer styleguide, process probes are /livez and /readyz; the spec's older /healthz alias is intentionally omitted. JSON5, named orders and hot reload also supersede the original handoff's YAML/restart-only sections.

### Tag, build and publish

Run from a clean committed checkout, with Git origin and both registry logins configured. Replace the account and registry placeholders. This publishes tags only when you run it:

```sh
USERNAME=yourusername
DOMAIN=yourdomain.xyz
IMAGE_NAME=service-watcher-kiosk
# VERSION="dev"
VERSION=v0.1.0

git tag -a "$VERSION" -m "$VERSION"
git push origin "$VERSION"
# git push --force origin "$VERSION"

SHA=$(git rev-parse --short=12 HEAD)

docker build --build-arg BUILD_HASH="$SHA" --build-arg BUILD_VERSION="$VERSION" -t "$IMAGE_NAME:build" -f ./Dockerfile .

for TAG in latest "$VERSION" "$VERSION-$SHA"; do
  docker tag "$IMAGE_NAME:build" "$USERNAME/$IMAGE_NAME:$TAG"
  docker tag "$IMAGE_NAME:build" "$DOMAIN/$USERNAME/$IMAGE_NAME:$TAG"
  docker push "$USERNAME/$IMAGE_NAME:$TAG"
  docker push "$DOMAIN/$USERNAME/$IMAGE_NAME:$TAG"
done
```

`BUILD_VERSION` and `BUILD_HASH` are embedded into the image and used by startup logs and both probes. Deploy the `VERSION-SHA` tag for an exact rollback target. Prefer a new version over force-moving a published tag.

Use [scripts/release-image.sh](./scripts/release-image.sh) from a clean committed tree. Set IMAGE; it builds version/hash, version and latest tags. Only `PUBLISH=true` pushes them. Deploy the immutable version/hash tag. No image publishing is done during implementation.

Architecture: shared runtime schemas/contracts, a pure health engine, adapter I/O, source managers, isolated plugin workers, bounded scheduler/diagnostics, same-origin API and Svelte presentation. The original specification and example pictures are preserved.
