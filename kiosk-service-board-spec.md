# Kiosk service board — implementation specification

Status: ready for implementation handoff  
Owner decisions captured: 2026-09-23  
Working name: Service Board

## 1. Purpose and implementation brief

Build a compact kiosk dashboard showing the health of logical services as a grid of colored, approximately square tiles. A service can include several Kubernetes workloads, databases, caches, external endpoints, devices, and freshness checks. Failed services move to the front. A resizable diagnostics pane explains failures without leaving the board.

Implement the production application with **Node.js and Svelte**. Use TypeScript for application code and shared contracts; support ordinary JavaScript ES modules for operator-written plugins. Compile the Svelte frontend and serve it with the Node backend from one origin and one container. SvelteKit and server-side rendering are not required.

**Persistence is deliberately simple:**

- User display and interaction preferences live in browser localStorage.
- Inventory, grouping, health rules, check parameters, plugin configuration, and application defaults live in configuration files.
- Credentials, private keys, and tokens live in separate secret files or referenced mounted credential files.
- Check results, diagnostics caches, subscriptions, and scheduler state live in memory. There is no application database or server-side user-settings store.
- Postgres is a monitored data source, not storage for this application.
- Existing Prometheus may retain exported health metrics; durable logs and history remain with existing systems.

Use the current prototype as the visual and interaction reference, then replace its backend and frontend with the specified stack. The prototype is not a production integration contract.

### Existing handoff material

Paths below are relative to this document:

- [Prototype and README](../namespaces_and_services/monitoring/status-board/README.md)
- [Current UI markup](../namespaces_and_services/monitoring/status-board/static/index.html)
- [Current UI behavior](../namespaces_and_services/monitoring/status-board/static/board.js)
- [Current styles](../namespaces_and_services/monitoring/status-board/static/style.css)
- [34-service demo fixtures](../namespaces_and_services/monitoring/status-board/demo.py)
- [Initial inventory](../namespaces_and_services/monitoring/status-board/config.json)
- [Demo with diagnostics](service-board-assets/demo-diagnostics.png)
- [Demo grid](service-board-assets/demo-grid.png)
- [Coding standards snapshot](service-board-coding-style.md)

The local prototype was previewed at http://127.0.0.1:8098/. This address is a development convenience, not a production endpoint.

Preserve the existing demo while building the replacement in a separate directory, such as `apps/service-board/`. Do not delete or overwrite the prototype until the replacement meets the acceptance criteria. Do not copy the old environment-variable configuration model or placeholder deployment unchanged into the new application.

## 2. Scope and decisions

### Required in the first complete release

- Node backend, Svelte frontend, one deployable container.
- Dense tile board, failure-first sorting, compact top controls, responsive resizing.
- Explicit logical service grouping, required/optional checks, and dependencies.
- Multiple Kubernetes clusters and several instances of each external source type.
- Read-only Kubernetes workload checks and live pod diagnostics.
- HTTP, GraphQL, ICMP ping, TCP, DNS, MQTT, Prometheus, and Postgres checks.
- File-loaded custom JavaScript check plugins.
- Automatic diagnostics, manual inspection, modal behavior, and local preferences.
- Deterministic demo mode with at least the existing 34 services.
- Validated config/secrets files, documented examples, Docker Compose deployment.
- Automated tests of health semantics, isolation, API boundaries, and user interactions.

### Outside this release

- Editing inventory, secrets, SQL, or plugins through the browser.
- Kubernetes remediation, shell/exec access, pod restarts, device control, or MQTT commands.
- Accounts, application-owned authentication, cross-device preference synchronization.
- Built-in metric/history database, log ingestion platform, alert delivery, or escalation system.
- Arbitrary browser-uploaded plugins or an untrusted-code marketplace.
- Automatic discovery that guesses application/database relationships from names.
- An in-cluster agent fleet. A collector split can be added later if network access requires it.

Existing Grafana, Prometheus, Alertmanager, blackbox-exporter, and Loki can complement the board. The custom application owns the board interactions; it does not need to be a Grafana dashboard or plugin.

## 3. UI and kiosk behavior

### Layout

Remove the entire large heading/hero area. The top of the viewport contains one slim control bar, approximately 44–48 px tall on a desktop kiosk. It contains:

- Status legend, with text as well as colors.
- A visible Demo indicator when applicable.
- Last successful refresh age and connection/freshness indication.
- Sort selector, Auto diagnostics toggle, Diagnostics button, Full screen button.

Keep these on one line at normal kiosk widths. At narrow widths, allow compact wrapping without horizontal page overflow. There must be no decorative top section competing with the grid.

The remaining viewport contains the tile grid and, when open, a right-hand diagnostics pane. Use available space efficiently. Recalculate columns and tile dimensions when the viewport or split changes. Keep tiles approximately square at normal desktop widths; allow vertical scrolling when needed instead of making text unreadable or cutting off content. Long labels and reasons should truncate in a tile and remain fully available in details.

Each tile shows the service name, state in text/icon/color, a concise reason, and enough component information to explain partial availability. A healthy Kubernetes Deployment alone must not label the whole service healthy when its required database or import freshness check is failing. Do not show raw configuration or internal implementation details in normal tile content.

Color mapping:

| State | Label | Color | Meaning |
| --- | --- | --- | --- |
| `healthy` | Healthy | Green | Required observations pass |
| `warning` | Degraded | Yellow/amber | Partial health, threshold warning, or initial failure confirmation |
| `critical` | Failed | Red | Confirmed required failure |
| `unknown` | Unknown | Slate/blue-grey | Current health cannot be established |
| `paused` | Paused | Neutral grey | Explicit maintenance/disable or configured intentional inactivity |

Do not rely on color alone. Focus indicators, selected-tile outline, keyboard access, and readable contrast are required.

### Sorting

Default order is `critical`, `unknown`, `warning`, `healthy`, `paused`. Within each state use configured priority descending, then display name, then stable service ID. Re-sort only when a relevant sort key changes. New failures move forward without random movement on every refresh.

