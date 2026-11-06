import { labelKey } from '@issue-triage/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { DatabaseHandle } from '../../src/db/client.js';
import {
  issues,
  repositories,
  reviews,
  triageJobs,
  triageSuggestions,
} from '../../src/db/schema.js';
import {
  DEMO_PRIORITY_LABELS,
  DEMO_REPOSITORIES,
  seedDemoData,
  seedDemoDataIfEmpty,
} from '../../src/dev/seed.js';
import { listQueue } from '../../src/review/queries.js';
import { submitReview } from '../../src/review/service.js';
import { createMigratedTestDatabase } from '../helpers/database.js';
import { seedRepository } from '../helpers/seed.js';

describe('demo data', () => {
  let database: DatabaseHandle;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.db.execute(
      sql`truncate ${triageJobs}, ${reviews}, ${triageSuggestions}, ${issues}, ${repositories} restart identity cascade`,
    );
  });

  const db = () => database.db;

  it('only suggests labels each repository defines, and duplicates that exist', () => {
    for (const repository of DEMO_REPOSITORIES) {
      const defined = new Set(repository.labels.map(([name]) => labelKey(name)));
      const numbers = new Set(repository.issues.map((issue) => issue.number));
      for (const label of Object.values(DEMO_PRIORITY_LABELS)) {
        expect(defined.has(labelKey(label)), label).toBe(true);
      }
      for (const issue of repository.issues) {
        for (const label of [...(issue.labels ?? []), ...(issue.suggestion?.labels[0] ?? [])]) {
          expect(defined.has(labelKey(label)), `${repository.name}#${issue.number}: ${label}`).toBe(
            true,
          );
        }
        for (const duplicate of issue.suggestion?.duplicates?.[0] ?? []) {
          expect(numbers.has(duplicate.number)).toBe(true);
        }
      }
    }
  });

  it('fills the review queue', async () => {
    await seedDemoData(db());

    const queue = await listQueue(db(), { limit: 100 });
    const expected = DEMO_REPOSITORIES.flatMap((repo) => repo.issues).filter(
      (issue) => issue.suggestion && issue.state !== 'closed',
    ).length;
    expect(queue.total).toBe(expected);
    expect(queue.items[0]?.priority).toBe('urgent');
  });

  it('replaces an earlier copy of itself, reviews included, and leaves other data alone', async () => {
    const other = await seedRepository(db(), { fullName: 'someone/else' });
    await seedDemoData(db());
    const first = (await listQueue(db(), { limit: 1 })).items[0];
    if (!first) {
      throw new Error('Expected demo suggestions');
    }
    await submitReview(
      db(),
      first.suggestionId,
      { decision: 'accept' },
      { priorityLabels: {}, writeBackDelayMs: 0 },
    );

    await seedDemoData(db());

    expect(await db().select().from(reviews)).toEqual([]);
    expect(await db().select().from(triageJobs)).toEqual([]);
    expect(
      await db().select().from(repositories).where(eq(repositories.id, other.id)),
    ).toHaveLength(1);
    expect(await db().select().from(repositories)).toHaveLength(DEMO_REPOSITORIES.length + 1);
  });

  it('seeds on startup only when the database has no repositories', async () => {
    await seedRepository(db());
    expect(await seedDemoDataIfEmpty(db())).toBe(false);

    await db().execute(sql`truncate ${repositories} restart identity cascade`);
    expect(await seedDemoDataIfEmpty(db())).toBe(true);
    expect(await seedDemoDataIfEmpty(db())).toBe(false);
  });
});
