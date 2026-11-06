import {
  queueResponseSchema,
  repositoriesResponseSchema,
  suggestionDetailSchema,
  type QueueResponse,
} from '@issue-triage/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { DatabaseHandle } from '../../src/db/client.js';
import { issues, repositories, triageSuggestions } from '../../src/db/schema.js';
import { encodeCursor } from '../../src/review/queries.js';
import { createTestApp } from '../helpers/app.js';
import { createMigratedTestDatabase } from '../helpers/database.js';
import { seedIssue, seedRepository, seedReview, seedSuggestion } from '../helpers/seed.js';

describe('review queue API', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    app = await createTestApp(database, { PRIORITY_LABELS: '{"high":"priority: high"}' });
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  beforeEach(async () => {
    await database.db.execute(
      sql`truncate ${triageSuggestions}, ${issues}, ${repositories} restart identity cascade`,
    );
  });

  const db = () => database.db;

  async function getQueue(query = ''): Promise<QueueResponse> {
    const response = await app.inject({ method: 'GET', url: `/api/queue${query}` });
    expect(response.statusCode, response.body).toBe(200);
    return queueResponseSchema.parse(response.json());
  }

  const titles = (queue: QueueResponse) => queue.items.map((item) => item.issue.title);

  describe('GET /api/queue', () => {
    it('lists pending suggestions of open issues, most urgent first, then oldest first', async () => {
      const repo = await seedRepository(db());
      const add = async (title: string, priority: 'urgent' | 'high' | 'medium' | 'low') => {
        const issue = await seedIssue(db(), repo.id, { title });
        return seedSuggestion(db(), issue.id, { priority });
      };
      await add('medium, older', 'medium');
      await add('urgent', 'urgent');
      await add('medium, newer', 'medium');
      await add('low', 'low');

      const queue = await getQueue();

      expect(titles(queue)).toEqual(['urgent', 'medium, older', 'medium, newer', 'low']);
      expect(queue.total).toBe(4);
      expect(queue.nextCursor).toBeNull();
      expect(queue.items[0]).toMatchObject({
        repository: { fullName: 'lumen-labs/lumen' },
        issue: { title: 'urgent', labels: [] },
        labels: ['bug'],
        priority: 'urgent',
        confidence: expect.closeTo(0.6, 5) as number,
      });
    });

    it('leaves out reviewed and superseded suggestions, and closed or removed issues', async () => {
      const repo = await seedRepository(db());
      const listed = await seedIssue(db(), repo.id, { title: 'listed' });
      await seedSuggestion(db(), listed.id);
      const reviewed = await seedIssue(db(), repo.id, { title: 'reviewed' });
      await seedReview(db(), (await seedSuggestion(db(), reviewed.id)).id);
      const superseded = await seedIssue(db(), repo.id, { title: 'superseded' });
      await seedSuggestion(db(), superseded.id, { status: 'superseded' });
      const closed = await seedIssue(db(), repo.id, { title: 'closed', state: 'closed' });
      await seedSuggestion(db(), closed.id);
      const removed = await seedIssue(db(), repo.id, {
        title: 'removed',
        removedAt: new Date(),
        removalReason: 'deleted',
      });
      await seedSuggestion(db(), removed.id);

      const queue = await getQueue();
      expect(titles(queue)).toEqual(['listed']);
      expect(queue.total).toBe(1);
    });

    it('filters by repository, priority, and confidence band', async () => {
      const lumen = await seedRepository(db());
      const prism = await seedRepository(db(), {
        owner: 'prism',
        name: 'prism',
        fullName: 'prism/prism',
      });
      const add = async (
        repositoryId: number,
        title: string,
        priority: 'urgent' | 'high' | 'medium' | 'low',
        confidence: number,
      ) => {
        const issue = await seedIssue(db(), repositoryId, { title });
        await seedSuggestion(db(), issue.id, {
          priority,
          labelsConfidence: confidence,
          priorityConfidence: 0.95,
        });
      };
      await add(lumen.id, 'lumen urgent sure', 'urgent', 0.9);
      await add(lumen.id, 'lumen low unsure', 'low', 0.3);
      await add(prism.id, 'prism high middling', 'high', 0.6);
      await add(prism.id, 'prism high sure', 'high', 0.8);

      expect(titles(await getQueue('?repo=prism/prism'))).toEqual([
        'prism high middling',
        'prism high sure',
      ]);
      expect(titles(await getQueue('?priority=urgent,low'))).toEqual([
        'lumen urgent sure',
        'lumen low unsure',
      ]);
      // A suggestion is as sure as its least sure part; 0.8 is the floor of "high".
      expect(titles(await getQueue('?confidence=high'))).toEqual([
        'lumen urgent sure',
        'prism high sure',
      ]);
      expect(titles(await getQueue('?confidence=medium,low'))).toEqual([
        'prism high middling',
        'lumen low unsure',
      ]);
      const combined = await getQueue('?repo=prism/prism&priority=high&confidence=medium');
      expect(titles(combined)).toEqual(['prism high middling']);
      expect(combined.total).toBe(1);
    });

    it('pages by keyset, without skipping or repeating when rows leave mid-way', async () => {
      const repo = await seedRepository(db());
      const suggestionIds: number[] = [];
      for (const [index, priority] of (
        ['low', 'high', 'medium', 'high', 'low'] as const
      ).entries()) {
        const issue = await seedIssue(db(), repo.id, { title: `issue ${index}` });
        suggestionIds.push((await seedSuggestion(db(), issue.id, { priority })).id);
      }

      const first = await getQueue('?limit=2');
      expect(titles(first)).toEqual(['issue 1', 'issue 3']);
      expect(first.total).toBe(5);
      expect(first.nextCursor).not.toBeNull();

      // A reviewer handles the first page's rows before loading the next one. An offset would
      // now skip two rows; the keyset continues right after the last row seen.
      for (const item of first.items) {
        await seedReview(db(), item.suggestionId);
      }
      const second = await getQueue(`?limit=2&cursor=${first.nextCursor ?? ''}`);
      expect(titles(second)).toEqual(['issue 2', 'issue 0']);
      expect(second.total).toBe(3);

      const third = await getQueue(`?limit=2&cursor=${second.nextCursor ?? ''}`);
      expect(titles(third)).toEqual(['issue 4']);
      expect(third.nextCursor).toBeNull();
    });

    it('accepts its own cursors and refuses anything else', async () => {
      expect((await getQueue(`?cursor=${encodeCursor(['medium', 1])}`)).items).toEqual([]);

      for (const query of [
        '?cursor=not-a-cursor',
        `?cursor=${Buffer.from('["sometime",1]').toString('base64url')}`,
        '?priority=critical',
        '?confidence=',
        '?limit=0',
        '?limit=1000',
        '?repo=../../etc',
      ]) {
        const response = await app.inject({ method: 'GET', url: `/api/queue${query}` });
        expect(response.statusCode, query).toBe(400);
        expect(response.json()).toEqual({ error: expect.any(String) as string });
      }
    });
  });

  describe('GET /api/repositories', () => {
    it('lists repositories with how many suggestions await review', async () => {
      const lumen = await seedRepository(db());
      await seedRepository(db(), { owner: 'prism', name: 'prism', fullName: 'prism/prism' });
      for (let index = 0; index < 2; index += 1) {
        await seedSuggestion(db(), (await seedIssue(db(), lumen.id)).id);
      }
      await seedSuggestion(db(), (await seedIssue(db(), lumen.id, { state: 'closed' })).id);

      const response = await app.inject({ method: 'GET', url: '/api/repositories' });
      expect(repositoriesResponseSchema.parse(response.json())).toEqual({
        repositories: [
          { fullName: 'lumen-labs/lumen', pending: 2 },
          { fullName: 'prism/prism', pending: 0 },
        ],
      });
    });
  });

  describe('GET /api/suggestions/:id', () => {
    it('returns the issue, the suggestion with its duplicates, and the repository labels', async () => {
      const repo = await seedRepository(db(), {
        labels: [{ name: 'bug', description: "Something isn't working", color: 'd73a4a' }],
        labelsFetchedAt: new Date(),
      });
      const original = await seedIssue(db(), repo.id, { title: 'Original report', number: 17 });
      const gone = await seedIssue(db(), repo.id, {
        number: 18,
        removedAt: new Date(),
        removalReason: 'deleted',
      });
      const issue = await seedIssue(db(), repo.id, {
        number: 42,
        title: 'Export crashes',
        body: 'Steps to reproduce',
        labels: ['needs triage'],
        authorLogin: 'octo',
      });
      const suggestion = await seedSuggestion(db(), issue.id, {
        summary: 'Export crashes on empty panels.',
        duplicates: [
          { issueId: original.id, reason: 'Same stack trace.' },
          { issueId: gone.id, reason: 'Deleted since.' },
        ],
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/suggestions/${suggestion.id}`,
      });
      expect(response.statusCode).toBe(200);
      const detail = suggestionDetailSchema.parse(response.json());

      expect(detail).toMatchObject({
        id: suggestion.id,
        status: 'pending',
        newerSuggestionId: null,
        summary: 'Export crashes on empty panels.',
        labels: { names: ['bug'], rationale: 'Seeded.' },
        priority: { level: 'medium', rationale: 'Seeded.' },
        duplicates: {
          issues: [
            {
              issueId: original.id,
              number: 17,
              title: 'Original report',
              state: 'open',
              htmlUrl: 'https://github.com/lumen-labs/lumen/issues/17',
              reason: 'Same stack trace.',
            },
          ],
        },
        issue: {
          number: 42,
          title: 'Export crashes',
          body: 'Steps to reproduce',
          labels: ['needs triage'],
          authorLogin: 'octo',
          removed: false,
        },
        repository: {
          fullName: 'lumen-labs/lumen',
          labels: [{ name: 'bug', description: "Something isn't working", color: 'd73a4a' }],
        },
        priorityLabels: { high: 'priority: high' },
        review: null,
      });
    });

    it('points an out-of-date suggestion at the newer one', async () => {
      const repo = await seedRepository(db());
      const issue = await seedIssue(db(), repo.id);
      const old = await seedSuggestion(db(), issue.id, { status: 'superseded' });
      const current = await seedSuggestion(db(), issue.id);

      const response = await app.inject({ method: 'GET', url: `/api/suggestions/${old.id}` });
      expect(suggestionDetailSchema.parse(response.json())).toMatchObject({
        status: 'superseded',
        newerSuggestionId: current.id,
      });
    });

    it('answers 404 for an unknown id and 400 for a malformed one', async () => {
      expect((await app.inject({ method: 'GET', url: '/api/suggestions/999' })).statusCode).toBe(
        404,
      );
      for (const id of ['abc', '0', '-1', '1.5', '99999999999999999999']) {
        const response = await app.inject({ method: 'GET', url: `/api/suggestions/${id}` });
        expect(response.statusCode, id).toBe(400);
      }
    });
  });

  it('keeps the issue labels it lists in step with the stored issue', async () => {
    const repo = await seedRepository(db());
    const issue = await seedIssue(db(), repo.id, { labels: ['bug'] });
    await seedSuggestion(db(), issue.id);
    await db()
      .update(issues)
      .set({ labels: ['bug', 'p1'] })
      .where(eq(issues.id, issue.id));

    expect((await getQueue()).items[0]?.issue.labels).toEqual(['bug', 'p1']);
  });
});