Also support alphabetical sorting. Persist the selected mode. Keep the inspected service selected by ID even if its tile moves; keyboard focus must remain attached to the same service.

### Manual inspection

- Clicking a tile while diagnostics is closed opens a modal for that service.
- Clicking a tile while diagnostics is open selects that service in the right pane.
- The modal closes with its close button, Escape, or a click on the backdrop outside the dialog.
- Clicking or dragging within the dialog must not close it.
- Trap focus inside a modal and restore focus to the originating tile when it closes.
- The Diagnostics button opens or closes the side pane. When opening manually, retain the current selection if valid; otherwise choose the first failed service, then the first visible service.

The pane uses a **vertical divider with the two panes side by side**. The divider is draggable and keyboard accessible, with left/right arrows and Home/End adjustments. Persist the width as a fraction of available space, then clamp it to the current viewport. At a desktop width, aim for at least 280 px for the grid and 320 px for diagnostics. When both cannot fit, use a full-width diagnostics drawer with an explicit return to the grid; retain the desktop split preference for later.

Each pane scrolls independently. Resizing must not reset log position, selected service, pod, container, or tab.

### Diagnostics contents

Show the service summary, its checks and dependencies, and relevant diagnostic tabs:

- Checks: current outcomes, reasons, observation ages, confirmation state, and dependency failures.
- Pod logs: pod/container selection, current or previous container logs, timestamps.
- Description: a structured pod/workload description, including conditions, images, replica counts, restart counts, and termination reasons.
- Events: recent relevant Kubernetes events with time, reason, count, and message.
- Probes: external HTTP/GraphQL errors, ping loss, TCP/DNS failures, MQTT availability/freshness, or database query outcomes.

Only show applicable tabs. A Kubernetes service can include a failing external/database check; retain that check's probe evidence alongside its pod diagnostics. Distinguish loading, empty output, unavailable permissions, timeout, and an actual target failure.

Render logs and remote text as text, never executable HTML. Do not fetch logs for every tile or include all log bodies in the status snapshot.

## 4. Automatic diagnostics state machine

Auto diagnostics is **on by default** and stored as a browser preference. “Failing” for automatic opening means a service with a fresh, confirmed `critical` state. Degraded, unknown, and paused services remain manually inspectable but do not open the pane by themselves.

1. When Auto is enabled and one or more services fail, open the pane and select the first failed service under severity/priority/name ordering.
2. Show a selector listing all failed services. Do not rotate between them on a timer.
3. On an automatic selection, prefer a pod/container with non-whitespace logs. If none has usable logs, select a pod description. If neither is available, select probe evidence, then the check summary.
4. Prefer evidence from the failed component and its unhealthy pods. Do not default to a healthy database's logs when the importer is failing. Search the relevant pods within the bounded diagnostics budget; do not use arbitrary unrelated pod logs.
5. Start with a loading state while availability is determined. Try current logs first; previous logs may be used for a restarting container and must be labeled. Forbidden, timed-out, absent, or empty logs permit fallback to description. If a description is also unavailable, display the reason and continue to probes/checks.
6. If the user selects a tab before discovery completes, the late response must not override their choice. Subsequent refreshes must preserve manual tab, pod, and container selections.
7. While the pane remains automatically owned, keep the chosen failure until it recovers. A new higher-priority failure does not repeatedly steal selection. After confirmed recovery, select the next failure.
8. Close an automatically owned pane once all tracked failures have fresh, confirmed non-failing observations. Unknown/stale/unreachable observations do not count as recovery. Keep the unresolved failure visible with a stale/unknown explanation until current evidence resolves it.
9. Selecting a tile, failure, pod, container, or tab explicitly takes manual ownership. Refreshes may update content but must not change selection or close the pane.
10. Closing the pane explicitly disables Auto diagnostics and saves that preference. Re-enabling Auto relinquishes manual ownership and immediately evaluates current failures.
11. A manually opened pane may stay open after everything recovers. Automatically opening a pane must not overwrite the persisted manual-open preference.
12. Removing a service from the configured inventory clears an invalid selection. Do not label removal as recovery. A configuration restart resets in-memory failure history; unknown startup data must not be treated as a newly confirmed failure.

Model pane ownership explicitly (`closed`, `auto`, `manual`), separately from the Auto preference and selected service. Avoid inferring ownership merely from whether the pane is visible.

## 5. State, timing, and service aggregation

### Check observations

A check returns a raw outcome and evidence. The core owns scheduling, timestamps, freshness validation, transition confirmation, and the resulting effective state.

Use UTC RFC 3339 timestamps in the API. Duration configuration uses explicit units such as `5s`, `30s`, and `24h`. Capture both server wall time and monotonic elapsed durations where applicable.

Keep these meanings separate:

- Last attempt/completion: the checker ran, successfully or otherwise.
- Last trusted observation: the target/source supplied usable current evidence.
- Event time: a business event such as the last successful Garmin import.
- Last success: the check's condition most recently passed.
- Snapshot time: when the board assembled its response; this must not refresh old observations.

Defaults, configurable in server files:

| Setting | Default |
| --- | --- |
| Check interval | 30 s |
| Check deadline | 5 s; Postgres may override to 10 s |
| Browser status poll | 5 s |
| Maximum observation age | 120 s; adapter-specific override allowed |
| Failure confirmation | 30 s |
| Recovery confirmation | 30 s |
| Scheduler concurrency | 8 |
| Diagnostics concurrency | 4 |
| Diagnostics request deadline | 5 s per operation, 15 s overall selection budget |
| Diagnostics cache lifetime | 5 s |
| Future timestamp tolerance | 30 s |

Prevent overlapping runs of the same check. Bound source concurrency and queues; cancel or skip superseded work. Add small scheduling jitter in live mode. Other checks and the UI must continue when one check is slow or broken.

### Transition rules

