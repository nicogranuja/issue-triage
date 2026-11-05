import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { DatabaseHandle } from '../../src/db/client.js';
import { issues, repositories } from '../../src/db/schema.js';
import {
  findDuplicateCandidates,
  rankBySimilarity,
  tokenize,
} from '../../src/triage/duplicates.js';
import { createMigratedTestDatabase } from '../helpers/database.js';
import { seedIssue, seedRepository } from '../helpers/seed.js';

const newIssue = {
  title: 'PDF export fails for dashboards with an empty panel',
  body: "Click Export > PDF on a dashboard with an empty panel. Got a 500 and TypeError: cannot read properties of undefined (reading 'series').",
};

// A small repository history: one real duplicate, one related-but-different issue, and noise.
const history = [
  {
    title: 'Dark mode toggle does not persist after reload',
    body: 'The theme switches back to light every time I reload the page.',
  },
  {
    title: 'Exporting a dashboard to PDF crashes when a panel has no data',
    body: "Server log shows TypeError reading 'series' of undefined when exporting to PDF.",
  },
  {
    title: 'Add CSV export for table panels',
    body: 'It would be great to export the rows of a table panel as CSV.',
  },
  {
    title: 'Typo in the onboarding email',
    body: 'The welcome email says "dashbaord".',
  },
];

describe('tokenize', () => {
  it('lowercases, splits on punctuation, and drops stopwords and short numbers', () => {
    expect(tokenize("TypeError: can't read 'series' of undefined (v2, error 500, step 1)")).toEqual(
      ['typeerror', 'read', 'series', 'undefined', 'v2', 'error', '500', 'step'],
    );
  });

  it('keeps non-English words', () => {
    expect(tokenize('Exportación falla — 导出失败')).toEqual(['exportación', 'falla', '导出失败']);
  });
});

describe('rankBySimilarity', () => {
  it('ranks the duplicate first and leaves unrelated issues out', () => {
    const ranked = rankBySimilarity(newIssue, history);

    expect(ranked.map(({ doc }) => doc.title)).toEqual([
      'Exporting a dashboard to PDF crashes when a panel has no data',
      'Add CSV export for table panels',
    ]);
    expect(ranked[0]?.score).toBeGreaterThan(0.3);
    expect(ranked[0]?.score).toBeLessThanOrEqual(1);
  });

  it('scores an identical issue at 1', () => {
    const [match] = rankBySimilarity(newIssue, [newIssue]);
    expect(match?.score).toBeCloseTo(1, 10);
  });

  it('returns at most `limit` candidates above `minScore`', () => {
    expect(rankBySimilarity(newIssue, history, { limit: 1 })).toHaveLength(1);
    expect(rankBySimilarity(newIssue, history, { minScore: 0.99 })).toEqual([]);
  });

  it('weights repository-wide words down', () => {
    // Every issue in this repository mentions "dashboard", so sharing it says little.
    const pool = [
      { title: 'Dashboard loads slowly', body: null },
      { title: 'Dashboard sharing link expires', body: null },
      { title: 'Dashboard panel colors reset', body: null },
    ];
    const ranked = rankBySimilarity({ title: 'Dashboard panel colors wrong', body: null }, pool, {
      minScore: 0,
    });
    expect(ranked[0]?.doc.title).toBe('Dashboard panel colors reset');
    expect(ranked[2]?.score).toBeLessThan(0.15);
  });

  it('handles empty input', () => {
    expect(rankBySimilarity({ title: '', body: null }, history)).toEqual([]);
    expect(rankBySimilarity(newIssue, [])).toEqual([]);
    expect(rankBySimilarity(newIssue, [{ title: '!!!', body: null }])).toEqual([]);
  });

  it('breaks ties by pool order, so results are stable', () => {
    const twin = { title: 'Export to PDF fails', body: null };
    const ranked = rankBySimilarity(twin, [{ ...twin }, { ...twin }], { minScore: 0 });
    expect(ranked.map(({ doc }) => doc)).toEqual([twin, twin]);
    expect(ranked[0]?.doc).not.toBe(ranked[1]?.doc);
  });
});

describe('findDuplicateCandidates', () => {
  let database: DatabaseHandle;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.db.execute(sql`truncate ${issues}, ${repositories} restart identity cascade`);
  });

  it('searches the same repository, skipping the issue itself and removed issues', async () => {
    const repository = await seedRepository(database.db);
    const otherRepository = await seedRepository(database.db, { name: 'lumen-docs' });
    const issue = await seedIssue(database.db, repository.id, newIssue);
    const duplicate = await seedIssue(database.db, repository.id, {
      ...history[1],
      state: 'closed',
    });
    await seedIssue(database.db, repository.id, {
      ...newIssue,
      removedAt: new Date(),
      removalReason: 'deleted',
    });
    await seedIssue(database.db, otherRepository.id, newIssue);
    for (const entry of [history[0], history[3]]) {
      await seedIssue(database.db, repository.id, entry);
    }

    const candidates = await findDuplicateCandidates(database.db, issue);

    expect(candidates).toEqual([
      {
        issueId: duplicate.id,
        number: duplicate.number,
        title: history[1]?.title,
        state: 'closed',
        excerpt: history[1]?.body,
        score: expect.any(Number) as number,
      },
    ]);
  });

  it('compares against the most recent issues only', async () => {
    const repository = await seedRepository(database.db);
    const issue = await seedIssue(database.db, repository.id, newIssue);
    await seedIssue(database.db, repository.id, {
      ...history[1],
      githubCreatedAt: new Date('2020-01-01T00:00:00Z'),
    });
    await seedIssue(database.db, repository.id, {
      ...history[0],
      githubCreatedAt: new Date('2026-10-01T00:00:00Z'),
    });

    expect(await findDuplicateCandidates(database.db, issue, { poolSize: 1 })).toEqual([]);
    expect(await findDuplicateCandidates(database.db, issue, { poolSize: 2 })).toHaveLength(1);
  });

  it('keeps excerpts short', async () => {
    const repository = await seedRepository(database.db);
    const issue = await seedIssue(database.db, repository.id, newIssue);
    await seedIssue(database.db, repository.id, {
      title: newIssue.title,
      body: `${newIssue.body} ${'More detail. '.repeat(500)}`,
    });

    const [candidate] = await findDuplicateCandidates(database.db, issue);
    expect(candidate?.excerpt.length).toBe(300);
  });
});
