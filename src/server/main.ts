import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { createBoard } from './app.js';
import { createLogger } from './logging.js';

const main = async () => {
  const { values } = parseArgs({ options: { config: { type: 'string', default: process.env.CONFIG_FILE ?? './config.json5' }, secrets: { type: 'string', default: process.env.SECRETS_FILE ?? './secrets.json5' }, demo: { type: 'boolean' }, live: { type: 'boolean' } } });
  if (values.demo && values.live) throw new Error('Choose either --demo or --live');
  const loaded = loadConfig({ configFile: values.config!, secretsFile: values.secrets!, demo: values.demo ? true : (values.live ? false : undefined) });
  const board = await createBoard(loaded);
  const server = board.app.listen(board.config.server.port, board.config.server.host);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', () => { void board.close().finally(() => reject(new Error('HTTP listener could not start; check the configured host and port'))); });
  });
  server.requestTimeout = 20000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    const deadline = setTimeout(() => process.exit(1), 5000); deadline.unref();
    server.close(); server.closeIdleConnections(); await board.close();
  };
  process.once('SIGTERM', () => { void stop().catch(() => process.exit(1)); });
  process.once('SIGINT', () => { void stop().catch(() => process.exit(1)); });
};
main().catch(error => {
  const logger = createLogger({ secrets: { schemaVersion: 1, values: {} } });
  logger.error('CONFIG_LOAD_FAILED', error instanceof Error ? error.message.slice(0, 512) : 'Startup failed');
  process.exitCode = 1;
});
