import net from 'node:net';
import { randomInt } from 'node:crypto';

// Read exactly one register: functions 03/04 only. No Modbus write operations.
export const readRegister = ({ host, port = 502, unitId = 1, address, functionCode = 4, timeoutMs = 2000, signal }) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new Error('Modbus request canceled'));
  if (![3, 4].includes(functionCode) || !Number.isInteger(address) || address < 0 || address > 65535 || !Number.isInteger(unitId) || unitId < 1 || unitId > 247) return reject(new Error('Invalid Modbus read parameters'));
  const transaction = randomInt(0, 65536);
  const request = Buffer.alloc(12);
  request.writeUInt16BE(transaction, 0); request.writeUInt16BE(6, 4);
  request[6] = unitId; request[7] = functionCode; request.writeUInt16BE(address, 8); request.writeUInt16BE(1, 10);
  const socket = net.createConnection({ host, port });
  let buffer = Buffer.alloc(0); let settled = false;
  const finish = ({ error, value }) => {
    if (settled) return;
    settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); socket.destroy();
    if (error) return reject(error);
    return resolve(value);
  };
  const abort = () => finish({ error: new Error('Modbus request canceled') });
  const timer = setTimeout(() => finish({ error: new Error('Modbus read timed out') }), timeoutMs);
  signal?.addEventListener('abort', abort, { once: true });
  socket.once('connect', () => socket.write(request));
  socket.on('error', () => finish({ error: new Error('Modbus transport unavailable') }));
  socket.once('end', () => finish({ error: new Error('Modbus response ended early') }));
  socket.on('data', chunk => {
    if (settled) return;
    if (buffer.length + chunk.length > 260) return finish({ error: new Error('Modbus response exceeds one ADU') });
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length < 7) return;
    const length = buffer.readUInt16BE(4);
    if (buffer.readUInt16BE(0) !== transaction || buffer.readUInt16BE(2) !== 0 || buffer[6] !== unitId || length < 3 || length > 254) return finish({ error: new Error('Modbus response header mismatch') });
    if (buffer.length < 6 + length) return;
    if (buffer.length !== 6 + length) return finish({ error: new Error('Unexpected trailing Modbus data') });
    if (buffer[7] === (functionCode | 0x80)) return finish({ error: new Error('Modbus exception ' + buffer[8]) });
    if (buffer[7] !== functionCode || length !== 5 || buffer[8] !== 2) return finish({ error: new Error('Modbus register response mismatch') });
    return finish({ value: buffer.readUInt16BE(9) });
  });
});
