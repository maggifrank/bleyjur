import { loadConfig } from './config.js';
import { openDataDb } from './db.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    console.error(`bleyjur: ${(e as Error).message}`);
    process.exit(1);
  }

  const db = openDataDb(config.dataDir);
  const app = await buildApp({ db, pin: config.pin, clientDir: config.clientDir, logger: true });

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    app.log.info(`${signal} received, shutting down`);
    try {
      await app.close();
    } finally {
      db.close();
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`data dir ${config.dataDir}, client dir ${config.clientDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