- Startup is unknown until evaluated. A first trusted good result can become healthy immediately.
- A newly observed critical condition becomes warning immediately with “confirming failure,” then critical after the failure window is supported by consecutive completed observations.
- Do not promote a single old sample to critical merely because wall time passed; require a subsequent observation at or beyond the deadline.
- Once critical, retain critical during recovery confirmation. Move to the new trusted noncritical state only after the recovery window; show the pending recovery in details.
- Unknown is immediate when evidence is unavailable/untrustworthy and interrupts confirmation continuity. Preserve the last known state separately for context, never as a current green assertion.
- Staleness expires observations even when a collector is stuck and produces no new results.
- Explicit maintenance/disable produces paused immediately and is identified as an operator configuration choice.
- Run check transition logic once. Do not add a second full debounce window at service aggregation.

A transport failure to a directly probed target (for example refused HTTP/TCP connection or ping loss) is evidence for a failed check. Failure to access an observer (for example Kubernetes authorization denied or an MQTT broker disconnect) makes dependent observations unknown. Expose the observer problem clearly; a separate direct observer-health check can show that observer as failed.

### Aggregation

Checks are referenced as required or optional per service. A required service dependency contributes its effective state and reason as another required input.

For active required inputs: critical dominates unknown, which dominates warning, then healthy. A paused required input alongside running inputs degrades the service. If all required inputs are intentionally paused and there is no fresh required failure, the service is paused.

Optional non-healthy inputs can raise an otherwise healthy service to warning, but cannot make it critical or hide a required critical/unknown result. An optional paused input does not degrade the service. At least one required check or dependency is needed for a normal enabled service.

Show both the service's own failing checks and upstream dependencies. Do not hide a healthy app workload behind a vague dependency message; explain, for example, “App ready; Postgres unavailable.”

Validate dependency graphs as acyclic. Missing references and duplicate IDs are configuration errors. A shared MQTT broker or database can be modeled once and referenced by several services.

### Browser freshness

On a failed status fetch, retain the last layout and diagnostic selection, mark connection loss, and show current tile health as unknown with the previous state labeled as historical. Do not leave stale green tiles appearing current.

On a successful response, evaluate each observation's freshness and the snapshot age. A fresh HTTP response containing expired observations is still unknown. Use server-reported age/time plus elapsed browser monotonic time to avoid requiring synchronized kiosk clocks. An API outage must not trigger automatic pane closure as “recovery.”

“Last refresh” means the last successful status fetch. Source/check ages remain separately visible.

## 6. Built-in checks

Built-ins and plugins use the same result contract and service aggregation. Common tasks must be configurable without custom code.

| Check type | Required behavior |
| --- | --- |
| `kubernetes.workload` | Deployment, StatefulSet, DaemonSet; desired/ready/available/updated state, observed generation, rollout conditions, associated pods |
| `kubernetes.pods` | Explicit names or label selector within a cluster/namespace; readiness, scheduling, container waiting/termination, restarts |
| `kubernetes.job` | Job/CronJob completion, failure, active executions, configurable last-success freshness |
| `http` | Configured GET/HEAD, expected 2xx by default, timeout, latency thresholds, optional JSON assertions |
| `graphql` | Configured query and variables, HTTP/GraphQL error handling, data-path assertions, numeric or timestamp evaluation |
| `ping` | ICMP reachability, loss/latency thresholds, multiple bounded samples |
| `tcp` | Connect to configured host/port within deadline |
| `dns` | Query chosen resolver/type; assert expected answers or successful resolution and latency |
| `mqtt` | Observe configured telemetry/LWT topics, connectivity, payload assertions, business timestamp and/or message freshness |
| `prometheus` | Instant PromQL query, explicit result reduction, numeric/timestamp/boolean condition |
| `postgres` | Read-only parameterized SQL, scalar value/timestamp assertions, bounded execution |
| Custom module type | Same scheduling, results, diagnostics, and status semantics as a built-in |

### Kubernetes

Allow a cluster-level service tile that groups configured control-plane/API reachability checks and workload summaries. Source-health failures must be visible even when all dependent workloads become unknown. An API connection probe can be failed while the workloads it normally observes remain unknown; keep those meanings distinct. Cluster membership does not automatically make every workload a required dependency of this tile.

Support named sources for multiple clusters. Use a Kubernetes API client with operator-provided read-only kubeconfig files outside the cluster, or an explicitly configured service account inside it.

Use controller owner references and selectors to associate workloads with pods, including Deployment → ReplicaSet → Pod. Do not infer membership from pod-name prefixes. Include relevant namespace and workload events; filter them by involved object/UID. Follow paginated list responses and honor request deadlines.

Compare the workload's desired and ready/available state and whether the controller observed the current generation. Partial availability and an active rollout are warning; zero ready replicas with positive desired count is critical before confirmation. Respect StatefulSet update strategy/partition and DaemonSet update strategy so intentional strategies do not remain degraded forever. Treat restarts/CrashLoopBackOff/OOMKilled as configurable health evidence, with details.

A target missing from a successful authorized Kubernetes lookup is a failure. Missing metrics or failed/forbidden API access is unknown. An empty pod selector is unknown by default, with an explicit option to classify it as failure or intentional inactivity.

Intentional scale-to-zero may map to paused when configured. Do not treat a zero desired count as healthy availability. Jobs use completion semantics; a successfully completed pod is not an unhealthy long-running service.

Diagnostics must support selecting pod and container, init-container evidence, current/previous logs, recent events, and descriptions without invoking `kubectl exec`. Use API responses to build descriptions rather than shelling out to `kubectl describe`.

Permit Kubernetes metrics through Prometheus as an alternate workload-observation mode. Check kube-state-metrics scrape health, sample freshness, and selector coverage. Avoid duplicate scrape series producing inflated replica counts. Prometheus-derived health must identify its source; pod logs/descriptions still require Kubernetes API access. A source that was unavailable must not turn its workloads green based on old cached metrics.

