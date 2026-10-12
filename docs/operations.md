# Operations and API

All routes share the browser's origin. Optional LAN debugging access uses a shared
code from the backend environment variable `SERVICE_BOARD_UNLOCK_CODE`.

LAN access is always `status-only` until unlocked. Localhost (verified socket
address and Host header) receives the full API by default. Set
`server.localLock: true` to apply the same code requirement locally; it defaults
to `false`. Requests with the correct configured code receive the full API below.
Anonymous locked clients can use GET
or HEAD for the UI assets, `/api/v1/status`, `/api/v1/access`, `/livez`, `/readyz`, and the
diagnostic index, Checks and Probes routes; other paths and
methods return 403. Forwarded headers do not grant local privileges. Remote
status omits raw evidence, measurements, internal links and source details, and
disables settings and runtime controls in the UI. Checks and Probes remain available
in the modal and sidebar. Public probes show outcomes, timestamps, numeric HTTP
status codes and durations; arbitrary evidence labels/messages and measurements
are excluded. Public discovery never fetches logs, enumerates pods, invokes plugin
diagnostics or reads full-access diagnostic cache entries. Service names and health/device
summaries remain visible. Configured secrets are redacted from all status text.
The legacy `server.remoteAccess` field accepts only `status-only`; `full` is
rejected at startup. Reverse proxies and container port publishing usually
connect from non-loopback addresses and therefore also require the key.

When an unlock code is configured, select **Unlock** and enter it once. After
server validation, it is stored under `service-board.unlock-code` in local
storage for this exact origin (scheme, hostname and port). The browser sends it
as `Authorization: Bearer …` on same-origin API requests only. A saved value
alone cannot bypass server checks. Invalid codes return 401; the UI discards a
stale saved code and falls back to the public status view. **Lock UI** removes
the saved code and clears privileged diagnostic content, including in other tabs of that origin.
Existing configured runtime/module restrictions still apply to an unlocked UI.

You can also set the key directly in the browser console on the board's origin:

```js
localStorage.setItem('service-board.unlock-code', 'YOUR_ENVIRONMENT_KEY');
location.reload();
```

The server validates the value; an arbitrary local-storage entry never unlocks
access. Localhost with `localLock: false` ignores saved keys and shows no lock or
unlock button. This setting controls only the dashboard UI, not the OS session.

Use a random code, for example `openssl rand -hex 24`. Empty/unset disables
unlocking for all locked clients, including localhost when `localLock: true`.
To restore local access in that case, configure a key or set `localLock: false`
and restart. The code accepts 1–512 printable non-space ASCII characters. Restart
the backend after changing its environment; old codes then stop working.
The code is redacted alongside configured source secrets and never appears in
status, access metadata, URLs or browser bundles. This is a bearer credential:
anyone who can read this browser's local storage can reuse it. Use HTTPS on an
untrusted network; the current Omarchy HTTP LAN URL does not encrypt it in transit.

| Route | Behavior |
| --- | --- |
| GET /api/v1/status | Version 1 snapshot, instance/revision, generation time, poll interval, sources and bounded service/check state |
| GET /api/v1/access | Whether this request has full access, used a valid code, and whether code unlocking is configured; never returns the code |
| GET /api/v1/services/:id/diagnostics | Locked: Checks/Probes only, no pod inventory; unlocked: applicable kinds and scoped choices |
| GET /api/v1/services/:id/diagnostics?discover=true | Locked: selects Checks without private discovery; unlocked: bounded relevant-log discovery |
| GET /api/v1/services/:id/diagnostics/:kind | Locked: filtered checks/probes; logs/description/events and full evidence require unlocking |
| PATCH /api/v1/preferences | Validated partial display-settings update; full access and same-origin JSON required |
| GET /api/v1/runtime | Enabled UI/runtime controls and module load status |
| POST /api/v1/runtime | refresh, reloadModules, watchModules, or demo scenario; JSON and same-origin checks |
| GET /livez | Dependency-free listener/process liveness and build/correlation metadata |
| GET /readyz | Valid config and initialized scheduler; target outages do not remove the board |
| GET /metrics | Bounded configured labels; synthetic demo service-health series omitted |

Status contains no raw config, source credentials, query text or log bodies. Correlation IDs appear in x-correlation-id and application error/probe bodies. Browser snapshots discard lower revisions from the same runtime instance. Server restarts reset in-memory history and confirmation windows.

Saved display preferences are shared across browsers: theme, compact cells, keep-awake,
sort order, named layouts, split ratio and automatic diagnostics. Status snapshots
include their revision and values; clients apply changes on the next normal poll
(typically five seconds), including locked LAN clients. Only full-access clients
can edit them. Updates patch changed fields so one browser's theme change does not
overwrite another browser's layout change. Fullscreen, the current diagnostic
selection, paused browser polling and unlock credentials remain local interactions.

Display settings are atomically saved with mode 0600 to `display-settings.json`
beside the config file. Override with `server.preferencesFile` or
`DISPLAY_SETTINGS_FILE`; relative paths resolve beside the config. The directory
must be writable. Invalid saved settings fail startup rather than silently resetting.
Compose mounts a persistent `board-state` volume at `/var/lib/service-board` for this
file while keeping the rest of the container filesystem read-only. Old browser-local
display preferences are superseded by shared values after refreshing the page.

