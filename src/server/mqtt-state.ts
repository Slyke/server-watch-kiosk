import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Source } from './config.js';

type MqttSource = Extract<Source, { type: 'mqtt' }>;
export type TrackedState = { value: string; receivedAt: number; lastChangedAt: number | null };

// Capture every message, including pulses that start and finish between check polls.
export class MqttStateHistory {
  records = new Map<string, TrackedState>();
  live = new Set<string>();
  fingerprint: string;
  constructor(readonly source: MqttSource, readonly warn: () => void = () => {}) {
    this.fingerprint = createHash('sha256').update(JSON.stringify([source.url, source.trackedStates])).digest('hex');
    if (!source.stateFile || !fs.existsSync(source.stateFile)) return;
    try {
      if (fs.statSync(source.stateFile).size > 65536) throw new Error('History too large');
      const saved = JSON.parse(fs.readFileSync(source.stateFile, 'utf8'));
      if (saved.fingerprint !== this.fingerprint) return;
      for (const [key, track] of Object.entries(source.trackedStates)) {
        const r = saved.states?.[key];
        if (r && track.values.includes(r.value) && Number.isFinite(r.receivedAt) && r.receivedAt <= Date.now()
          && (r.lastChangedAt === null || (Number.isFinite(r.lastChangedAt) && r.lastChangedAt <= r.receivedAt))) this.records.set(key, r);
      }
    } catch { warn(); }
  }
  disconnect = () => { this.live.clear(); };
  get = (key: string) => this.live.has(key) ? this.records.get(key) ?? null : null;
  ingest = ({ topic, payload, retained, receiptAt }: { topic: string; payload: string; retained: boolean; receiptAt: number }) => {
    let dirty = false;
    for (const [key, track] of Object.entries(this.source.trackedStates)) {
      if (topic === track.availabilityTopic && payload === track.offlineValue) this.live.delete(key);
      if (retained) continue; // Retained replay has no reliable event time.
      const input = track.inputs.find(i => i.topic === topic);
      if (!input) continue;
      let value: unknown = payload.trim();
      if (input.field) {
        try { const data = JSON.parse(payload); value = Object.hasOwn(data, input.field) ? data[input.field] : undefined; }
        catch { continue; }
      }
      if (typeof value !== 'string' || !track.values.includes(value)) continue;
      const previous = this.records.get(key);
      if (previous && receiptAt < previous.receivedAt) continue;
      const changed = previous && previous.value !== value;
      const lastChangedAt = changed ? (this.live.has(key) ? receiptAt : null) : previous?.lastChangedAt ?? null;
      this.records.set(key, { value, receivedAt: receiptAt, lastChangedAt });
      this.live.add(key);
      if (!previous || changed) dirty = true;
    }
    if (dirty && this.source.stateFile) {
      try {
        fs.mkdirSync(path.dirname(this.source.stateFile), { recursive: true, mode: 0o700 });
        const temporary = this.source.stateFile + '.tmp';
        fs.writeFileSync(temporary, JSON.stringify({ fingerprint: this.fingerprint, states: Object.fromEntries(this.records) }), { mode: 0o600 });
        fs.renameSync(temporary, this.source.stateFile);
      } catch { this.warn(); }
    }
  };
}
