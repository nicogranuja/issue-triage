import {
  conflictResponseSchema,
  recentReviewsResponseSchema,
  reviewResponseSchema,
  type ReviewRequest,
} from '@issue-triage/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { DatabaseHandle } from '../../src/db/client.js';
import {
  issues,
  repositories,
  reviews,
  triageJobs,
  triageSuggestions,
} from '../../src/db/schema.js';
import { claimJob, releaseJob, scheduleRetry } from '../../src/triage/queue.js';
import { createTestApp } from '../helpers/app.js';
import { createMigratedTestDatabase, queryRows } from '../helpers/database.js';
import { seedIssue, seedRepository, seedSuggestion } from '../helpers/seed.js';

const WRITE_BACK_DELAY_MS = 30_000;

const repositoryLabels = ['bug', 'Regression', 'area: export', 'needs triage', 'priority: high'];

describe('review API', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    app = await createTestApp(database, {
      PRIORITY_LABELS: '{"high":"priority: high"}',
      WRITE_BACK_DELAY_MS: String(WRITE_BACK_DELAY_MS),
    });
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  beforeEach(async () => {
    await database.db.execute(
      sql`truncate ${triageJobs}, ${reviews}, ${triageSuggestions}, ${issues}, ${repositories} restart identity cascade`,
    );
  });

  const db = () => database.db;

  /** An open issue labelled `needs triage`, with a pending suggestion of `bug` + `area: export`. */
  async function pendingSuggestion(overrides: Parameters<typeof seedSuggestion>[2] = {}) {
    const repo = await seedRepository(db(), {
      labels: repositoryLabels.map((name) => ({ name, description: null, color: 'ededed' })),
      labelsFetchedAt: new Date(),
    });
    const issue = await seedIssue(db(), repo.id, { labels: ['needs triage'] });
    const suggestion = await seedSuggestion(db(), issue.id, {
      labels: ['bug', 'area: export'],
      priority: 'medium',
      ...overrides,
    });
    return { repo, issue, suggestion };
  }

  function review(suggestionId: number, body: ReviewRequest | Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: `/api/suggestions/${suggestionId}/review`,
      payload: body,
    });
  }

  function undo(suggestionId: number) {
    return app.inject({ method: 'DELETE', url: `/api/suggestions/${suggestionId}/review` });
  }

  async function suggestionStatus(id: number) {
    const [row] = await db()
      .select({ status: triageSuggestions.status })
      .from(triageSuggestions)
      .where(eq(triageSuggestions.id, id));
    return row?.status;
  }

  const writeBackJobs = () =>
    db().select().from(triageJobs).where(eq(triageJobs.kind, 'write_back'));

  describe('POST /api/suggestions/:id/review', () => {
    it('accepts a suggestion: stores the review and queues its write-back after the undo window', async () => {
      const { issue, suggestion } = await pendingSuggestion();

      const response = await review(suggestion.id, { decision: 'accept' });

      expect(response.statusCode, response.body).toBe(200);
      const { review: stored } = reviewResponseSchema.parse(response.json());
      expect(stored).toMatchObject({
        suggestionId: suggestion.id,
        decision: 'accepted',
        labels: ['needs triage', 'bug', 'area: export'],
        priority: 'medium',
        labelsAdded: ['bug', 'area: export'],
        labelsRemoved: [],
        note: null,
        reviewerLogin: 'local',
        writeBack: { status: 'pending', attempts: 0, lastError: null, result: null },
      });
      expect(await suggestionStatus(suggestion.id)).toBe('reviewed');

      const [job] = await writeBackJobs();
      expect(job).toMatchObject({ issueId: issue.id, reviewId: stored.id, status: 'pending' });
      const delay = (job?.runAfter.getTime() ?? 0) - Date.now();
      expect(delay).toBeGreaterThan(WRITE_BACK_DELAY_MS - 5_000);
      expect(delay).toBeLessThanOrEqual(WRITE_BACK_DELAY_MS + 1_000);

      const queue = await app.inject({ method: 'GET', url: '/api/queue' });
      expect(queue.json()).toMatchObject({ items: [], total: 0 });
    });

    it('adds the label mapped to the priority', async () => {
      const { suggestion } = await pendingSuggestion({ priority: 'high' });

      const { review: stored } = reviewResponseSchema.parse(
        (await review(suggestion.id, { decision: 'accept' })).json(),
      );
      expect(stored.labelsAdded).toEqual(['bug', 'area: export', 'priority: high']);
    });

    it('applies an edit: its labels are the full set, so an unticked label is removed', async () => {
      const { suggestion } = await pendingSuggestion();

      const response = await review(suggestion.id, {
        decision: 'edit',
        // `regression` is spelled as the repository spells it; `needs triage` is unticked.
        labels: ['bug', 'regression'],
        baseLabels: ['needs triage'],
        priority: 'high',
        note: '  Seen on two dashboards.  ',
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(reviewResponseSchema.parse(response.json()).review).toMatchObject({
        decision: 'edited',
        labels: ['bug', 'Regression', 'priority: high'],
        priority: 'high',
        labelsAdded: ['bug', 'Regression', 'priority: high'],
        labelsRemoved: ['needs triage'],
        note: 'Seen on two dashboards.',
        writeBack: { status: 'pending' },
      });
    });

    it('never removes a label added to the issue after the reviewer opened it', async () => {
      const { issue, suggestion } = await pendingSuggestion();
      // A maintainer labels the issue on GitHub while the reviewer is editing; the webhook
      // stores it, and the suggestion stays pending.
      await db()
        .update(issues)
        .set({ labels: ['needs triage', 'Regression'] })
        .where(eq(issues.id, issue.id));

      const response = await review(suggestion.id, {
        decision: 'edit',
        labels: ['bug'],
        baseLabels: ['needs triage'],
      });

      expect(reviewResponseSchema.parse(response.json()).review).toMatchObject({
        labels: ['Regression', 'bug'],
        labelsAdded: ['bug'],
        labelsRemoved: ['needs triage'],
      });
    });

    it('keeps the suggested labels when an edit only changes the priority', async () => {
      const { suggestion } = await pendingSuggestion();

      const response = await review(suggestion.id, { decision: 'edit', priority: 'low' });
      expect(reviewResponseSchema.parse(response.json()).review).toMatchObject({
        priority: 'low',
        labelsAdded: ['bug', 'area: export'],
        labelsRemoved: [],
      });
    });

    it('refuses labels the repository does not have, and stores nothing', async () => {
      const { suggestion } = await pendingSuggestion();

      const response = await review(suggestion.id, {
        decision: 'edit',
        labels: ['bug', 'made-up'],
        baseLabels: ['needs triage'],
      });

      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({ error: 'Not labels of this repository: made-up' });
      expect(await suggestionStatus(suggestion.id)).toBe('pending');
      expect(await db().select().from(reviews)).toEqual([]);
    });

    it('rejects a suggestion without queueing any write-back', async () => {
      const { suggestion } = await pendingSuggestion();

      const response = await review(suggestion.id, { decision: 'reject', note: 'Not a bug.' });

      expect(reviewResponseSchema.parse(response.json()).review).toMatchObject({
        decision: 'rejected',
        labels: null,
        priority: null,
        labelsAdded: [],
        labelsRemoved: [],
        note: 'Not a bug.',
        writeBack: null,
        undoable: true,
        undoWindowMs: null,
      });
      expect(await writeBackJobs()).toEqual([]);
    });

    it('queues nothing when accepting changes no labels', async () => {
      const { suggestion } = await pendingSuggestion({ labels: ['needs triage'] });

      const response = await review(suggestion.id, { decision: 'accept' });
      expect(reviewResponseSchema.parse(response.json()).review.writeBack).toBeNull();
      expect(await writeBackJobs()).toEqual([]);
    });

    it('answers 409 when the suggestion was already reviewed', async () => {
      const { suggestion } = await pendingSuggestion();
      await review(suggestion.id, { decision: 'accept' });

      const response = await review(suggestion.id, { decision: 'reject' });

      expect(response.statusCode).toBe(409);
      expect(conflictResponseSchema.parse(response.json())).toEqual({
        code: 'already_reviewed',
        error: 'This suggestion was already reviewed.',
        currentSuggestionId: null,
      });
      expect(await writeBackJobs()).toHaveLength(1);
    });

    it('answers 409 with the newer suggestion when this one was superseded', async () => {
      const { issue, suggestion } = await pendingSuggestion({ status: 'superseded' });
      const newer = await seedSuggestion(db(), issue.id);

      const response = await review(suggestion.id, { decision: 'accept' });

      expect(response.statusCode).toBe(409);
      expect(conflictResponseSchema.parse(response.json())).toMatchObject({
        code: 'superseded',
        currentSuggestionId: newer.id,
      });
      expect(await db().select().from(reviews)).toEqual([]);
    });

    it('answers 409 when the issue was closed in the meantime', async () => {
      const { issue, suggestion } = await pendingSuggestion();
      await db().update(issues).set({ state: 'closed' }).where(eq(issues.id, issue.id));

      const response = await review(suggestion.id, { decision: 'accept' });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'issue_closed' });
    });

    it('lets exactly one of two simultaneous reviews win', async () => {
      const { suggestion } = await pendingSuggestion();

      const responses = await Promise.all([
        review(suggestion.id, { decision: 'accept' }),
        review(suggestion.id, { decision: 'reject' }),
      ]);

      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
      expect(await db().select().from(reviews)).toHaveLength(1);
    });

    it('stores the review and its write-back job atomically: neither without the other', async () => {
      const { suggestion } = await pendingSuggestion();
      // Make the write-back insert fail, standing in for a crash between the two writes.
      await db().execute(sql`
        create function refuse_write_back() returns trigger language plpgsql as $$
        begin raise exception 'write-back insert failed'; end $$`);
      await db().execute(sql`
        create trigger refuse_write_back before insert on triage_jobs
        for each row when (new.kind = 'write_back') execute function refuse_write_back()`);
      try {
        const response = await review(suggestion.id, { decision: 'accept' });

        expect(response.statusCode).toBe(500);
        expect(response.json()).toEqual({ error: 'Internal Server Error' });
        expect(await suggestionStatus(suggestion.id)).toBe('pending');
        expect(await db().select().from(reviews)).toEqual([]);
      } finally {
        await db().execute(sql`drop trigger refuse_write_back on triage_jobs`);
        await db().execute(sql`drop function refuse_write_back()`);
      }

      // With the fault gone, the same review goes through.
      expect((await review(suggestion.id, { decision: 'accept' })).statusCode).toBe(200);
      expect(await writeBackJobs()).toHaveLength(1);
    });

    it('validates the request', async () => {
      const { suggestion } = await pendingSuggestion();

      for (const body of [
        {},
        { decision: 'approve' },
        // Accepting takes the suggestion as it is; changing labels is an edit.
        { decision: 'accept', labels: ['bug'] },
        { decision: 'edit', priority: 'critical' },
        { decision: 'edit', labels: [''], baseLabels: [] },
        // The labels an edit removes are worked out from the labels the reviewer saw.
        { decision: 'edit', labels: ['bug'] },
        { decision: 'reject', note: 'x'.repeat(2001) },
      ]) {
        const response = await review(suggestion.id, body);
        expect(response.statusCode, JSON.stringify(body)).toBe(400);
      }
      expect((await review(999, { decision: 'accept' })).statusCode).toBe(404);
      expect(await suggestionStatus(suggestion.id)).toBe('pending');
    });

    it('only takes JSON, so a cross-site form cannot submit a review', async () => {
      const { suggestion } = await pendingSuggestion();

      for (const contentType of ['text/plain', 'application/x-www-form-urlencoded']) {
        const response = await app.inject({
          method: 'POST',
          url: `/api/suggestions/${suggestion.id}/review`,
          headers: { 'content-type': contentType },
          payload: 'decision=accept',
        });
        expect(response.statusCode, contentType).toBe(415);
      }
      expect(await suggestionStatus(suggestion.id)).toBe('pending');
    });
  });

  describe('DELETE /api/suggestions/:id/review (undo)', () => {
    it('returns the suggestion to the queue and drops its waiting write-back', async () => {
      const { suggestion } = await pendingSuggestion();
      await review(suggestion.id, { decision: 'accept' });

      const response = await undo(suggestion.id);

      expect(response.statusCode).toBe(204);
      expect(await suggestionStatus(suggestion.id)).toBe('pending');
      expect(await db().select().from(reviews)).toEqual([]);
      expect(await writeBackJobs()).toEqual([]);
      const queue = await app.inject({ method: 'GET', url: '/api/queue' });
      expect(queue.json()).toMatchObject({ total: 1 });
      // And it can be reviewed again.
      expect((await review(suggestion.id, { decision: 'reject' })).statusCode).toBe(200);
    });

    it('undoes a rejection', async () => {
      const { suggestion } = await pendingSuggestion();
      await review(suggestion.id, { decision: 'reject' });

      expect((await undo(suggestion.id)).statusCode).toBe(204);
      expect(await suggestionStatus(suggestion.id)).toBe('pending');
    });

    it('refuses once a worker has claimed the write-back', async () => {
      const { suggestion } = await pendingSuggestion();
      await review(suggestion.id, { decision: 'accept' });
      await db().execute(sql`update triage_jobs set run_after = now() where kind = 'write_back'`);
      expect(await claimJob(db(), { workerId: 'test', leaseMs: 60_000 })).not.toBeNull();

      const response = await undo(suggestion.id);

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'write_back_started' });
      expect(await suggestionStatus(suggestion.id)).toBe('reviewed');
    });

    it('refuses once the write-back has run, even if it is waiting to retry', async () => {
      const { suggestion } = await pendingSuggestion();
      await review(suggestion.id, { decision: 'accept' });
      await db().execute(sql`update triage_jobs set run_after = now() where kind = 'write_back'`);
      const claimed = await claimJob(db(), { workerId: 'test', leaseMs: 60_000 });
      if (!claimed) {
        throw new Error('Expected to claim the write-back');
      }
      // It may have applied some labels before failing.
      await scheduleRetry(db(), claimed, { error: 'GitHub returned 502', delayMs: 60_000 });

      const response = await undo(suggestion.id);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'write_back_started' });
    });

    it('refuses once a worker has claimed the write-back, even if it released it unfinished', async () => {
      const { suggestion } = await pendingSuggestion();
      const accepted = reviewResponseSchema.parse(
        (await review(suggestion.id, { decision: 'accept' })).json(),
      ).review;
      expect(accepted.undoable).toBe(true);
      expect(accepted.undoWindowMs).toBeGreaterThan(WRITE_BACK_DELAY_MS - 5_000);

      await db().execute(sql`update triage_jobs set run_after = now() where kind = 'write_back'`);
      const claimed = await claimJob(db(), { workerId: 'test', leaseMs: 60_000 });
      if (!claimed) {
        throw new Error('Expected to claim the write-back');
      }
      // A worker shutting down mid-run puts the job back without counting the attempt; it may
      // already have added labels.
      await releaseJob(db(), claimed);

      const response = await undo(suggestion.id);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'write_back_started' });
      const recent = recentReviewsResponseSchema.parse(
        (await app.inject({ method: 'GET', url: '/api/reviews' })).json(),
      );
      expect(recent.items[0]?.review).toMatchObject({ undoable: false, undoWindowMs: null });
    });

    it('refuses when a newer suggestion arrived since the review', async () => {
      const { issue, suggestion } = await pendingSuggestion();
      await review(suggestion.id, { decision: 'reject' });
      const newer = await seedSuggestion(db(), issue.id);

      const response = await undo(suggestion.id);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: 'superseded',
        currentSuggestionId: newer.id,
      });
    });

    it('answers 409, not 500, when a newer suggestion lands while undoing', async () => {
      const { suggestion } = await pendingSuggestion();
      await review(suggestion.id, { decision: 'reject' });
      // Stands in for a triage run committing a new pending suggestion in the middle of the undo,
      // after its check: the undo's own update then collides with it.
      await db().execute(sql`
        create function race_undo() returns trigger language plpgsql as $$
        begin
          insert into triage_suggestions (issue_id, summary, labels, labels_confidence,
            labels_rationale, priority, priority_confidence, priority_rationale,
            duplicates_confidence, duplicates_rationale, model, prompt_version, input_tokens,
            output_tokens, cache_read_input_tokens, cache_creation_input_tokens, model_calls,
            latency_ms)
          values (new.issue_id, 'Newer.', '{}', 0.5, 'x', 'low', 0.5, 'x', 0.5, 'x', 'fake',
            'triage-v1', 0, 0, 0, 0, 1, 0);
          return new;
        end $$`);
      await db().execute(sql`
        create trigger race_undo before update on triage_suggestions
        for each row when (new.status = 'pending' and old.status = 'reviewed')
        execute function race_undo()`);
      try {
        const response = await undo(suggestion.id);

        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ code: 'superseded' });
        expect(await suggestionStatus(suggestion.id)).toBe('reviewed');
      } finally {
        await db().execute(sql`drop trigger race_undo on triage_suggestions`);
        await db().execute(sql`drop function race_undo()`);
      }
    });

    it('answers 404 when there is no review to undo', async () => {
      const { suggestion } = await pendingSuggestion();
      expect((await undo(suggestion.id)).statusCode).toBe(404);
      expect((await undo(999)).statusCode).toBe(404);
    });
  });

  describe('GET /api/reviews', () => {
    it('lists recent reviews, newest first, with their write-back state', async () => {
      const first = await pendingSuggestion();
      const second = await pendingSuggestion();
      await review(first.suggestion.id, { decision: 'accept' });
      await review(second.suggestion.id, { decision: 'reject' });
      await queryRows(
        db(),
        sql`update triage_jobs set last_error = 'GitHub returned 502' where kind = 'write_back'`,
      );

      const response = await app.inject({ method: 'GET', url: '/api/reviews?limit=10' });
      const { items } = recentReviewsResponseSchema.parse(response.json());

      expect(items.map((item) => [item.issue.number, item.review.decision])).toEqual([
        [second.issue.number, 'rejected'],
        [first.issue.number, 'accepted'],
      ]);
      expect(items[1]?.review.writeBack).toMatchObject({
        status: 'pending',
        lastError: 'GitHub returned 502',
      });
      expect(items[1]?.repository.fullName).toBe('lumen-labs/lumen');
    });
  });
});