Read-only RBAC example must cover only necessary resources: configured workloads and ReplicaSets in `apps`; Jobs/CronJobs in `batch`; Pods, `pods/log`, and Events, plus the appropriate events API if used. Use `get/list/watch` only where needed, `get` for `pods/log`. Namespace discovery should be opt-in. No Secrets, pod exec, mutation verbs, or node proxy permissions.

### HTTP and GraphQL

HTTP succeeds on configured expected status codes, default 200–299. Redirect following defaults off; an SSO redirect or HTML login page is not readiness. Optional expected content type and JSON assertions can detect HTTP 200 error pages. TLS verification defaults on; support mounted CA/client certificates. Do not expose auth headers.

A GraphQL HTTP 200 containing nonempty `errors` is a failure by default, including partial data, unless an explicit policy handles particular errors. Missing asserted data is unknown, not silently false/zero. Support variables and secret references; never concatenate user-provided browser input into queries.

Provide shared assertions for equality, boolean values, numeric comparison/ranges, and timestamp age. Assertions use declarative operators and data paths, not JavaScript `eval`. Numeric values must be finite; document coercion rather than treating arbitrary strings as numbers.

Observer credential errors should be visible as unknown with an authentication reason unless the configured check explicitly treats that status as a target failure. Ordinary unexpected target 4xx/5xx and transport failures fail the check. A healthy HTTP response does not claim that a background task succeeded.

### Ping, TCP, and DNS

Use configured destinations only. ICMP must work with least container privilege (for example a documented `NET_RAW` capability when required by the chosen implementation). Do not require a privileged container. If ICMP is unavailable, report unknown with the permission reason; do not silently substitute TCP and call it ping.

Never interpolate destinations into shell command strings. Use libraries or argument-array subprocess execution with validated hosts. Check cancellation must terminate child processes. TCP and DNS remain available without ICMP privileges.

### MQTT and Tasmota

Use one managed connection per configured broker, subscribe-only credentials, exact configured telemetry and LWT topics, reconnect backoff, and explicit subscription acknowledgment. No publishing of device commands.

An Offline LWT fails availability. Online LWT alone does not prove telemetry freshness. Broker/subscription failure makes dependent device observations unknown. Distinguish device loss from observer loss.

Retained messages received after startup/reconnect must not reset the freshness clock to “now.” A retained payload may establish freshness only through a valid producer timestamp with configured interpretation; otherwise wait for a live message. Preserve event time, receipt time, and retained flag as distinct metadata. Detect invalid/future timestamps. Device-local timestamps require an explicit timezone or epoch conversion.

Tasmota topics depend on the actual FullTopic configuration. Examples may use `tele/DEVICE/STATE` and `tele/DEVICE/LWT`, but real topics, reporting intervals, sleep schedules, and thresholds are configuration inputs. Sleeping devices need appropriate freshness policies.

### Prometheus

Use configured source URL and credentials; never expose arbitrary PromQL execution to the browser. Support scalar and instant-vector results with an explicit reduction (`single`, `min`, `max`, `sum`, or an intentional empty-result policy). Default `single` requires exactly one finite result.

Query errors, warnings, missing samples, unexpectedly many results, and expired observations become unknown unless an explicit documented result policy applies. Do not hide missing telemetry using a generic zero fallback.

Use source health/freshness checks where a custom query could otherwise return old values. Business freshness should be based on an event timestamp, not on when Prometheus returned the query.

### Postgres and Garmin

Use a least-privilege read-only database role. Run configured SQL with bound parameters in read-only transactions and enforce statement/query deadlines, row/response limits, and connection pool limits. SQL string inspection alone is not a security boundary. No browser-supplied SQL or arbitrary database selection.

Garmin uses a Postgres query returning exactly one last-success timestamp. The final query and schema are not yet supplied. The timestamp must mean the intended event—successful import completion or newest imported data—rather than just “the importer process ran.”

Default Garmin failure threshold is 24 hours. A suggested warning threshold is 20 hours, configurable. At `age >= criticalAfter`, the raw result is critical; at `age >= warningAfter`, it is warning. Null, no rows, multiple rows for a scalar result, invalid dates, or excessive future timestamps are unknown. Distinguish “no trusted timestamp” from “timestamp exists and is too old.”

Return the timestamp and age, not personal health records. Query failures should include a sanitized SQLSTATE/category and useful reason, not credentials or raw health data.

For the demo, Garmin must fail with a simulated successful import 28 hours ago against the 24-hour limit. No real database is needed to implement or verify demo behavior.

### OpenClaw and Bitaxe

OpenClaw should use the installed gateway's readiness endpoint and response contract, with a separate freshness check for any scheduled activity that matters. A process liveness endpoint alone may be insufficient.

Bitaxe must prove the miner is doing useful work, such as a valid hashrate above a configured threshold, rather than merely accepting HTTP. Add temperature/pool/share conditions only after verifying the actual firmware fields and appropriate thresholds.

The user suspects a GraphQL interface. The exact Bitaxe firmware and API remain unverified for their device. Stock ESP-Miner documentation includes a REST system-info endpoint at `/api/system/info`; do not invent a GraphQL endpoint/schema. Implement both generic HTTP JSON and GraphQL checks, then configure the actual device protocol when supplied. A custom plugin is optional for specialized device semantics.

## 7. Configuration and secrets

### File model

Use YAML configuration with a published JSON Schema and runtime validation. Use a separate YAML secrets map plus referenced mounted files for kubeconfigs, certificates, and keys. JSON may be accepted as an equivalent input, but YAML examples and behavior must be complete.

Launch arguments identify paths, for example:

    node dist/server/main.js --config /config/board.yml --secrets /run/secrets/board.yml

These are product paths, not paths to an agent's local credentials. Mount configuration, secrets, kubeconfigs, certificates, and plugin directory read-only. Populated secret files are ignored by Git and excluded from the image.

Required configuration areas:

