import { readFile } from 'node:fs/promises';

import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DatabaseHandle } from '../../src/db/client.js';
import { createTestDatabase, queryRows } from '../helpers/database.js';

const journalUrl = new URL('../../drizzle/meta/_journal.json', import.meta.url);

async function migrationCount(): Promise<number> {
  const journal = JSON.parse(await readFile(journalUrl, 'utf8')) as { entries: unknown[] };
  return journal.entries.length;
}

describe('migrations', () => {
  let database: DatabaseHandle;

  beforeEach(async () => {
    database = await createTestDatabase();
  });

  afterEach(async () => {
    await database.close();
  });

  it('runs on the driver selected by DATABASE_URL', () => {
    expect(database.driver).toBe(process.env.DATABASE_URL ? 'postgres' : 'pglite');
  });

  it('creates every table on an empty database', async () => {
    await database.migrate();

    const tables = await queryRows<{ table_name: string }>(
      database.db,
      sql`select table_name from information_schema.tables
          where table_schema = 'public' order by table_name`,
    );
    expect(tables.map((t) => t.table_name)).toEqual([
      'issues',
      'repositories',
      'reviews',
      'triage_jobs',
      'triage_suggestions',
      'webhook_deliveries',
    ]);
  });

  it('records each migration once and is a no-op when run again', async () => {
    await database.migrate();
    await database.migrate();

    const [applied] = await queryRows<{ count: number }>(
      database.db,
      sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
    );
    expect(applied?.count).toBe(await migrationCount());
  });

  it('enforces constraints declared in the schema', async () => {
    await database.migrate();

    await expect(
      database.db.execute(
        sql`insert into webhook_deliveries (delivery_id, event, outcome) values ('d-1', 'ping', 'unknown')`,
      ),
    ).rejects.toThrow();
    await expect(
      database.db.execute(
        sql`insert into repositories (github_id, owner, name, full_name, private) values (1, 'o', 'r', 'o/r', false), (1, 'o', 'r2', 'o/r2', false)`,
      ),
    ).rejects.toThrow();
  });
});
