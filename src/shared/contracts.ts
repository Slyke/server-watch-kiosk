import { z } from 'zod';
import type { DisplaySettingsState } from './display-settings.js';

export const themes = ['reference', 'dark', 'light', 'contrast', 'tron'] as const;
export const ThemeSchema = z.enum(themes);
export type Theme = z.infer<typeof ThemeSchema>;

export const states = ['healthy', 'warning', 'critical', 'unknown', 'paused'] as const;
export const StateSchema = z.enum(states);
export type State = z.infer<typeof StateSchema>;
export const duration = z.string().regex(/^\d+(?:\.\d+)?(?:ms|s|m|h|d)$/);
export const ms = (value: string): number => {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value);
  if (!match) throw new Error('Invalid duration');
  return Number(match[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]!]!);
};
export const iso = (time: number) => new Date(time).toISOString();
export const severity: Record<State, number> = { critical: 0, unknown: 1, warning: 2, healthy: 3, paused: 4 };
const shortText = z.string().max(1024);
export const EvidenceSchema = z.object({
  kind: z.enum(['http', 'graphql', 'ping', 'tcp', 'dns', 'mqtt', 'prometheus', 'postgres', 'kubernetes', 'custom']),
  label: z.string().max(128), message: shortText.optional(),
  statusCode: z.number().int().min(100).max(599).optional(), durationMs: z.number().finite().nonnegative().optional(),
}).strict();
export const PresentationSchema = z.object({
  background: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  foreground: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  border: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  icon: z.string().max(8).optional(), title: z.string().max(128).optional(),
  text: shortText.optional(), textMode: z.enum(['truncate', 'wrap']).optional(),
  timestamp: z.object({ label: z.string().max(64), at: z.string().datetime({ offset: true }).nullable() }).strict().optional(),
}).strict();
export const CheckResultSchema = z.object({
  state: StateSchema, reason: shortText,
  observedAt: z.string().datetime({ offset: true }).optional(),
  eventAt: z.string().datetime({ offset: true }).optional(),
  evidence: z.array(EvidenceSchema).max(32).optional(),
  measurements: z.record(z.union([z.number().finite(), z.boolean(), z.string().max(128)])).refine(v => Object.keys(v).length <= 20).optional(),
  presentation: PresentationSchema.optional(),
}).strict();
export type CheckResult = z.infer<typeof CheckResultSchema>;
export type Presentation = z.infer<typeof PresentationSchema>;
export type CheckView = CheckResult & {
  id: string; type: string; label: string; required?: boolean; rawState: State;
  lastAttempt?: string; completedAt?: string; elapsedMs?: number; lastSuccess?: string;
  validUntil?: string; ageMs: number | null; remainingMs: number;
  lastKnownState?: State; confirmation?: { phase: 'failure' | 'recovery'; since: string; remainingMs: number };
};
export type ServiceView = {
  id: string; name: string; group: string; priority: number; state: State; reason: string;
  checks: CheckView[]; dependencies: { id: string; name: string; state: State; required: boolean; reason: string }[];
  fresh: boolean; confirmed: boolean; remainingMs: number; lastKnownState?: State;
  presentation?: Presentation; links: { label: string; url: string }[];
};
export const DiagnosticSectionSchema = z.object({
  apiVersion: z.literal(1),
  kind: z.enum(['logs', 'description', 'events', 'probes', 'checks', 'message']),
  label: z.string().max(128), availability: z.enum(['available', 'empty', 'forbidden', 'timeout', 'unavailable']),
  text: z.string().max(262144), observedAt: z.string().datetime({ offset: true }),
  truncated: z.boolean().default(false), previous: z.boolean().optional(),
}).strict();
export type DiagnosticSection = z.infer<typeof DiagnosticSectionSchema>;
export type PodChoice = { uid: string; name: string; namespace: string; source: string; checkId: string; unhealthy: boolean; containers: { name: string; restarts: number; init: boolean }[] };
export type DiagnosticIndex = { kinds: DiagnosticSection['kind'][]; pods: PodChoice[]; preferred?: { kind: DiagnosticSection['kind']; pod?: string; container?: string; previous?: boolean }; notices: string[] };
export type Snapshot = {
  apiVersion: 1; instanceId: string; revision: number; mode: 'demo' | 'live'; generatedAt: string;
  pollMs: number; staleAfterMs: number; services: ServiceView[];
  sources: { id: string; state: State; reason: string }[];
  ui: { theme: string; optionsEnabled: boolean; diagnosticsEnabled?: boolean; allowHotReload: boolean; autoDiagnostics: boolean; sortMode: string; splitRatio: number; customOrders: Record<string, string[]>; sharedPreferences?: DisplaySettingsState };
};