- `schemaVersion`: versioned config format.
- `server`: bind address/port and request limits.
- `runtime`: scheduling/freshness/confirmation defaults.
- `uiDefaults`: defaults for allowed browser presentation preferences.
- `sources`: named Kubernetes, Prometheus, MQTT, Postgres, and reusable HTTP/GraphQL connection settings.
- `plugins`: directory and explicit enabled type IDs.
- `checks`: named instances with type, source/target, schedule overrides, and parameters.
- `services`: stable ID, display name, optional group, priority, check references, dependencies, links, and maintenance/enable state.
- `demo`: explicit offline demo behavior, preferably enabled by a launch flag.

The schema must validate adapter-specific parameters, unknown keys, duplicate IDs, missing references, cycles, invalid durations, invalid threshold ordering, contradictory options, and unsupported plugin API versions. Error messages name the file and config path without printing secrets.

Invalid structural configuration prevents live startup and returns a nonzero process exit with actionable errors. A referenced plugin file that is absent, an invalid enabled type ID, or adapter parameters rejected by an available schema are configuration errors. An enabled plugin file that exists but times out, crashes, or throws during import is an execution failure: start the board with its dependent checks unknown, report the load failure, and validate that plugin's parameters before any later successful execution. Runtime target/source failures keep the board running and produce unknown/failed observations. “Incomplete integration” examples should be explicitly disabled/paused or demo-only; do not quietly accept broken production config.

Restart is the first-release reload mechanism. Document that config/secret/plugin changes require a process restart. No file watching or hot-loading code is required.

### Illustrative configuration

The field names below form the intended configuration contract. Publish schemas and generated types consistent with them. Example hostnames, workload names, and SQL are placeholders, not discovered integration details.

~~~yaml
schemaVersion: 1
server:
  host: 0.0.0.0
  port: 8098
runtime:
  interval: 30s
  timeout: 5s
  staleAfter: 120s
  failureAfter: 30s
  recoveryAfter: 30s
  concurrency: 8
uiDefaults:
  autoDiagnostics: true
  sortMode: severity
  splitRatio: 0.60
sources:
  home:
    type: kubernetes
    kubeconfigFile: /run/secrets/home.kubeconfig
    context: home-readonly
  healthDb:
    type: postgres
    host: postgres.example.internal
    port: 5432
    database: health
    usernameRef: garminDbUser
    passwordRef: garminDbPassword
    tls:
      enabled: true
      caFile: /run/secrets/postgres-ca.pem
  devices:
    type: mqtt
    url: mqtts://mqtt.example.internal:8883
    usernameRef: mqttUser
    passwordRef: mqttPassword
plugins:
  directory: /app/checks
  enabled: []
checks:
  garminImporter:
    type: kubernetes.workload
    source: home
    params:
      namespace: health
      kind: Deployment
      name: garmin-importer
      zeroReplicas: paused
  garminDatabase:
    type: kubernetes.workload
    source: home
    params:
      namespace: health
      kind: StatefulSet
      name: garmin-postgres
  garminFreshness:
    type: postgres
    source: healthDb
    timeout: 10s
    params:
      query: >
        SELECT max(completed_at) AS last_success_at
        FROM import_runs
        WHERE provider = $1 AND status = $2
      values: [garmin, success]
      result:
        mode: timestamp
        cardinality: single
        column: last_success_at
        warningAfter: 20h
        criticalAfter: 24h
  minerActivity:
    type: http
    params:
      url: http://bitaxe.example.internal/api/system/info
      method: GET
      expectedStatus: [200]
      followRedirects: false
      assertions:
        - path: hashRate
          operator: gt
          value: 0
          failureState: critical
  kitchenDevice:
    type: mqtt
    source: devices
    params:
      topic: tele/kitchen/STATE
      lwtTopic: tele/kitchen/LWT
      onlineValue: Online
      offlineValue: Offline
      warningAfter: 10m
      criticalAfter: 15m
services:
  - id: garmin
    name: Garmin import
    group: Health
    priority: 100
    checks:
      - id: garminImporter
        required: true
      - id: garminDatabase
        required: true
      - id: garminFreshness
        required: true
    dependsOn: []
  - id: bitaxe
    name: Bitaxe
    group: Devices
    priority: 50
    checks:
      - id: minerActivity
        required: true
  - id: kitchen
    name: Kitchen Tasmota
    group: Devices
    priority: 20
    checks:
      - id: kitchenDevice
        required: true
~~~

`dependsOn` is a list of objects with `serviceId` and `required` (default true). `required` on check references defaults true. `links` is a list of `{label, url}` objects restricted to HTTP(S). An optional service `enabled: false` or `maintenance: true` produces paused and suppresses its scheduled checks where they are not shared by another active service.

A source ID is local to the board config, not a Kubernetes context inferred from the kiosk. Source references must resolve to a compatible source type.

Secrets file structure:

~~~yaml
schemaVersion: 1
values:
  garminDbUser: REPLACE_WITH_READONLY_USERNAME
  garminDbPassword: REPLACE_WITH_PASSWORD
  mqttUser: REPLACE_WITH_SUBSCRIBE_ONLY_USERNAME
  mqttPassword: REPLACE_WITH_PASSWORD
~~~

A `...Ref` resolves a key under `values`; literal secret values in normal config are unsupported. Add explicit header/token references for HTTP and GraphQL sources. Do not perform implicit environment or shell interpolation in YAML. Secrets must never be sent to the frontend, included in localStorage, printed in config dumps, or used as metric labels.

Known credentials should be redacted in diagnostic/error output. Also omit sensitive headers, connection strings, query parameter values, and unnecessary response bodies. Redaction cannot guarantee that arbitrary pod logs contain no sensitive data; expose diagnostics only behind the same trusted access boundary as the board.

### localStorage contract

Use one versioned key such as `service-board.preferences.v1`. Store only allowlisted user preferences:

~~~json
{
  "version": 1,
  "sortMode": "severity",
  "autoDiagnostics": true,
  "splitRatio": 0.6,
  "manualPaneOpen": false
}
~~~

Additional presentation preferences may be added with an explicit migration, but do not introduce new controls solely to fill this object.

