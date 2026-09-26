import type { CheckResult, DiagnosticSection } from './contracts.js';
export type PluginContext = {
  clock: { now: () => string };
  logger: { info: (message: string) => void; warn: (message: string) => void };
  secrets: { get: ({ ref }: { ref: string }) => Promise<string> };
  http: { getJson: (args: { url: string; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ body: unknown; statusCode: number; receivedAt: string }> };
  graphql: { query: (args: { url: string; query: string; variables?: Record<string, unknown>; signal?: AbortSignal }) => Promise<unknown> };
  postgres: { query: (args: { source: string; query: string; values?: unknown[] }) => Promise<Record<string, unknown>[]> };
  prometheus: { query: (args: { source: string; query: string }) => Promise<unknown> };
  mqtt: { latest: (args: { source: string; topic: string }) => Promise<unknown> };
};
export type CheckModule = {
  apiVersion: 1; type: string; configSchema: Record<string, unknown>;
  capabilities?: { diagnostics?: ('logs' | 'description' | 'events' | 'probes')[] };
  check: (args: { config: Record<string, unknown>; context: PluginContext; signal: AbortSignal }) => Promise<CheckResult>;
  diagnose?: (args: { config: Record<string, unknown>; context: PluginContext; signal: AbortSignal; request: { kind: string } }) => Promise<DiagnosticSection>;
  dispose?: (args: { context?: PluginContext }) => Promise<void>;
};
