import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { ConfigSchema } from '../../src/server/config.js';
import { Sources } from '../../src/server/sources.js';
import { createLogger } from '../../src/server/logging.js';
const exec = promisify(execFile);
test('Postgres binds values, enforces read-only transactions, row limits and cancellation', { timeout: 120000 }, async () => {
  const name = 'service-board-pg-test-' + process.pid + '-' + Date.now();
  let admin: pg.Client | undefined; let sources: Sources | undefined;
  try {
    await exec('docker', ['run', '-d', '--rm', '--name', name, '--label', 'service-board.test=postgres', '-p', '127.0.0.1::5432', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '--tmpfs', '/var/lib/postgresql/data:rw,size=128m', 'postgres:17-alpine']);
    const { stdout } = await exec('docker', ['port', name, '5432/tcp']); const port = Number(stdout.trim().split(':').at(-1));
    for (let attempt = 0; attempt < 60; attempt++) {
      const candidate = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres', connectionTimeoutMillis: 1000 });
      try { await candidate.connect(); admin = candidate; break; } catch { await candidate.end().catch(() => {}); await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    assert.ok(admin, 'Disposable database started');
    await admin.query('CREATE ROLE board_reader LOGIN');
    await admin.query('CREATE TABLE readings (value text)');
    await admin.query("INSERT INTO readings VALUES ('before')");
    // Give the test role write permission to prove BEGIN READ ONLY enforces the boundary.
    await admin.query('GRANT SELECT, INSERT, UPDATE ON readings TO board_reader');
    const config = ConfigSchema.parse({ schemaVersion: 1, sources: { db: { type: 'postgres', host: '127.0.0.1', port, database: 'postgres', usernameRef: 'user', passwordRef: 'password', maxRows: 2 } } });
    const secrets = { schemaVersion: 1 as const, values: { user: 'board_reader', password: 'test-only' } };
    sources = new Sources(config, secrets, createLogger({ secrets }));
    const query = (text: string, values: unknown[] = [], timeout = 2000) => sources!.queryPostgres({ source: 'db', query: text, values, signal: AbortSignal.timeout(timeout) });
    const input = "'; DROP TABLE readings; --";
    assert.deepEqual(await query('SELECT $1::text AS value', [input]), [{ value: input }]);
    await assert.rejects(query("UPDATE readings SET value = 'after'"));
    assert.equal((await query('SELECT value FROM readings'))[0]?.value, 'before');
    await assert.rejects(query('SELECT generate_series(1, 10) AS value'));
    const start = performance.now();
    await assert.rejects(query('SELECT pg_sleep(5)', [], 100));
    assert.ok(performance.now() - start < 1500);
    assert.equal((await query('SELECT 1 AS value'))[0]?.value, 1);
  } finally {
    await sources?.close(); await admin?.end();
    await exec('docker', ['rm', '-f', name]).catch(() => {});
  }
});