Precedence: application defaults → configured `uiDefaults` → valid saved browser preferences. Server rules, thresholds, inventory, credentials, plugin configuration, and check intervals cannot be overridden through localStorage.

Validate values when reading, clamp split ratios, ignore unknown keys, and recover from corrupt/unavailable storage without breaking the UI. Persist only user changes, not transient automatic pane openings. Selection, diagnostic text, raw telemetry, health data, and credentials remain in memory. Full-screen mode requires a browser gesture and cannot be forced on page load.

Preferences are per browser profile/origin. There is no cross-kiosk sync. A persistent kiosk browser profile preserves preferences between restarts.

## 8. JavaScript plugin contract

### Discovery and lifecycle

Discover operator-installed `.js` and `.mjs` modules from the configured plugin directory at startup. `.js` uses ES module semantics in the documented plugin package layout. The filename stem is the type ID (for example `custom.example.mjs`); its exported `type` must match. Discover supported files in deterministic filename order and import only those listed under `plugins.enabled`. Reject duplicate/reserved IDs, including competing `.js` and `.mjs` files for the same type. Built-in types cannot be overridden.

Plugins are trusted backend code supplied by the operator. They never run in the browser. Dependencies must be packaged during the image/plugin build; do not run npm installs from the service at runtime.

Import/validation and execution must happen outside the main API/event-loop process. Use a supervised child-process runner or equivalent hard-terminable execution boundary. Enforce import, check, and diagnostic deadlines, output limits, crash backoff, and worker concurrency. A hanging top-level import or synchronous infinite loop must not freeze the board. An AbortSignal alone is insufficient for synchronous code.

Process isolation protects availability, not confidentiality from a malicious trusted plugin. Do not describe Node's `vm` module or a child process as a secure sandbox. Run only trusted modules and use normal container/user permissions.

### Module shape

~~~javascript
export default {
  apiVersion: 1,
  type: "custom.example",
  configSchema: {
    type: "object",
    additionalProperties: false,
    required: ["target"],
    properties: {
      target: { type: "string" }
    }
  },

  check: async ({ config, context, signal }) => {
    const observation = await context.http.getJson({
      url: config.target,
      signal
    });

    return {
      state: observation.body.ready ? "healthy" : "critical",
      reason: observation.body.ready ? "Ready" : "Readiness failed",
      observedAt: observation.receivedAt,
      evidence: [
        { kind: "http", label: "Readiness", statusCode: observation.statusCode }
      ]
    };
  }
};
~~~

Core-required exports: `apiVersion`, globally unique `type`, JSON `configSchema`, and `check`. Optional exports:

- `diagnose({ config, context, signal, request })`: structured diagnostic sections.
- `dispose({ context })`: best-effort cleanup on graceful worker shutdown; never relied upon after forced termination.
- Static capability metadata so the UI can discover relevant diagnostic categories.

`context` provides host-managed clock, redacting logger, declared secret lookup, and bounded HTTP/GraphQL/Postgres/Prometheus helpers. Built-in MQTT uses a shared broker manager; plugins can request subscriptions through a bounded context helper rather than creating one broker connection per check. Helper interfaces and serialization/RPC behavior must be documented for plugin authors.

A custom check may declare a top-level `secretRefs` array of keys from the secrets map. Resolve these through `context.secrets.get({ ref })`; undeclared keys are rejected by the helper. Secret lookup is restricted by the plugin instance's declared references for normal API use. This is a convenience/least-exposure boundary, not a claim that arbitrary Node code cannot access other mounted files.

### Result contract

~~~typescript
type State = "healthy" | "warning" | "critical" | "unknown" | "paused";

type CheckResult = {
  state: State;
  reason: string;
  observedAt?: string;
  eventAt?: string;
  evidence?: Evidence[];
  measurements?: Record<string, number | boolean | string>;
};

type Evidence = {
  kind: "http" | "graphql" | "ping" | "tcp" | "dns" | "mqtt"
    | "postgres" | "kubernetes" | "custom";
  label: string;
  message?: string;
  statusCode?: number;
  durationMs?: number;
};
~~~

Publish these types and corresponding runtime schemas as the plugin SDK. Validate all returned objects and bounded text sizes. `measurements` values are small display facts, not unlimited blobs or automatic metric labels.

The core adds check ID, attempt timestamps, elapsed duration, last success, source state, valid-until/freshness, effective state, and confirmation metadata. It bounds plugin observation timestamps against host time. Timestamp-mode adapters must also validate the business event timestamp. Invalid output or a plugin exception becomes unknown with a sanitized error; it must not crash other checks.

Diagnostic sections use versioned types (`logs`, `description`, `events`, `probes`, `message`), labeled text/structured fields, observation time, availability, and truncation metadata. Plugins do not return HTML, frontend code, or components. Keep the API extensible through versioned structured types, not arbitrary executable UI.

Provide a runnable example custom module, SDK documentation, and contract tests. Adding a new plugin must require only installing its files/dependencies, enabling its type, adding config instances, and restarting; no frontend modification.

## 9. Backend API and diagnostics limits

