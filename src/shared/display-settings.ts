import { z } from 'zod';
import { ThemeSchema } from './contracts.js';

const layoutName = z.string().trim().min(1).max(64).refine(name => !['__proto__', 'constructor', 'prototype'].includes(name));
export const DisplaySettingsSchema = z.object({
  themeOverride: ThemeSchema.nullable(), dense: z.boolean(), keepAwake: z.boolean(),
  sortMode: z.enum(['severity', 'name', 'custom']), autoDiagnostics: z.boolean(),
  splitRatio: z.number().min(0.2).max(0.8),
  customOrders: z.record(layoutName, z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/)).max(1000))
    .refine(value => Object.keys(value).length <= 30),
  customOrder: z.string().max(64),
}).strict();
export const DisplaySettingsStateSchema = z.object({ revision: z.number().int().nonnegative(), value: DisplaySettingsSchema }).strict();
export type DisplaySettings = z.infer<typeof DisplaySettingsSchema>;
export type DisplaySettingsState = z.infer<typeof DisplaySettingsStateSchema>;
export const displaySettingsKeys = Object.keys(DisplaySettingsSchema.shape) as (keyof DisplaySettings)[];
