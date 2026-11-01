import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { migrate as migratePostgres } from 'drizzle-orm/node-postgres/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import pg from 'pg';

import type { DatabaseConfig } from '../config.js';
import * as schema from './schema.js';

/** Driver-agnostic Drizzle database. Application code depends on this type only. */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

/** A transaction handle, as passed to `db.transaction(async (tx) => ...)`. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface DatabaseHandle {
  readonly driver: DatabaseConfig['driver'];
  readonly db: Database;
  /** Applies pending migrations from `apps/api/drizzle`. Safe to run repeatedly. */
  migrate(): Promise<void>;
  close(): Promise<void>;
}

export interface ConnectOptions {
  /**
   * Called when an idle pooled Postgres connection fails, for example when the server restarts.
   * Without a handler, node-postgres treats this as fatal and the process crashes.
   */
  onPoolError?: (error: Error) => void;
}

// Resolves to apps/api/drizzle from both src/db (tsx, tests) and dist/db (built output).
const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

export async function connectDatabase(
  config: DatabaseConfig,
  options: ConnectOptions = {},
): Promise<DatabaseHandle> {
  if (config.driver === 'postgres') {
    const pool = new pg.Pool({ connectionString: config.url });
    if (options.onPoolError) {
      pool.on('error', options.onPoolError);
    }
    const db = drizzlePostgres({ client: pool, schema });
    return {
      driver: 'postgres',
      db,
      migrate: () => migratePostgres(db, { migrationsFolder }),
      close: () => pool.end(),
    };
  }

  if (!config.dataDir.startsWith('memory://')) {
    await mkdir(config.dataDir, { recursive: true });
  }
  const client = await PGlite.create(config.dataDir);
  const db = drizzlePglite({ client, schema });
  return {
    driver: 'pglite',
    db,
    migrate: () => migratePglite(db, { migrationsFolder }),
    close: () => client.close(),
  };
}