Diagnostics parameters: pod is an opaque source:UID resolved within current service inventory; container must belong to that pod. previous=true selects previous logs. lines defaults to 200, maximum 2000; sinceSeconds defaults to 900, maximum 86400. No request accepts URLs, SQL, namespaces, source IDs, arbitrary file paths or Kubernetes selectors.

Default scheduling concurrency is 8; named source concurrency defaults to 4. A check never overlaps itself. Live checks use small jitter. Diagnostics have 4 concurrent requests, a 32-request queue, a 5s per-operation timeout and a 15s selection budget. Cache entries last 5s, maximum 128 entries. Identical inflight diagnostics coalesce with reference-counted cancellation. Log discovery checks at most 10 relevant pods and 4 containers per pod, preferring failed components/restarts. Discovery never overrides an explicit tab/pod choice.

Upstream HTTP bodies and diagnostic text are bounded to 256 KiB while reading. Log truncation is labeled; other oversized upstream bodies become unknown. Kubernetes lists follow continuation tokens, initially with 100 items/page; oversized pages retry with fewer items, with a 50-page ceiling. Event output is limited to 100 events. Structured descriptions include conditions, images, replicas, container states/restarts and owner references, never environment variables or raw pod configuration.

Kubernetes pod/workload restart warnings require a lifetime count at or above
`restartWarning` (default 5) and a latest restart within `restartWarningWindow`
(default `1h`). They clear after that quiet period. This is not a rate or a count
of restarts within the window. Readiness, failed pods and current crash loops are
evaluated independently of restart age.

Postgres protocol rows are checked as each decoded row arrives, before retaining a result set. A single row is decoded by the database driver before the application byte check; use scalar queries, a read-only role, statement limits and container memory limits. The application does not claim a wire-level bound on an individual database field.

Logs poll only while selected and visible; pause/follow controls preserve scroll position. At the bottom, new content follows; scrolling upward disables follow. Closing or changing a selection cancels work. Empty, forbidden, unavailable and timed-out evidence are distinct from a confirmed target failure.

## Logging

The vendored Phox logger is in src/server/logger.cjs. Application wrappers add known-secret, encoded-secret, credential-header and URL-query redaction before logging or retaining API-visible diagnostics. Startup emits SERVICE_BOOT_DIAGNOSTICS with package version and buildHash. No startup config dump, raw query or upstream exception is logged. File/HTTP/syslog sinks remain off unless explicitly configured via the logger's standard operational environment controls. Error keys are cataloged in src/server/logging/errors.json; npm run error-validate checks uniqueness.

Kubernetes Downward API metadata is included once. Build metadata is generated by scripts/write-build-info.mjs from BUILD_HASH (image builds) or git rev-parse (development, including worktrees). Unknown is explicit for an uncommitted initial repository or source archive; publish only committed builds.

## Demo

The 34 named fixtures retain the original baseline and illustrative services. The demo's timestamp offsets are generated from a controllable scenario layer, and confirmation is exercised with two fixture observations across the configured default window. No source managers or modules connect upstream.

Options can switch mixed/failure/recovery/collector-disconnect/api-disconnect. API disconnect fails only the status endpoint, so Options can restore it. All evidence is labeled simulated. Invented authentication/permission errors are fixtures, not diagnoses.

## Deployment

Use Compose as the primary standalone deployment. For live secrets use compose.live.example.yml and read-only mounts. Ensure the nonroot container user can read credentials without making them world-readable. No persistent server volume or application database is needed; retain the browser profile for layouts/preferences.

Place internal network/reverse-proxy access controls at the deployment boundary when needed. Cluster-only addresses need an explicit routable path from a standalone host. In-cluster deployment can disappear with the monitored cluster.

The Kubernetes templates require review, real image tags, namespace selection and credential provisioning. Optional source RBAC never grants Secrets, pods/exec, nodes/proxy or write verbs. Repeat the namespace Role/RoleBinding only where the configured inventory requires it. No tooling in this repo applies manifests.

Graceful shutdown stops scheduling, cancels requests, closes brokers/database pools and asks workers to dispose before a 5s process deadline.

## MQTT change history

An MQTT source may configure `trackedStates` with named entries containing
`inputs: [{topic, field?}]`, allowed `values`, and an optional `availabilityTopic`
with `offlineValue` (default `Offline`). A field selects a top-level JSON value;
without it the payload is a plain string. Every input topic must be explicitly
subscribed in the source. Several topics can feed the same state, for example
periodic STATE JSON plus immediate POWER3 publications.

`stateFile` optionally persists observed changes using a private atomic file.
Without it, history lasts for the process lifetime. Repeated identical values
do not advance the change time. Retained messages and first observations never
establish a change time. Disconnects reset continuity; a changed baseline after
a gap clears the unknown transition time, while an unchanged baseline preserves
the last observed change. Cached state is never fresh until a live message
arrives. The file contains only explicitly tracked values and timestamps.
