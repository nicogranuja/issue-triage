/**
 * `npm run seed`: (re)loads the demo repositories, issues, and suggestions into the configured
 * database, replacing any earlier copy of them and their reviews. Other data is left alone.
 *
 * With PGlite, stop the API first: the embedded database must only be open in one process.
 * (`npm run dev` seeds an empty PGlite database by itself.)
 */
import { createLogger } from '../src/logging.js';
import { ConfigError, loadDatabaseConfig } from '../src/config.js';
import { connectDatabase } from '../src/db/client.js';
import { DEMO_REPOSITORIES, seedDemoData } from '../src/dev/seed.js';

const logger = createLogger({ name: 'seed' });

try {
  if (process.env.NODE_ENV === 'production') {
    throw new ConfigError('Refusing to load demo data with NODE_ENV=production.');
  }
  const database = await connectDatabase(loadDatabaseConfig());
  try {
    await database.migrate();
    await seedDemoData(database.db);
    logger.info(
      { driver: database.driver, repositories: DEMO_REPOSITORIES.map((repo) => repo.name) },
      'demo data loaded',
    );
  } finally {
    await database.close();
  }
} catch (error) {
  if (error instanceof ConfigError) {
    logger.fatal(error.message);
  } else {
    logger.fatal({ err: error }, 'seeding failed');
  }
  process.exitCode = 1;
}
