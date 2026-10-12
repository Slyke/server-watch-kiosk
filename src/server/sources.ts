import fs from 'node:fs';
import pg from 'pg';
import mqtt, { type MqttClient } from 'mqtt';
import type { Config, Secrets, Source } from './config.js';
import { Gate, MAX_BYTES } from './limits.js';
import { readHttp, jsonBody, UpstreamError } from './network.js';
import { type State, iso, ms } from '../shared/contracts.js';
import type { Logger } from './logging.js';
import { MqttStateHistory } from './mqtt-state.js';

type Message = { payload: string; receiptAt: number; retained: boolean; epoch: number };
type Broker = { client: MqttClient; connected: boolean; subscribed: boolean; epoch: number; messages: Map<string, Message>; history: MqttStateHistory };
export class Sources {
  gates = new Map<string, Gate>(); pools = new Map<string, pg.Pool>(); brokers = new Map<string, Broker>();
  health = new Map<string, { state: State; reason: string; at: number }>();
  constructor(readonly config: Config, readonly secrets: Secrets, readonly logger: Logger) {
    for (const [id, source] of Object.entries(config.sources)) this.gates.set(id, new Gate(source.concurrency));
  }
  mark = ({ id, state, reason }: { id: string; state: State; reason: string }) => { this.health.set(id, { state, reason, at: Date.now() }); };
  headers = ({ values = {}, refs = {} }: { values?: Record<string, string>; refs?: Record<string, string> }) => ({ ...values, ...Object.fromEntries(Object.entries(refs).map(([header, ref]) => [header, this.secrets.values[ref]!])) });
  run = async <T>({ id, signal, task }: { id: string; signal: AbortSignal; task: () => Promise<T> }): Promise<T> => {
    try {
      const value = await this.gates.get(id)!.run({ signal, task });
      this.mark({ id, state: 'healthy', reason: 'Observer available' }); return value;
    } catch (err) {
      this.mark({ id, state: 'unknown', reason: err instanceof UpstreamError && err.category === 'forbidden' ? 'Observer authorization denied' : 'Observer unavailable' }); throw err;
    }
  };
  queryPostgres = async ({ source: id, query, values = [], signal }: { source: string; query: string; values?: unknown[]; signal: AbortSignal }): Promise<Record<string, unknown>[]> => {
    const source = this.config.sources[id];
    if (source?.type !== 'postgres') throw new UpstreamError('invalid');
    return this.run({ id, signal, task: async () => {
      let pool = this.pools.get(id);
      if (!pool) {
        pool = new pg.Pool({ host: source.host, port: source.port, database: source.database, user: this.secrets.values[source.usernameRef], password: this.secrets.values[source.passwordRef], max: source.concurrency, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000,
          ssl: source.tls ? { rejectUnauthorized: source.tls.rejectUnauthorized, ca: source.tls.caFile ? fs.readFileSync(source.tls.caFile, 'utf8') : undefined } : undefined });
        pool.on('error', () => this.mark({ id, state: 'unknown', reason: 'Database connection lost' }));
        this.pools.set(id, pool);
      }
      const client = await pool.connect();
      // Destroying the checked-out connection cancels server work when a caller leaves.
      let released = false;
      const release = (destroy = false) => { if (released) return; released = true; client.release(destroy); };
      const abort = () => release(true);
      signal.addEventListener('abort', abort, { once: true });
      let broken = false;
      try {
        signal.throwIfAborted();
        await client.query('BEGIN READ ONLY');
        await client.query("SET LOCAL statement_timeout = '10000ms'");
        const rows = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
          const collected: Record<string, unknown>[] = []; let bytes = 0; let settled = false;
          const q = client.query(new pg.Query({ text: query, values }));
          q.on('row', row => {
            if (settled) return;
            bytes += Buffer.byteLength(JSON.stringify(row));
            if (collected.length >= source.maxRows || bytes > MAX_BYTES) { settled = true; broken = true; release(true); return reject(new UpstreamError('limit')); }
            collected.push(row);
          });
          q.on('end', () => { if (settled) return; settled = true; return resolve(collected); });
          q.on('error', () => { if (settled) return; settled = true; return reject(new UpstreamError('invalid')); });
        });
        await client.query('ROLLBACK');
        return rows;
      } catch { release(true); throw new UpstreamError(signal.aborted ? 'timeout' : 'invalid'); }
      finally { signal.removeEventListener('abort', abort); if (!broken) release(signal.aborted); }
    } });
  };
  queryPrometheus = async ({ source: id, query, signal }: { source: string; query: string; signal: AbortSignal }) => {
    const source = this.config.sources[id];
    if (source?.type !== 'prometheus') throw new UpstreamError('invalid');
    return this.run({ id, signal, task: async () => {
      const url = new URL(source.url.replace(/\/$/, '') + '/api/v1/query'); url.searchParams.set('query', query);
      const reply = await readHttp({ url: url.href, signal, headers: this.headers({ values: source.headers, refs: source.headerRefs }), tls: source.tls });
      if ([401, 403].includes(reply.status)) throw new UpstreamError('forbidden', reply.status);
      if (reply.status !== 200) throw new UpstreamError('transport', reply.status);
      return jsonBody({ reply });
    } });
  };
  startMqtt = () => {
    for (const [id, source] of Object.entries(this.config.sources)) {
      if (source.type !== 'mqtt') continue;
      const client = mqtt.connect(source.url, { username: source.usernameRef ? this.secrets.values[source.usernameRef] : undefined, password: source.passwordRef ? this.secrets.values[source.passwordRef] : undefined, reconnectPeriod: 5000, connectTimeout: 5000, resubscribe: false, clean: true,
        rejectUnauthorized: source.tls?.rejectUnauthorized ?? true, ca: source.tls?.caFile ? fs.readFileSync(source.tls.caFile) : undefined,
        cert: source.tls?.certFile ? fs.readFileSync(source.tls.certFile) : undefined, key: source.tls?.keyFile ? fs.readFileSync(source.tls.keyFile) : undefined });
      const history = new MqttStateHistory(source, () => this.logger.info('MQTT_STATE_HISTORY', 'MQTT state history could not be read or persisted', { source: id }));
      const broker: Broker = { client, connected: false, subscribed: false, epoch: 0, messages: new Map(), history }; this.brokers.set(id, broker);
      client.on('connect', () => {
        broker.connected = true; broker.subscribed = false; broker.epoch++; broker.messages.clear(); history.disconnect();
        if (!source.topics.length) { broker.subscribed = true; return; }
        client.subscribe(source.topics, { qos: 0 }, (err, granted) => {
          broker.subscribed = !err && Boolean(granted?.length === source.topics.length && granted.every(g => g.qos !== 128));
          this.mark({ id, state: broker.subscribed ? 'healthy' : 'unknown', reason: broker.subscribed ? 'Broker subscribed' : 'Subscription denied' });
        });
      });
      client.on('message', (topic, payload, packet) => {
        if (!source.topics.includes(topic) || payload.length > MAX_BYTES) return;
        const message = { payload: payload.toString('utf8'), receiptAt: Date.now(), retained: Boolean(packet.retain), epoch: broker.epoch };
        broker.messages.set(topic, message);
        history.ingest({ topic, ...message });
      });
      const lost = () => { broker.connected = false; broker.subscribed = false; broker.messages.clear(); history.disconnect(); this.mark({ id, state: 'unknown', reason: 'MQTT observer disconnected' }); };
      client.on('offline', lost); client.on('close', lost); client.on('error', lost);
    }
  };
  latest = ({ source, topic }: { source: string; topic: string }) => {
    const c = this.config.sources[source];
    if (c?.type !== 'mqtt' || !c.topics.includes(topic)) throw new UpstreamError('invalid');
    const broker = this.brokers.get(source);
    if (!broker?.connected || !broker.subscribed) throw new UpstreamError('transport');
    return broker.messages.get(topic) ?? null;
  };
  mqttState = ({ source, key }: { source: string; key: string }) => {
    const c = this.config.sources[source];
    if (c?.type !== 'mqtt' || !Object.hasOwn(c.trackedStates, key)) throw new UpstreamError('invalid');
    const broker = this.brokers.get(source);
    if (!broker?.connected || !broker.subscribed) throw new UpstreamError('transport');
    return broker.history.get(key);
  };
  snapshot = () => Object.keys(this.config.sources).map(id => {
    const broker = this.brokers.get(id);
    if (broker?.connected && broker.subscribed) return { id, state: 'healthy' as State, reason: 'Broker connected and subscribed' };
    const h = this.health.get(id);
    return { id, state: !h || Date.now() - h.at > ms(this.config.runtime.staleAfter) ? 'unknown' as State : h.state, reason: h?.reason ?? 'Waiting for observer' };
  });
  close = async () => { for (const b of this.brokers.values()) b.client.end(true); await Promise.allSettled([...this.pools.values()].map(pool => pool.end())); };
}
