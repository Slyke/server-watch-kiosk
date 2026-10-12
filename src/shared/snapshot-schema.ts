import { z } from 'zod';
import { DisplaySettingsStateSchema } from './display-settings.js';
import { CheckResultSchema, StateSchema, PresentationSchema, ThemeSchema } from './contracts.js';
const timestamp = z.string().datetime({ offset: true });
const boundedId = z.string().min(1).max(256);
export const CheckViewSchema = CheckResultSchema.extend({
  id: boundedId, type: boundedId, label: z.string().max(128), required: z.boolean().optional(),
  rawState: StateSchema, lastAttempt: timestamp.optional(), completedAt: timestamp.optional(),
  elapsedMs: z.number().finite().nonnegative().optional(), lastSuccess: timestamp.optional(), validUntil: timestamp.optional(),
  ageMs: z.number().finite().nonnegative().nullable(), remainingMs: z.number().finite().nonnegative(),
  lastKnownState: StateSchema.optional(),
  confirmation: z.object({ phase: z.enum(['failure', 'recovery']), since: timestamp, remainingMs: z.number().finite().nonnegative() }).optional(),
});
export const SnapshotSchema = z.object({
  apiVersion: z.literal(1), instanceId: z.string().uuid(), revision: z.number().int().nonnegative(),
  mode: z.enum(['demo', 'live']), generatedAt: timestamp,
  pollMs: z.number().positive().max(86400000), staleAfterMs: z.number().positive().max(86400000),
  services: z.array(z.object({
    id: boundedId, name: z.string().max(128), group: z.string().max(128), priority: z.number().finite(),
    state: StateSchema, reason: z.string().max(1024), checks: z.array(CheckViewSchema).max(100),
    dependencies: z.array(z.object({ id: boundedId, name: z.string().max(128), state: StateSchema, required: z.boolean(), reason: z.string().max(1024), fresh: z.boolean().optional(), confirmed: z.boolean().optional(), remainingMs: z.number().finite().nonnegative().optional() })).max(100),
    fresh: z.boolean(), confirmed: z.boolean(), remainingMs: z.number().finite().nonnegative(), lastKnownState: StateSchema.optional(),
    presentation: PresentationSchema.optional(), links: z.array(z.object({ label: z.string().max(128), url: z.string().url().refine(v => /^https?:\/\//.test(v)) })).max(10),
  })).max(1000),
  sources: z.array(z.object({ id: boundedId, state: StateSchema, reason: z.string().max(1024) })).max(1000),
  ui: z.object({ theme: ThemeSchema, optionsEnabled: z.boolean(), diagnosticsEnabled: z.boolean().default(true), allowHotReload: z.boolean(), autoDiagnostics: z.boolean(), sortMode: z.enum(['severity', 'name', 'custom']), splitRatio: z.number().min(0.2).max(0.8), customOrders: z.record(z.array(boundedId).max(1000)), sharedPreferences: DisplaySettingsStateSchema.optional() }),
});
