/**
 * Applies pending migrations to the configured database (`npm run db:migrate`).
 * Uses `DATABASE_URL` when set, otherwise the local PGlite data directory.
 */
import { pino } from 'pino';

import { ConfigError, loadDatabaseConfig } from '../config.js';
import { connectDatabase } from './client.js';

const logger = pino({ name: 'migrate' });

try {
  const config = loadDatabaseConfig();
  const database = await connectDatabase(config);
  try {
    await database.migrate();
    logger.info({ driver: database.driver }, 'migrations applied');
  } finally {
    await database.close();
  }
} catch (error) {
  if (error instanceof ConfigError) {
    logger.fatal(error.message);
  } else {
    logger.fatal({ err: error }, 'migration failed');
  }
  process.exitCode = 1;
}
