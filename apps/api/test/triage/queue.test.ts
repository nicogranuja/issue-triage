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
  cancelJob,
  cancelJobsForIssue,
  claimJob,
  completeJob,
  enqueueTriageJob,
  enqueueWriteBackJob,
  failJob,
  releaseJob,
  retryDelayMs,
  MAX_RETRY_DELAY_MS,
  scheduleRetry,
  type ClaimedJob,
} from '../../src/triage/queue.js';
import { createMigratedTestDatabase } from '../helpers/database.js';
import { seedIssue, seedRepository, seedReview, seedSuggestion } from '../helpers/seed.js';

const claimOptions = { workerId: 'test-worker', leaseMs: 60_000 };

describe('triage job queue', () => {
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

  async function seedIssues(count: number): Promise<number[]> {
    const repository = await seedRepository(db());
    const ids: number[] = [];
    for (let i = 0; i < count; i += 1) {
      ids.push((await seedIssue(db(), repository.id)).id);
    }
    return ids;
  }

  async function job(jobId: number) {
    const [row] = await db().select().from(triageJobs).where(eq(triageJobs.id, jobId));
    if (!row) {
      throw new Error(`No triage job ${jobId}`);
    }
    return row;
  }

  async function claim(): Promise<ClaimedJob> {
    const claimed = await claimJob(db(), claimOptions);
    if (!claimed) {
      throw new Error('Expected a job to claim');
    }
    return claimed;
  }

  /** Moves a timestamp column into the past, standing in for the passage of time. */
  async function backdate(jobId: number, column: 'run_after' | 'locked_until') {
    await db().execute(
      sql`update triage_jobs set ${sql.identifier(column)} = now() - interval '1 second' where id = ${jobId}`,
    );
  }

  describe('enqueue', () => {
    it('creates one pending job per issue', async () => {
      const [issueId = 0] = await seedIssues(1);

      expect(await enqueueTriageJob(db(), issueId)).toBe(true);
      expect(await enqueueTriageJob(db(), issueId)).toBe(false);

      const jobs = await db().select().from(triageJobs);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ issueId, status: 'pending', attempts: 0 });
    });

    it('gives a waiting job a fresh attempt budget when the issue changes again', async () => {
      const [issueId = 0] = await seedIssues(1);
      await enqueueTriageJob(db(), issueId);
      const claimed = await claim();
      await scheduleRetry(db(), claimed, { error: 'overloaded', delayMs: 60_000 });
      const waiting = await job(claimed.jobId);

      expect(await enqueueTriageJob(db(), issueId)).toBe(false);

      expect(await job(claimed.jobId)).toMatchObject({
        status: 'pending',
        attempts: 0,
        runAfter: waiting.runAfter,
      });
    });

    it('creates a new job when the previous one is already running', async () => {
      const [issueId = 0] = await seedIssues(1);
      await enqueueTriageJob(db(), issueId);
      await claim();

      expect(await enqueueTriageJob(db(), issueId)).toBe(true);
      const statuses = (await db().select().from(triageJobs)).map((row) => row.status).sort();
      expect(statuses).toEqual(['pending', 'running']);
    });
  });

  describe('claim', () => {
    it('returns null when nothing is due', async () => {
      expect(await claimJob(db(), claimOptions)).toBeNull();
    });

    it('claims the oldest due job and takes a lease on it', async () => {
      const [first = 0, second = 0] = await seedIssues(2);
      await enqueueTriageJob(db(), first);
      await enqueueTriageJob(db(), second);

      const claimed = await claim();

      expect(claimed).toMatchObject({ issueId: first, attempts: 1 });
      expect(claimed.leaseToken).toMatch(/^[0-9a-f-]{36}$/);
      expect(await job(claimed.jobId)).toMatchObject({
        status: 'running',
        lockedBy: 'test-worker',
        leaseToken: claimed.leaseToken,
      });
      expect(claimed.lockedUntil.getTime()).toBeGreaterThan(Date.now());
    });

    it('does not claim a job before its run_after time', async () => {
      const [issueId = 0] = await seedIssues(1);
      await enqueueTriageJob(db(), issueId);
      await db()
        .update(triageJobs)
        .set({ runAfter: sql`now() + interval '1 hour'` });

      expect(await claimJob(db(), claimOptions)).toBeNull();
    });

    it('does not start a second job for an issue while one is running', async () => {
      const [issueId = 0, otherIssueId = 0] = await seedIssues(2);
      await enqueueTriageJob(db(), issueId);
      const running = await claim();
      await enqueueTriageJob(db(), issueId); // the issue is edited mid-run
      await enqueueTriageJob(db(), otherIssueId);

      // Other issues are not held up...
      expect((await claim()).issueId).toBe(otherIssueId);
      // ...but this issue's newer job waits for the running one.
      expect(await claimJob(db(), claimOptions)).toBeNull();

      await completeJob(db(), running);
      expect((await claim()).issueId).toBe(issueId);
    });

    it('reclaims a stalled run before starting the newer job for the same issue', async () => {
      const [issueId = 0] = await seedIssues(1);
      await enqueueTriageJob(db(), issueId);
      const stalled = await claim();
      await enqueueTriageJob(db(), issueId);
      await backdate(stalled.jobId, 'locked_until');

      const reclaimed = await claim();
      expect(reclaimed).toMatchObject({ jobId: stalled.jobId, attempts: 2 });
      expect(await claimJob(db(), claimOptions)).toBeNull();

      await completeJob(db(), reclaimed);
      expect((await claim()).jobId).not.toBe(stalled.jobId);
    });

    // On PGlite the claims are serialized; on Postgres they run on separate connections.
    it('never hands the same job to two concurrent claimers', async () => {
      const issueIds = await seedIssues(8);
      for (const issueId of issueIds) {
        await enqueueTriageJob(db(), issueId);
      }

      // More claimers than jobs, all at once. On Postgres these run on separate connections.
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          claimJob(db(), { ...claimOptions, workerId: `worker-${i}` }),
        ),
      );

      const claimed = results.filter((result) => result !== null);
      expect(claimed).toHaveLength(8);
      expect(new Set(claimed.map((c) => c.jobId)).size).toBe(8);
    });

    // PGlite has a single connection, so a second claimer cannot run while a transaction is open.
    it.runIf(process.env.DATABASE_URL)(
      'skips a row another transaction has locked instead of waiting for it',
      async () => {
        const [first = 0, second = 0] = await seedIssues(2);
        await enqueueTriageJob(db(), first);
        await enqueueTriageJob(db(), second);

        await db().transaction(async (tx) => {
          // Worker A claims inside an open transaction, so its row lock is still held...
          const a = await claimJob(tx, { ...claimOptions, workerId: 'a' });
          // ...while worker B claims on another connection. Without SKIP LOCKED, B would block
          // on A's row until A commits, and this test would time out.
          const b = await claimJob(db(), { ...claimOptions, workerId: 'b' });

          expect(a?.issueId).toBe(first);
          expect(b?.issueId).toBe(second);
        });
      },
    );
  });

  describe('finishing a job', () => {
    it('completes a job while the lease is held', async () => {
      const [issueId = 0] = await seedIssues(1);
      await enqueueTriageJob(db(), issueId);
      const claimed = await claim();

      expect(await completeJob(db(), claimed)).toBe(true);

      const row = await job(claimed.jobId);
      expect(row).toMatchObject({ status: 'succeeded', leaseToken: null, lockedUntil: null });
      expect(row.finishedAt).toBeInstanceOf(Date);
    });

    it('refuses to finish a job with a lease token it does not hold', async () => {
      const [issueId = 0] = await seedIssues(1);
      await enqueueTriageJob(db(), issueId);
      const claimed = await claim();
      const forged = { jobId: claimed.jobId, leaseToken: '00000000-0000-4000-8000-000000000000' };

      expect(await completeJob(db(), forged)).toBe(false);
      expect((await job(claimed.jobId)).status).toBe('running');
    });

    it('cancels a job', async () => {
      const [issueId = 0] = await seedIssues(1);
      await enqueueTriageJob(db(), issueId);
      const claimed = await claim();

      expect(await cancelJob(db(), claimed, 'issue was closed')).toBe(true);
      expect(await job(claimed.jobId)).toMatchObject({
        status: 'cancelled',
        lastError: 'issue was closed',
      });
    });
  });

  describe('expired leases', () => {
    it('refuses to complete a job after its lease expired, even if nobody reclaimed it', async () => {
      const [issueId = 0] = await seedIssues(1);
      await enqueueTriageJob(db(), issueId);
      const claimed = await claim();
      await backdate(claimed.jobId, 'locked_until');

      expect(await completeJob(db(), claimed)).toBe(false);
    });

    it('lets another worker reclaim a job whose lease expired, and fences out the first', async () => {
      const [issueId = 0] = await seedIssues(1);
      await enqueueTriageJob(db(), issueId);
      const first = await claim();
      expect(await claimJob(db(), claimOptions)).toBeNull();

      await backdate(first.jobId, 'locked_until');
      const second = await claim();

      expect(second.jobId).toBe(first.jobId);
      expect(second.attempts).toBe(2);
      expect(second.leaseToken).not.toBe(first.leaseToken);
      // The first worker wakes up late: its result must not count.
      expect(await completeJob(db(), first)).toBe(false);
      expect(await completeJob(db(), second)).toBe(true);
    });
  });

  describe('retries', () => {
    it('reschedules a failed attempt with a delay and keeps the attempt count', async () => {
      const [issueId = 0] = await seedIssues(1);
      await enqueueTriageJob(db(), issueId);
      const claimed = await claim();

      const before = Date.now();
      await scheduleRetry(db(), claimed, { error: 'rate limited', delayMs: 30_000 });

      const row = await job(claimed.jobId);
      expect(row).toMatchObject({
        status: 'pending',
        attempts: 1,
        lastError: 'rate limited',
        leaseToken: null,
      });
      // The database clock sets run_after; allow for a little skew against this process.
      expect(row.runAfter.getTime()).toBeGreaterThan(before + 25_000);
      expect(row.runAfter.getTime()).toBeLessThan(before + 35_000);
      expect(await claimJob(db(), claimOptions)).toBeNull();

      await backdate(claimed.jobId, 'run_after');
      expect((await claim()).attempts).toBe(2);
    });

    it('keeps long error messages bounded', async () => {
      const [issueId = 0] = await seedIssues(1);
      await enqueueTriageJob(db(), issueId);
      const claimed = await claim();

      await failJob(db(), claimed, 'x'.repeat(10_000));

      const row = await job(claimed.jobId);
      expect(row.status).toBe('failed');
      expect(row.lastError?.length).toBeLessThan(2100);
    });

    it('caps the delay a provider can ask for', async () => {
      const [issueId = 0] = await seedIssues(1);
      await enqueueTriageJob(db(), issueId);
      const claimed = await claim();

      const before = Date.now();
      expect(
        await scheduleRetry(db(), claimed, {
          error: 'rate limited',
          delayMs: 90 * 86_400_000,
        }),
      ).toBe('requeued');

      const row = await job(claimed.jobId);
      expect(row.runAfter.getTime()).toBeLessThan(before + MAX_RETRY_DELAY_MS + 60_000);
    });

    it.each([
      [
        'retrying',
        (lease: ClaimedJob) => scheduleRetry(database.db, lease, { error: 'x', delayMs: 1 }),
      ],
      ['releasing', (lease: ClaimedJob) => releaseJob(database.db, lease)],
    ])(
      'cancels instead of %s a job when a newer job for the issue is already pending',
      async (_, requeue) => {
        const [issueId = 0] = await seedIssues(1);
        await enqueueTriageJob(db(), issueId);
        const running = await claim();
        // The issue is edited while the job runs.
        await enqueueTriageJob(db(), issueId);

        expect(await requeue(running)).toBe('superseded');

        const rows = await db().select().from(triageJobs).orderBy(triageJobs.id);
        expect(rows.map((row) => [row.status, row.lastError])).toEqual([
          ['cancelled', 'Superseded by a newer job for the same issue'],
          ['pending', null],
        ]);
      },
    );

    it('releases an interrupted job without counting the attempt', async () => {
      const [issueId = 0] = await seedIssues(1);
      await enqueueTriageJob(db(), issueId);
      const claimed = await claim();

      expect(await releaseJob(db(), claimed)).toBe('requeued');

      expect(await job(claimed.jobId)).toMatchObject({ status: 'pending', attempts: 0 });
      expect((await claim()).attempts).toBe(1);
    });
  });

  describe('cancelling jobs for an issue', () => {
    it('cancels pending and running jobs and leaves other issues alone', async () => {
      const [issueId = 0, otherIssueId = 0] = await seedIssues(2);
      await enqueueTriageJob(db(), issueId);
      const running = await claim();
      await enqueueTriageJob(db(), issueId);
      await enqueueTriageJob(db(), otherIssueId);

      expect(await cancelJobsForIssue(db(), issueId, 'issue deleted')).toBe(2);

      expect(await completeJob(db(), running)).toBe(false);
      const rows = await db().select().from(triageJobs).orderBy(triageJobs.id);
      expect(rows.map((row) => [row.issueId, row.status])).toEqual([
        [issueId, 'cancelled'],
        [issueId, 'cancelled'],
        [otherIssueId, 'pending'],
      ]);
    });
  });

  describe('write-back jobs', () => {
    async function reviewFor(issueId: number): Promise<number> {
      const suggestion = await seedSuggestion(db(), issueId);
      return (await seedReview(db(), suggestion.id)).id;
    }

    it('waits out the undo delay before it can be claimed', async () => {
      const [issueId = 0] = await seedIssues(1);
      const reviewId = await reviewFor(issueId);

      const { jobId, runAfter } = await enqueueWriteBackJob(db(), {
        issueId,
        reviewId,
        delayMs: 60_000,
      });

      expect(runAfter.getTime()).toBeGreaterThan(Date.now() + 50_000);
      expect(await claimJob(db(), claimOptions)).toBeNull();
      await backdate(jobId, 'run_after');
      expect(await claim()).toMatchObject({ jobId, kind: 'write_back', issueId, reviewId });
    });

    it('lives alongside a pending triage job for the same issue', async () => {
      const [issueId = 0] = await seedIssues(1);
      await enqueueTriageJob(db(), issueId);
      const reviewId = await reviewFor(issueId);
      await enqueueWriteBackJob(db(), { issueId, reviewId, delayMs: 0 });

      // Different kinds don't wait for each other.
      const first = await claim();
      const second = await claim();
      expect([first.kind, second.kind].sort()).toEqual(['triage', 'write_back']);
    });

    it('allows one write-back job per review', async () => {
      const [issueId = 0] = await seedIssues(1);
      const reviewId = await reviewFor(issueId);
      await enqueueWriteBackJob(db(), { issueId, reviewId, delayMs: 0 });

      await expect(enqueueWriteBackJob(db(), { issueId, reviewId, delayMs: 0 })).rejects.toThrow();
    });

    it('runs one write-back per issue at a time', async () => {
      const [issueId = 0] = await seedIssues(1);
      const firstReview = await reviewFor(issueId);
      const secondReview = await reviewFor(issueId);
      await enqueueWriteBackJob(db(), { issueId, reviewId: firstReview, delayMs: 0 });
      await enqueueWriteBackJob(db(), { issueId, reviewId: secondReview, delayMs: 0 });

      const running = await claim();
      expect(running.reviewId).toBe(firstReview);
      expect(await claimJob(db(), claimOptions)).toBeNull();
      await completeJob(db(), running, { added: [], removed: [], skipped: [], dryRun: false });
      expect((await claim()).reviewId).toBe(secondReview);
    });

    it('claims only the kinds a worker asks for', async () => {
      const [issueId = 0] = await seedIssues(1);
      const reviewId = await reviewFor(issueId);
      await enqueueWriteBackJob(db(), { issueId, reviewId, delayMs: 0 });

      expect(await claimJob(db(), { ...claimOptions, kinds: ['triage'] })).toBeNull();
      expect(await claimJob(db(), { ...claimOptions, kinds: ['write_back'] })).toMatchObject({
        kind: 'write_back',
      });
    });

    it('stores what a finished job changed', async () => {
      const [issueId = 0] = await seedIssues(1);
      const reviewId = await reviewFor(issueId);
      await enqueueWriteBackJob(db(), { issueId, reviewId, delayMs: 0 });
      const claimed = await claim();
      const result = { added: ['bug'], removed: [], skipped: ['gone'], dryRun: false };

      expect(await completeJob(db(), claimed, result)).toBe(true);
      expect(await job(claimed.jobId)).toMatchObject({ status: 'succeeded', result });
    });

    it('refuses a write-back job without a review', async () => {
      const [issueId = 0] = await seedIssues(1);
      await expect(
        db().insert(triageJobs).values({ issueId, kind: 'write_back' }),
      ).rejects.toThrow();
    });
  });
});

describe('retryDelayMs', () => {
  const policy = { baseMs: 1_000, maxMs: 60_000 };

  it('doubles the ceiling with each attempt', () => {
    const highest = (attempt: number) => retryDelayMs(attempt, policy, () => 1);
    expect([1, 2, 3, 4].map(highest)).toEqual([1_000, 2_000, 4_000, 8_000]);
  });

  it('waits at least half the ceiling', () => {
    expect(retryDelayMs(3, policy, () => 0)).toBe(2_000);
  });

  it('never exceeds the maximum', () => {
    expect(retryDelayMs(20, policy, () => 1)).toBe(60_000);
    expect(retryDelayMs(20, policy, () => 0)).toBe(30_000);
  });
});
