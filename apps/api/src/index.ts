import { pino } from 'pino';

import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { connectDatabase } from './db/client.js';
import { seedDemoDataIfEmpty } from './dev/seed.js';
import { startTriageWorker } from './triage/start.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: config.logLevel });

  const database = await connectDatabase(config.database, {
    onPoolError: (error) => {
      logger.error({ err: error }, 'idle database connection failed');
    },
  });
  // The embedded database is private to this process, so it migrates itself on startup. A shared
  // Postgres is migrated as a separate deploy step (`npm run db:migrate`).
  if (database.driver === 'pglite') {
    await database.migrate();
  }
  logger.info({ driver: database.driver }, 'database ready');
  if (config.seedDemoData && (await seedDemoDataIfEmpty(database.db))) {
    logger.info('loaded demo data into the empty database');
  }

  const app = await buildApp({ config, db: database.db, logger });
  app.addHook('onClose', () => database.close());

  // With PGlite the worker must run here: the embedded database belongs to this one process.
  // With Postgres it can run here, in `npm run worker` processes, or both.
  const worker = await startTriageWorker(config, database.db, logger);

  const shutdown = (signal: NodeJS.Signals) => {
    logger.info({ signal }, 'shutting down');
    // The worker goes first: it still needs the database to put interrupted jobs back.
    Promise.resolve(worker?.stop())
      .then(() => app.close())
      .then(
        () => process.exit(0),
        (error: unknown) => {
          logger.error({ err: error }, 'error during shutdown');
          process.exit(1);
        },
      );
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await app.listen({ host: config.server.host, port: config.server.port });
  if (!isLoopback(config.server.host)) {
    logger.warn(
      { host: config.server.host },
      'the review API has no authentication yet: anyone who can reach this address can review and write to GitHub',
    );
  }
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exit(1);
});
