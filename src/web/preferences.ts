import { themes, type Theme, type Snapshot } from '../shared/contracts.js';
export type Preferences = { version: 1; sortMode: 'severity' | 'name' | 'custom'; autoDiagnostics: boolean; splitRatio: number; manualPaneOpen: boolean; customOrders: Record<string, string[]>; customOrder: string; dense: boolean; themeOverride: Theme | null };
export const preferenceKey = 'service-board.preferences.v1';
export const preferences = ({ defaults, storage }: { defaults: Snapshot['ui']; storage?: Pick<Storage, 'getItem'> }): Preferences => {
  const base: Preferences = { version: 1, sortMode: defaults.sortMode as Preferences['sortMode'], autoDiagnostics: defaults.autoDiagnostics, splitRatio: defaults.splitRatio, manualPaneOpen: false, customOrders: { ...defaults.customOrders }, customOrder: Object.keys(defaults.customOrders)[0] ?? '', dense: false, themeOverride: null };
  try {
    const value = JSON.parse(storage?.getItem(preferenceKey) ?? 'null');
    if (!value || value.version !== 1) return base;
    if (themes.includes(value.themeOverride)) base.themeOverride = value.themeOverride;
    if (['severity', 'name', 'custom'].includes(value.sortMode)) base.sortMode = value.sortMode;
    for (const key of ['autoDiagnostics', 'manualPaneOpen', 'dense'] as const) if (typeof value[key] === 'boolean') base[key] = value[key];
    if (Number.isFinite(value.splitRatio)) base.splitRatio = Math.min(0.8, Math.max(0.2, value.splitRatio));
    if (value.customOrders && typeof value.customOrders === 'object' && !Array.isArray(value.customOrders)) {
      for (const [name, ids] of Object.entries(value.customOrders).slice(0, 30)) {
        if (name.trim() && name.length <= 64 && !['__proto__', 'constructor', 'prototype'].includes(name) && Array.isArray(ids) && ids.length <= 1000 && ids.every(id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(id))) base.customOrders[name] = [...new Set(ids)];
      }
    }
    if (typeof value.customOrder === 'string' && Object.hasOwn(base.customOrders, value.customOrder)) base.customOrder = value.customOrder;
  } catch { /* A kiosk must still work with unavailable or corrupt storage. */ }
  return base;
};
export const savePreferences = ({ value, storage }: { value: Preferences; storage?: Pick<Storage, 'setItem'> }) => {
  try { storage?.setItem(preferenceKey, JSON.stringify(value)); } catch { /* Memory preferences remain usable. */ }
};
