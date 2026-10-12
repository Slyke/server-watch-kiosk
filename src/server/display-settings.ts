import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import { DisplaySettingsSchema, DisplaySettingsStateSchema, type DisplaySettings, type DisplaySettingsState } from '../shared/display-settings.js';

export class SharedDisplaySettings {
  state: DisplaySettingsState;
  constructor(defaults: Config['uiDefaults'], readonly file?: string) {
    this.state = { revision: 0, value: { themeOverride: null, dense: false, keepAwake: true,
      sortMode: defaults.sortMode, autoDiagnostics: defaults.autoDiagnostics, splitRatio: defaults.splitRatio,
      customOrders: structuredClone(defaults.customOrders), customOrder: Object.keys(defaults.customOrders)[0] ?? '' } };
    if (file && fs.existsSync(file)) {
      try {
        if (fs.statSync(file).size > 1048576) throw new Error('File too large');
        this.state = DisplaySettingsStateSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
      } catch { throw new Error('Display settings file is invalid or unreadable'); }
    }
  }
  patch = (patch: Partial<DisplaySettings>) => {
    const value = DisplaySettingsSchema.parse({ ...this.state.value, ...patch });
    if (value.customOrder && !Object.hasOwn(value.customOrders, value.customOrder)) throw new Error('Unknown layout');
    const next = { revision: this.state.revision + 1, value };
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = this.file + '.tmp';
      fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
      fs.renameSync(temporary, this.file);
    }
    this.state = next;
    return this.state;
  };
}
