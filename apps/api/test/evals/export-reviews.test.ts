import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fixtureSchema, loadFixtures } from '../../evals/cases.js';
import { main } from '../../evals/cli.js';
import { exportReviewsMain } from '../../evals/export-reviews-cli.js';
import { EXPORT_BIAS_NOTE, exportReviewedCases } from '../../evals/export-reviews.js';
import type { DatabaseHandle } from '../../src/db/client.js';
import { createMigratedTestDatabase } from '../helpers/database.js';
import { seedIssue, seedRepository, seedReview, seedSuggestion } from '../helpers/seed.js';

const LABELS = [
  { name: 'bug', description: null, color: 'd73a4a' },
  { name: 'Docs', description: 'Documentation', color: '0075ca' },
  { name: 'P1', description: 'High priority', color: 'b60205' },
];
const priorityLabels = { high: 'P1' };

describe('export-reviews', () => {
  let database: DatabaseHandle;
  const directories: string[] = [];

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    const { db } = database;
    const repository = await seedRepository(db, {
      labels: LABELS,
      labelsFetchedAt: new Date(),
    });
    const at = (iso: string) => new Date(iso);

    // Edited: a label outside the repository's set and a priority label are dropped from gold.
    const edited = await seedIssue(db, repository.id, { number: 10, title: 'Crash on save' });
    await seedReview(db, (await seedSuggestion(db, edited.id)).id, {
      decision: 'edited',
      labels: ['BUG', 'docs', 'not-a-label', 'p1'],
      priority: 'high',
    });

    // Accepted, then re-triaged and reviewed again: the latest review wins.
    const twice = await seedIssue(db, repository.id, { number: 11, title: 'Typo in README' });
    const old = await seedSuggestion(db, twice.id, { createdAt: at('2026-11-01T00:00:00Z') });
    await seedReview(db, old.id, { labels: ['bug'], createdAt: at('2026-11-02T00:00:00Z') });
    const newer = await seedSuggestion(db, twice.id, {
      model: 'claude-sonnet-5-5',
      promptVersion: 'triage-v2',
    });
    await seedReview(db, newer.id, {
      labels: ['Docs'],
      priority: 'low',
      createdAt: at('2026-11-03T00:00:00Z'),
    });

    // Rejected: no ground truth.
    const rejected = await seedIssue(db, repository.id, { number: 12 });
    await seedReview(db, (await seedSuggestion(db, rejected.id)).id, {
      decision: 'rejected',
      labels: null,
      priority: null,
    });

    // Unreviewed: part of the pool, not a case.
    await seedIssue(db, repository.id, { number: 13, title: 'Unreviewed issue' });

    // A repository whose labels were never fetched: skipped.
    const unknown = await seedRepository(db, {
      owner: 'other',
      name: 'repo',
      fullName: 'other/repo',
    });
    const orphan = await seedIssue(db, unknown.id, { number: 1 });
    await seedReview(db, (await seedSuggestion(db, orphan.id)).id);
  });

  afterAll(async () => {
    await database.close();
    for (const dir of directories) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('turns reviews into cases: gold labels in the label set, minus priority labels', async () => {
    const { fixtures, skipped } = await exportReviewedCases(database.db, { priorityLabels });
    expect(fixtures).toHaveLength(1);
    const [fixture] = fixtures;
    expect(fixture?.repository).toBe('lumen-labs/lumen');
    expect(fixture?.source).toBe('exported-reviews');
    expect(fixture?.description).toBe(EXPORT_BIAS_NOTE);
    expect(fixture?.labels.map((l) => l.name)).toEqual(['bug', 'Docs', 'P1']);
    expect(fixture?.cases.map((c) => [c.issue.number, c.expected])).toEqual([
      [10, { labels: ['bug', 'Docs'], priority: 'high', duplicates: null, summary: null }],
      [11, { labels: ['Docs'], priority: 'low', duplicates: null, summary: null }],
    ]);
    expect(fixture?.cases[1]?.notes).toMatch(/accepted.*claude-sonnet-5-5 \(triage-v2\)/);
    expect(fixture?.cases.every((c) => c.tags.includes('exported'))).toBe(true);
    // The rejected and the unreviewed issue are the pool; the cases are not.
    expect(fixture?.pool.map((issue) => issue.number)).toEqual([12, 13]);
    expect(fixtureSchema.safeParse(fixture).success).toBe(true);
    expect(skipped.map((s) => s.reason).sort()).toEqual([
      'a later review of the same issue',
      "the repository's labels were never fetched",
    ]);
  });

  it('without priority labels configured, keeps a priority-named label as a label', async () => {
    const { fixtures } = await exportReviewedCases(database.db);
    expect(fixtures[0]?.cases[0]?.expected.labels).toEqual(['bug', 'Docs', 'P1']);
  });

  it('writes one fixture per repository that the eval CLI can run on', async () => {
    const out = mkdtempSync(join(tmpdir(), 'issue-triage-export-'));
    directories.push(out);
    const lines: string[] = [];
    const code = await exportReviewsMain(['--out', out], {
      env: { PRIORITY_LABELS: JSON.stringify(priorityLabels) },
      db: database.db,
      log: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    expect(readdirSync(out)).toEqual(['lumen-labs__lumen.json']);
    expect(lines.join('\n')).toMatch(/2 cases from 1 repositories/);
    expect(lines.join('\n')).toMatch(/favor the model/);
    const written = JSON.parse(
      readFileSync(join(out, 'lumen-labs__lumen.json'), 'utf8'),
    ) as unknown;
    expect(fixtureSchema.safeParse(written).success).toBe(true);
    expect(loadFixtures(out)).toHaveLength(1);

    const evalOut = mkdtempSync(join(tmpdir(), 'issue-triage-export-eval-'));
    directories.push(evalOut);
    expect(
      await main(['--provider', 'oracle', '--fixtures', out, '--out', evalOut], {
        env: {},
        log: () => undefined,
      }),
    ).toBe(0);
  });

  it('rejects a malformed PRIORITY_LABELS', async () => {
    const lines: string[] = [];
    const code = await exportReviewsMain([], {
      env: { PRIORITY_LABELS: 'not json' },
      db: database.db,
      log: (line) => lines.push(line),
    });
    expect(code).toBe(2);
    expect(lines.join('\n')).toMatch(/PRIORITY_LABELS/);
  });
});
