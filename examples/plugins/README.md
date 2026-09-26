# Plugin walkthrough

Every filename stem matches its exported `type`. The [integration config](../config.json5) shows complete check/source/service wiring. Defaults in the examples are applied with JavaScript `??`; the host validates JSON Schema but does not populate its `default` annotations.

## Fetch / JSON

`custom.fetch-json` calls the host's bounded HTTP helper. Set `url`, optional literal `headers`, `readyPath` (default `ready`), and optional `timestampPath`/`maxAgeSeconds` (default 120). Paths are dot-separated own-property names.

`tokenRef` names a secret containing only the bearer token. Declare the same reference in the check's `secretRefs`; the module constructs the Authorization header. Remove both properties for unauthenticated endpoints. URLs must not contain credentials. For header-only/status-code probes and custom TLS settings, prefer the built-in HTTP adapter and its named source.

Expected response:

```json
{"ready":true,"updatedAt":"2026-09-25T12:00:00Z"}
```

Readiness must be boolean, not `"true"` or `1`. A stale/missing/future configured timestamp or authorization denial yields unknown. A valid `ready: false` or non-2xx JSON response yields critical evidence, subject to the host's confirmation window. Invalid/non-JSON bodies fail the helper and become unknown. Redirects are not followed.

## MQTT telemetry

`custom.mqtt-telemetry` uses `context.mqtt.latest`, so it shares the host connection instead of opening another client. Declare `source` on the check, repeat that source ID in params, and explicitly subscribe to `topic` in the source.

```json
{"temperature":42.5,"timestamp":"2026-09-25T12:00:00Z"}
```

`valuePath` defaults to `temperature`; `timestampPath` defaults to `timestamp`. Numeric strings are rejected. Warning/critical defaults are 60/80; comparisons are inclusive. The module accepts a live message's receipt time only when its producer timestamp is absent. Retained messages always need a timezone-qualified producer timestamp. Missing cache entries, disconnected observers and stale/future data yield unknown; reconnect clears cached data.

Returned `observedAt` is the source timestamp, so the host also enforces its own `staleAfter`. Reading the same cached message cannot manufacture a new observation. The module never publishes. Broker credentials belong in source secret references. The lab fixture publishes synthetic samples, separately from the board.

## Postgres freshness

`custom.postgres-freshness` requires `source` and `query`, with optional `values`, `column` (default `last_success_at`), `warningSeconds` (3600), and `criticalSeconds` (7200).

```sql
SELECT last_success_at
FROM service_heartbeats
WHERE service = $1
```

Put the service name in `values: ['demo-import']`; never interpolate it into SQL. The query must return exactly one timezone-qualified timestamp. Empty/multiple rows, NULL, invalid or future timestamps yield unknown. For a maximum over historical events, use an aggregate such as `SELECT max(completed_at) AS last_success_at ...`; an empty aggregate returns NULL and therefore unknown.

The host opens a read-only transaction, binds values, and limits time/rows/bytes. Use a read-only database account as well. PostgreSQL `timestamptz` values cross the worker boundary as ISO strings. `observedAt` is when the database was checked; `eventAt` retains the actual success time. An old success is classified by age, not mistaken for a fresh business event.

## Modbus TCP register

`custom.modbus-register` demonstrates a custom protocol without an added npm dependency. It uses a short-lived TCP socket in the worker and reads **one 16-bit register** using only function **03** (holding register) or **04** (input register, the default).

Set `host`, `port` (502), `unitId` (1), `address`, `functionCode`, optional `signed`, `scale`, `offset`, thresholds (60/80), and `timeoutMs` (2000). The check's overall timeout should exceed the socket timeout.

Addresses are **zero-based protocol offsets**. A manual's input register 30001 commonly maps to offset 0; verify the device manual rather than entering a display number blindly. The lab's offset 100 returns 425, and scale 0.1 produces 42.5. Signed decoding uses two's complement, then applies `value * scale + offset`.

The client validates transaction/protocol/unit IDs, function, length and byte count; handles fragmented TCP responses; caps one ADU at 260 bytes; and destroys the socket on success, failure, cancellation or timeout. Exceptions and malformed responses yield unknown. No write functions, RTU/serial transport, multi-register floats or byte/word-order guessing are implemented. Add those separately using the device's register map if needed.

See the official [Modbus application specification](https://www.modbus.org/file/secure/modbusprotocolspecification.pdf) and [TCP messaging guide](https://www.modbus.org/docs/Modbus_Messaging_Implementation_Guide_V1_0b.pdf). The TCP module uses direct worker I/O, so it does not use a named host source or share host connection pools.

## GraphQL health

`custom.graphql-health` requires `url` and a configured read-only `query`, with optional `variables` and `readyPath` (default `data.health.ready`). Missing/malformed data and any GraphQL errors yield unknown, including partial responses with HTTP 200. A valid false value is critical evidence.

This example is for an unauthenticated endpoint. The host GraphQL helper does not expose authorization headers in the SDK; use the built-in GraphQL adapter with source credentials, or adapt a module with explicitly bounded I/O and declared secret access. Do not put tokens in query variables.

## Prometheus value

`custom.prometheus-value` requires a declared `source` and `query`. It expects exactly one instant-vector series, no query warnings, and a finite numeric value. Empty results, duplicate series, NaN/Inf and timestamps outside `maxAgeSeconds` (120) become unknown. Warning/critical default to 50/100.

Prometheus encodes samples as strings; this module validates that format before converting it. Use PromQL aggregation deliberately when several exporters match. The response timestamp validates the returned sample; recording-rule/query evaluation timestamps do not necessarily prove underlying business data freshness. Include exporter `up` and underlying sample-age/business-age checks when those are required, as in the existing kube-state-metrics example.
