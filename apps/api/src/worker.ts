/**
 * Runs triage workers without the HTTP server (`npm run worker`), so they can scale separately
 * from the API. Needs a shared Postgres (`DATABASE_URL`): PGlite lives inside a single process,
 * so with PGlite the worker runs inside the API server instead.
 */
import { pino } from 'pino';

import { ConfigError, loadProcessConfig } from './config.js';
import { connectDatabase } from './db/client.js';
import { startTriageWorker } from './triage/start.js';

async function main(): Promise<void> {
  const config = loadProcessConfig();
  const logger = pino({ level: config.logLevel });
  if (config.database.driver !== 'postgres') {
    throw new ConfigError(
      'The standalone worker needs DATABASE_URL. With PGlite, the API server runs the worker itself.',
    );
  }
  if (config.worker.concurrency === 0) {
    throw new ConfigError('TRIAGE_WORKER_CONCURRENCY is 0, so there is nothing to run.');
  }

  const database = await connectDatabase(config.database, {
    onPoolError: (error) => {
      logger.error({ err: error }, 'idle database connection failed');
    },
  });
  const worker = await startTriageWorker(config, database.db, logger);

  const shutdown = (signal: NodeJS.Signals) => {
    logger.info({ signal }, 'shutting down');
    Promise.resolve(worker?.stop())
      .then(() => database.close())
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
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exit(1);
});
