import { randomUUID } from 'node:crypto';

import type { SQL } from 'drizzle-orm';
import pg from 'pg';

import { connectDatabase, type Database, type DatabaseHandle } from '../../src/db/client.js';

/**
 * Creates an empty, isolated database for one test file.
 *
 * Without `DATABASE_URL` this is an in-memory PGlite instance. With `DATABASE_URL` (as in CI) it
 * is a throwaway database created on that Postgres server and dropped on `close()`, so test files
 * can run in parallel without sharing state.
 */
export async function createTestDatabase(): Promise<DatabaseHandle> {
  const serverUrl = process.env.DATABASE_URL;
  if (!serverUrl) {
    return connectDatabase({ driver: 'pglite', dataDir: 'memory://' });
  }

  const name = `issue_triage_test_${randomUUID().replaceAll('-', '')}`;
  await withAdminClient(serverUrl, (client) => client.query(`CREATE DATABASE ${name}`));
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  const handle = await connectDatabase({ driver: 'postgres', url: url.toString() });

  return {
    ...handle,
    close: async () => {
      await handle.close();
      await withAdminClient(serverUrl, (client) =>
        client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`),
      );
    },
  };
}

/** A test database with all migrations applied. */
export async function createMigratedTestDatabase(): Promise<DatabaseHandle> {
  const database = await createTestDatabase();
  await database.migrate();
  return database;
}

/** Runs raw SQL and returns its rows. Both drivers return results with a `rows` array. */
export async function queryRows<T>(db: Database, query: SQL): Promise<T[]> {
  const result = (await db.execute(query)) as { rows: T[] };
  return result.rows;
}

async function withAdminClient(url: string, run: (client: pg.Client) => Promise<unknown>) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await run(client);
  } finally {
    await client.end();
  }
}
