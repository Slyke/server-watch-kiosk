# Custom module SDK

Modules are trusted operator-installed backend ES modules, not browser components or a security sandbox. The host uses hard-terminable child processes to contain crashes, import hangs and synchronous loops. Files/dependencies are installed by the operator at image build time; the service never installs packages.

Name a file `custom.example.mjs` (or `.js` in a directory whose package.json contains `"type":"module"`). Export a default object whose type exactly matches the filename stem:

```js
export default {
  apiVersion: 1,
  type: 'custom.example',
  configSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['target'],
    properties: { target: { type: 'string', pattern: '^https?://' } },
  },
  check: async ({ config, context, signal }) => {
    const response = await context.http.getJson({ url: config.target, signal });
    return {
      state: response.body.ready ? 'healthy' : 'critical',
      reason: response.body.ready ? 'Ready' : 'Not ready',
      observedAt: response.receivedAt,
      evidence: [{ kind: 'http', label: 'Readiness', statusCode: response.statusCode }],
      presentation: { icon: '⚙', textMode: 'wrap' },
    };
  },
};
```

Enable the type in `plugins.enabled`, add a check instance with `type`, `params`, and optional `source`/`sources`/`secretRefs`, then reference it from a service. Discovery is deterministic, enabled-only and rejects duplicate .js/.mjs stems or built-in collisions. Static API/schema validation and parameter validation happen in the worker. A failed import leaves checks unknown and does not stop the API.

[TypeScript SDK](../src/shared/plugin-sdk.ts), [result contract](../src/shared/contracts.ts) and generated [result schema](../config/check-result.schema.json) describe the wire types. Plugin authors can use a JSDoc import of CheckModule for editor assistance.

## Helpers

All helpers are asynchronous JSON RPC to the parent; Dates cross as RFC3339 strings. Do not return streams, class instances, functions, cycles, HTML or frontend code.

| Helper | Input / output |
| --- | --- |
| context.clock.now() | UTC RFC3339 host-process clock |
| context.secrets.get({ref}) | Only explicitly declared check.secretRefs; returns a string |
| context.logger.info/warn(message) | Bounded, redacted structured log |
| context.http.getJson({url,headers?,signal?}) | Bounded JSON, statusCode and receivedAt; no redirects |
| context.graphql.query({url,query,variables?,signal?}) | Bounded GraphQL body; module must interpret errors |
| context.postgres.query({source,query,values?}) | Read-only transaction, bound values, bounded rows/bytes |
| context.prometheus.query({source,query}) | Configured source; module interprets result cardinality/freshness |
| context.mqtt.latest({source,topic}) | Shared broker's exact subscribed topic or null; payload, receiptAt, retained and connection epoch |

Named-source helpers require the source in the check's `source` or `sources` list. Never supply secrets as plugin params; use declared secretRefs or source credentials. These declarations reduce accidental exposure, not what malicious Node code can access. Mounted files and normal container permissions remain the actual trust boundary.

Each invocation has at most four concurrent and 32 total helper requests. Helper requests are at most 32 KiB; worker responses at most 256 KiB. The total resident worker count is bounded by runtime.concurrency; idle types are evicted and lazily reloaded. Workers have a 96 MiB V8 heap limit, bounded stdout/stderr, import and invocation deadlines, a serial per-type queue, and crash backoff. A slow check of one custom type does not block unrelated built-ins or the API. Parent deadlines kill unresponsive workers; cleanup hooks are best-effort. Modules should pass signal to their own I/O and avoid unmanaged child processes.

## Results and card overrides

Return state healthy/warning/critical/unknown/paused, a reason (at most 1024 characters), and optional observedAt/eventAt, up to 32 evidence entries and 20 small measurements. No observedAt means a direct observation completed now. Supply the actual source timestamp for cached/retained data. Future or stale timestamps become unknown. Business timestamps must be independently evaluated for freshness; fetching an old success now does not make it fresh.

The core owns timestamps, deadlines, transition confirmation, aggregation and state labels. A plugin cannot bypass these by editing frontend code.

A check must opt in with `allowPresentation: true` for these optional result.presentation fields:

- background, foreground, border: six-digit hex colors only.
- icon: up to eight text characters, never SVG/HTML.
- title: a compact display title; the service ID and detail name remain stable.
- text: replacement tile summary text.
- textMode: truncate or wrap.

These change tile presentation, not the health state, mandatory state label, selection outline or diagnostics. Expired/offline health removes overrides. With several overrides the most severe check wins; config order breaks ties. Choose readable foreground/background combinations.

## Diagnostics and cleanup

Optional `capabilities: { diagnostics: ['probes'] }` advertises categories. Implement `diagnose({config,context,signal,request})`; request.kind is one of the declared categories. Return apiVersion:1, kind, label, text, observedAt, availability (available/empty/forbidden/timeout/unavailable), truncated, and optional previous. Text is rendered literally. Limits and redaction match built-ins.

Optional `dispose({context})` runs during graceful shutdown with a short deadline. Do not rely on it after forced termination. Helper access is invocation-scoped; dispose should close module-owned resources directly.

Hot reload is opt-in in config. The Options sidebar reloads installed modules or toggles file watching. Replacements are validated in fresh workers, old observations become unknown and in-flight results are discarded. Unsupported output becomes unknown with a sanitized error. Adding enabled types and dependencies requires config/image changes and restart.

Examples: [readiness](../checks/custom.example.mjs), [Garmin timestamp query](../checks/custom.garmin.mjs), [Kubernetes through Prometheus](../checks/custom.kubernetes-prometheus.mjs). Garmin's actual schema/query must be supplied by the operator; no personal health records are requested or returned.
