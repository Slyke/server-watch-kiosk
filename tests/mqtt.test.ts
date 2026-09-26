import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import mqttPacket from 'mqtt-packet';
import { ConfigSchema } from '../src/server/config.js';
import { Sources } from '../src/server/sources.js';
import { createLogger } from '../src/server/logging.js';

const until = async (condition: () => boolean) => {
  const deadline = Date.now() + 3000;
  while (!condition()) { if (Date.now() > deadline) throw new Error('MQTT test timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
};
test('managed MQTT connection checks SUBACK, clears replay on disconnect, and never publishes', async () => {
  const connections: net.Socket[] = []; const packets: string[] = []; let deny = false;
  const server = net.createServer(socket => {
    connections.push(socket);
    const parser = mqttPacket.parser(); socket.on('data', chunk => parser.parse(chunk)); socket.on('error', () => {});
    parser.on('packet', packet => {
      packets.push(packet.cmd);
      if (packet.cmd === 'connect') socket.write(mqttPacket.generate({ cmd: 'connack', returnCode: 0, sessionPresent: false }));
      if (packet.cmd === 'subscribe') socket.write(mqttPacket.generate({ cmd: 'suback', messageId: packet.messageId, granted: packet.subscriptions.map(() => deny ? 128 : 0) }));
      if (packet.cmd === 'pingreq') socket.write(mqttPacket.generate({ cmd: 'pingresp' }));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const config = ConfigSchema.parse({ schemaVersion: 1, sources: { broker: { type: 'mqtt', url: 'mqtt://127.0.0.1:' + (server.address() as net.AddressInfo).port, topics: ['tele/device', 'lwt/device'] } } });
  const secrets = { schemaVersion: 1 as const, values: {} }; const sources = new Sources(config, secrets, createLogger({ secrets }));
  try {
    sources.startMqtt(); await until(() => Boolean(sources.brokers.get('broker')?.subscribed));
    connections[0]!.write(mqttPacket.generate({ cmd: 'publish', topic: 'tele/device', payload: '{"ready":true}', qos: 0, retain: true, dup: false }));
    await until(() => Boolean(sources.latest({ source: 'broker', topic: 'tele/device' })));
    assert.equal(sources.latest({ source: 'broker', topic: 'tele/device' })?.retained, true);
    assert.throws(() => sources.latest({ source: 'broker', topic: 'undeclared' }));
    connections[0]!.destroy(); await until(() => !sources.brokers.get('broker')?.connected);
    assert.throws(() => sources.latest({ source: 'broker', topic: 'tele/device' }));
    deny = true; sources.brokers.get('broker')!.client.reconnect();
    await until(() => connections.length === 2 && packets.filter(cmd => cmd === 'subscribe').length === 2);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(sources.brokers.get('broker')?.subscribed, false);
    assert.throws(() => sources.latest({ source: 'broker', topic: 'tele/device' }));
    assert.ok(!packets.includes('publish'));
  } finally { await sources.close(); connections.forEach(s => s.destroy()); await new Promise<void>(resolve => server.close(() => resolve())); }
});
