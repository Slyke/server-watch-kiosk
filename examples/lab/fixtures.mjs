// Synthetic local data for the example modules. Never point this at real equipment.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import JSON5 from 'json5';
import mqtt from 'mqtt';
import pg from 'pg';
import { createLogger } from '../../dist/server/logging.js';

const secrets = JSON5.parse(fs.readFileSync(new URL('./secrets.example.json5', import.meta.url), 'utf8'));
const logger = createLogger({ secrets });
const broker = mqtt.connect('mqtt://mqtt:1883', { reconnectPeriod: 1000 });
broker.on('error', () => logger.info('MODULE_LOG', 'Lab MQTT fixture reconnecting'));
const pool = new pg.Pool({ host: 'postgres', database: 'board_lab', user: 'postgres', password: secrets.values.fixturePassword, connectionTimeoutMillis: 2000 });
pool.on('error', () => logger.info('MODULE_LOG', 'Lab database fixture reconnecting'));
const publish = async () => {
  if (broker.connected) broker.publish('lab/telemetry', JSON.stringify({ temperature: 42.5, timestamp: new Date().toISOString() }), { retain: true });
  try { await pool.query("UPDATE service_heartbeats SET last_success_at = now() WHERE service = $1", ['demo-import']); }
  catch { logger.info('MODULE_LOG', 'Lab heartbeat update unavailable'); }
};
const timer = setInterval(() => { void publish(); }, 3000);
void publish();
const web = http.createServer((req, res) => {
  let bytes = 0;
  req.on('data', chunk => { bytes += chunk.length; if (bytes > 32768) req.destroy(); });
  req.on('error', () => {});
  const path = new URL(req.url, 'http://lab.invalid').pathname;
  const body = path === '/health' ? { ready: true, updatedAt: new Date().toISOString() }
    : (path === '/graphql' ? { data: { health: { ready: true } } }
    : (path === '/api/v1/query' ? { status: 'success', data: { resultType: 'vector', result: [{ metric: { __name__: 'lab_queue_depth' }, value: [Date.now() / 1000, '42'] }] } }
    : { error: 'Unknown fixture' }));
  res.writeHead(body.error ? 404 : 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
});
web.listen(8080, '0.0.0.0');
const modbus = net.createServer(socket => {
  let buffer = Buffer.alloc(0);
  socket.setTimeout(5000, () => socket.destroy()); socket.on('error', () => {});
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 260) { socket.destroy(); return; }
    if (buffer.length < 12) return;
    if (buffer.length !== 12 || buffer.readUInt16BE(2) !== 0 || buffer.readUInt16BE(4) !== 6) { socket.destroy(); return; }
    const validFunction = [3, 4].includes(buffer[7]);
    const validAddress = buffer.readUInt16BE(8) === 100 && buffer.readUInt16BE(10) === 1 && buffer[6] === 1;
    const response = Buffer.alloc(validFunction && validAddress ? 11 : 9);
    buffer.copy(response, 0, 0, 7);
    response.writeUInt16BE(response.length - 6, 4);
    response[7] = validFunction && validAddress ? buffer[7] : (buffer[7] | 0x80);
    response[8] = validFunction && validAddress ? 2 : (validFunction ? 2 : 1);
    if (response.length === 11) response.writeUInt16BE(425, 9);
    socket.end(response);
  });
});
modbus.listen(1502, '0.0.0.0');
logger.info('MODULE_LOG', 'Synthetic protocol lab running');
const close = () => { clearInterval(timer); web.close(); modbus.close(); broker.end(true); void pool.end(); };
process.once('SIGTERM', close); process.once('SIGINT', close);