Use same-origin JSON REST endpoints, versioned under `/api/v1`. Polling is sufficient; WebSockets are not required for this release.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v1/status` | Bounded snapshot, service/check outcomes, source health, mode, timestamp/ages; no secrets or log bodies |
| `GET /api/v1/services/:id/diagnostics` | Applicable categories, pod/container choices, bounded availability metadata |
| `GET /api/v1/services/:id/diagnostics/:kind` | Selected logs, description, events, probes, or checks |
| `GET /healthz` | Node HTTP process is alive |
| `GET /readyz` | Configuration loaded and scheduler initialized |
| `GET /metrics` | Optional Prometheus-compatible board/runtime metrics |

A monitored target being unhealthy must not fail the board's own readiness endpoint. Readiness can be true while initial checks are unknown; the status response must say so.

Status responses include an API version, runtime instance ID, monotonically increasing snapshot revision within that instance, mode (`live`/`demo`), generation time, recommended polling interval, and services with stable IDs. Discard responses older than the currently applied request/revision; handle server restarts through the instance ID.

Diagnostics parameters may select a known pod/container, current/previous logs, bounded line count, and bounded lookback. They cannot specify arbitrary URLs, SQL, Kubernetes resources, filesystem paths, or source credentials. Resolve requested resource UIDs against the service's currently authorized inventory. Handle deleted/replaced pods by refreshing the choices.

Default limits:

- Logs: 200 lines, 15-minute lookback, max 256 KiB per response.
- Descriptions/probes/events: max 256 KiB per response and 100 events.
- Per-service diagnostics selection: at most 10 pods inspected for initial log availability, prioritizing failing components/unhealthy pods; manual selection can request another known pod.
- Whole-response and upstream response limits must be enforced during reading, not only after buffering.
- Rate-limit/coalesce repeated requests for the same target and cancel superseded browser requests.

Label truncated content and provide controlled “load more” up to documented hard limits. Start with bounded polling while the logs tab is visible, with a pause/resume control and stable scroll position. Auto-follow only when the user is already at the bottom or explicitly enables it. Closing the pane/modal or selecting another service cancels unused requests.

Optional metric output includes effective service/check state, observation age, last successful observation timestamp, check duration, and worker failures. Keep label cardinality bounded to configured IDs/types/states. Never include log messages, SQL, secret values, arbitrary exception text, or dynamic pod names as metric labels.

In demo mode, do not export synthetic service-health series into a live Prometheus history. Process/runtime metrics may remain available if clearly identified.

## 10. Deployment and operation

### Preferred: standalone Docker outside Kubernetes

Run the board on an always-on host outside the monitored cluster, with access to the Kubernetes API, chosen LAN endpoints, MQTT, Postgres, and Prometheus. This lets the UI and independent probes remain available during a cluster outage.

Use one container serving frontend and backend, plus read-only mounts for config, secret files, certificates/kubeconfigs, and trusted plugins. Supply Docker Compose as the primary example. No app database or persistent data volume is required.

Cluster-only DNS names and ClusterIP addresses generally need an explicit reachable route/proxy or replacement LAN endpoint from this host. Document each configured network dependency; do not assume `*.svc.cluster.local` works outside Kubernetes.

Run as a non-root user, with a read-only root filesystem and a bounded writable temporary directory if needed. Drop unnecessary capabilities; document a narrow opt-in ICMP capability. Pin the supported Node LTS major and dependencies in the implementation, lock dependencies, and document update/build procedures. Choose exact library/runtime versions during implementation and verify their supported APIs then.

Keep the board internal or behind the existing authenticated reverse proxy. Do not add application-owned accounts in this release. Apply the same access boundary to API, diagnostics, and metrics as appropriate. Avoid logging authentication material or sensitive response content. Links to Grafana/Loki/other tools may supplement the pane.

### Alternative: in-cluster deployment

Supply reviewed example Deployment, Service, ConfigMap/Secret mounts, and read-only RBAC. Prefer namespace-scoped access or configured namespace allowlists where practical. An in-cluster board can lose visibility and availability with the cluster; document this limitation.

A future lightweight in-cluster collector could supply internal-only observations to an external board. Keep check execution separable from aggregation so that addition is possible, but do not require a distributed protocol now.

All manifests and commands are documentation for the user's deployment workflow. Implementation work in this repository must not apply, patch, delete, or otherwise change live cluster resources. Never copy agent-only kubeconfigs or local tool paths into product scripts.

### Restart behavior

On restart, load/validate files and modules, initialize sources, and expose unknown until fresh observations arrive. Do not restore old healthy data from disk. Browser preferences remain intact; in-memory history and confirmation windows reset.

Graceful shutdown stops scheduling, cancels requests, closes broker/database connections, and terminates workers within a deadline.

## 11. Demo and integration migration

Demo mode makes **no upstream network connections**. It uses the same result schemas, aggregation, diagnostics API, and Svelte components as live mode. Use a controllable clock/scenario layer for repeatable testing.

Retain the current 14 baseline groups: Nextcloud, CryptoTracker, Garmin, MQTT, Home automation, MQTT control, TeslaMate, Gitea, Jellyfin, Pi-hole, Monitoring, OpenClaw, Bitaxe, and Tasmota.

Retain 20 additional illustrative services in mixed states: Paperless, Immich, Home Assistant, Vaultwarden, ArgoCD, Authgateway, Sonarr, Radarr, Backupworker, Mediaindexer, SearchAPI, Notificationworker, Garagesensor, Solarinverter, Weatherstation, Router, NAS, DNSresolver, UPS, and Printer.

Include all five states, several simultaneous failures, multiple pods/containers, nonempty and empty logs, absent/forbidden logs, descriptions/events, HTTP 503/429, DNS failures, ping loss, MQTT retained/stale data, and the intentionally stale Garmin query. Provide deterministic scenarios for failure, recovery, collector disconnect, and complete browser/API disconnect.

All invented hosts, pod names, timestamps, and log messages must be labeled simulated. A mocked authentication error is illustrative, not a diagnosis of the user's real system.

Initial discovery found an existing Prometheus/Grafana/kube-state-metrics setup and other monitoring components. Treat the prototype inventory as a starting point, not proof that every endpoint and workload is still current. Revalidate source addresses, permissions, selectors, and reachability when connecting live mode.

### Integration inputs still required

These do not block the production framework or complete demo:

| Integration | Needed before live connection |
| --- | --- |
| Kubernetes | Cluster API addresses, allowed namespaces, read-only credentials/contexts, intended workload groups |
| Prometheus | Reachable source URL(s), auth, exporter selectors and freshness expectations |
| Garmin/Postgres | Database connection, read-only credentials, schema/query, meaning/timezone of the success timestamp |
| Bitaxe | Actual firmware/API, endpoint or GraphQL query/schema, activity/temperature thresholds |
| OpenClaw | Reachable readiness URL, auth, expected payload, any task heartbeat requirement |
| MQTT/Tasmota | Broker/TLS details, subscribe-only account, exact topics, payload timestamp rules and reporting intervals |
| Other devices/services | Targets, dependencies, required vs optional checks, acceptable latency/freshness |

Do not ask for secrets in chat; document how the operator places them in the local secret files.

## 12. Coding standards and implementation structure

Apply accompanying user-supplied coding standards. The [included snapshot](service-board-coding-style.md) comes from the existing shared `CODING_STYLE.md`; use a newer supplied copy if the user provides one.

Baseline conventions:

- Prefer arrow-function assignments and object-shaped function parameters.
- Put boolean operators at the start of continued lines.
- Do not wrap simple expressions solely to satisfy an artificially short line width.
- Use explicit parentheses when mixed conditionals/fallbacks would otherwise be ambiguous.
- Prefer `??` over `||` when only null/undefined should trigger a fallback.
- Validate at config, plugin, upstream-data, and public-API boundaries.
- Keep health aggregation and transitions pure/testable with an injected clock.
- Separate adapter I/O, scheduler, health engine, diagnostics, API, and Svelte presentation.
- Use typed shared contracts; do not make the frontend understand individual adapter response formats.
- Use structured, redacted logging and actionable error categories.

Suggested layout (implementation may refine it without changing behavior):

~~~text
apps/service-board/
  src/server/
    config/
    sources/
    checks/builtin/
    plugins/
    scheduler/
    health/
    diagnostics/
    api/
  src/web/
    components/
    stores/
    preferences/
  src/shared/
  demo/
  checks/                  # packaged example custom modules
  config/                  # schemas and safe example config
  tests/
  Dockerfile
  compose.example.yml
  README.md
~~~

Use meaningful tests for state transitions, malformed inputs, stale evidence, integration contracts, plugin failures, and user interactions. Avoid broad snapshot tests that merely reproduce implementation output.

## 13. Acceptance criteria

The release is complete when these are demonstrated:

| Area | Acceptance |
| --- | --- |
| Layout | No hero/header; compact top bar; usable grid at 1920×1080 and 1366×768 with 34 services |
| Resizing | Drag/keyboard divider resizes both panes; grid reflows; no clipped controls or lost selection; narrow view remains usable |
| Sorting | Failures move first under the defined stable order; alphabetical preference survives reload |
| Modal | Tile opens details when pane closed; outside click/Escape/close dismiss; inside click does not; focus returns |
| Auto opening | Fresh confirmed failures open diagnostics by default; all failures are selectable |
| Evidence fallback | Logs on a relevant pod/container win; empty/forbidden/timed-out logs fall back to description, then probes/checks |
| Manual ownership | Manual selection/tab/scroll survives refresh and late responses; Auto does not steal focus |
| Auto recovery | Automatic pane advances/closes on confirmed recovery; stale/unknown data never counts as recovery |
| Auto preference | Explicit pane close turns Auto off; reload retains it; re-enable immediately evaluates failures |
| Aggregation | A failed required Postgres/freshness check fails a service even with healthy app pods; optional failure caps at warning |
| Confirmation | First failure is visible immediately; promotion/recovery need consecutive evidence over configured windows |
| Missing evidence | Missing/expired source data is unknown; a backend/API outage cannot leave current green tiles |
| Kubernetes | Multi-cluster names do not collide; workload/pod relationships use owner references; logs/events/containers are correctly scoped |
| Kubernetes edge cases | Rollout, partition, scale-to-zero, completed Jobs, missing object, missing metrics, and denied access are distinguished |
| HTTP/GraphQL | HTTP 2xx/error body, redirects, GraphQL `errors`, missing fields, timeouts, and latency policies work as specified |
| Garmin | Demo shows 28 h since Postgres success and fails the 24 h rule; timestamp boundary/null/future cases are tested |
| MQTT | Offline LWT, broker loss, subscription failure, retained replay, fresh live data, and sleep-aware thresholds behave correctly |
| Plugins | A new module works without frontend edits; malformed results/import errors/infinite loops cannot stop the board |
| Secrets | No application credentials in Git/image/status API/localStorage/application logs; examples use references and mounted files; known credentials are redacted from diagnostics |
| Preferences | Valid values persist; corrupt/blocked localStorage falls back safely; server settings cannot be overridden |
| Bounded diagnostics | Logs/events/bodies obey byte/time/concurrency limits; canceled requests release work |
| Demo | All 34 services and diagnostics work offline; synthetic health is not exported as live metrics |
| Packaging | Documented clean install/build/test and Compose demo startup succeed; no production DB is required |
| Deployment workflow | Examples are prepared for review; no live cluster resources are changed |

Deliver source, lockfile, schemas, safe config/secrets templates, plugin SDK/example, demo fixtures, focused unit/integration/browser tests, container/Compose examples, optional Kubernetes manifests/RBAC, and operator documentation.

The handoff task should implement against this document and the coding standards, validate the complete offline demo first, and leave unresolved real integration values explicit. No additional design discussion is needed to start.

## 14. Technical references to verify during implementation

- [Kubernetes RBAC and subresources](https://kubernetes.io/docs/reference/access-authn-authz/rbac/)
- [Prometheus instrumentation and last-success timestamps](https://prometheus.io/docs/practices/instrumentation/)
- [Prometheus blackbox exporter configuration](https://github.com/prometheus/blackbox_exporter/blob/master/CONFIGURATION.md)
- [Tasmota MQTT behavior](https://tasmota.github.io/docs/MQTT/)
- [OpenClaw gateway health](https://docs.openclaw.ai/gateway/health)
- [ESP-Miner API definition](https://github.com/bitaxeorg/ESP-Miner/blob/master/main/http_server/openapi.yaml)
- [Node.js VM security limitation](https://nodejs.org/api/vm.html)

These references inform adapters, but the operator's installed versions and device schemas must be checked before configuring live targets.
