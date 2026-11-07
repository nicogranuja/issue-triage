import type { ReviewRequest, WriteBackAttempt } from '@issue-triage/shared';
import { eq, sql } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { WriteBackMode } from '../../src/config.js';
import type { DatabaseHandle } from '../../src/db/client.js';
import {
  issues,
  repositories,
  reviews,
  triageJobs,
  triageSuggestions,
} from '../../src/db/schema.js';
import { GitHubClient } from '../../src/github/client.js';
import { submitReview } from '../../src/review/service.js';
import { FakeTriageModel } from '../../src/triage/fake-model.js';
import { RepositoryLabelCache } from '../../src/triage/labels.js';
import { TriageWorker } from '../../src/triage/worker.js';
import { mergeAttempt, planWriteBack } from '../../src/triage/write-back.js';
import { createMigratedTestDatabase } from '../helpers/database.js';
import { FakeGitHub } from '../helpers/fake-github.js';
import { seedIssue, seedRepository, seedSuggestion } from '../helpers/seed.js';

const ISSUE = 42;
const ISSUE_PATH = `/repos/lumen-labs/lumen/issues/${ISSUE}`;

describe('planWriteBack', () => {
  it('adds only labels the repository defines, in its spelling, and not already present', () => {
    expect(
      planWriteBack({
        labelsAdded: ['Bug', 'area: export', 'deleted-label'],
        labelsRemoved: [],
        current: ['area: export'],
        repositoryLabels: ['bug', 'area: export'],
      }),
    ).toEqual({ add: ['bug'], remove: [], skipped: ['deleted-label'] });
  });

  it('removes only explicitly removed labels the issue still has', () => {
    expect(
      planWriteBack({
        labelsAdded: [],
        labelsRemoved: ['needs triage', 'already-gone'],
        current: ['Needs Triage', 'added-on-github-since'],
        repositoryLabels: ['needs triage', 'added-on-github-since'],
      }),
    ).toEqual({ add: [], remove: ['Needs Triage'], skipped: [] });
  });

  it('plans nothing when the change is already on GitHub', () => {
    expect(
      planWriteBack({
        labelsAdded: ['bug'],
        labelsRemoved: ['needs triage'],
        current: ['bug'],
        repositoryLabels: ['bug', 'needs triage'],
      }),
    ).toEqual({ add: [], remove: [], skipped: [] });
  });
});

describe('mergeAttempt', () => {
  const run = (attempt: number, changes: Partial<WriteBackAttempt> = {}): WriteBackAttempt => ({
    attempt,
    added: [],
    removed: [],
    skipped: [],
    ...changes,
  });

  it('keeps each run and totals what all of them did', () => {
    const first = mergeAttempt(null, run(1, { added: ['bug'] }), false);
    expect(mergeAttempt(first, run(2, { removed: ['needs triage'] }), false)).toEqual({
      added: ['bug'],
      removed: ['needs triage'],
      skipped: [],
      dryRun: false,
      attempts: [run(1, { added: ['bug'] }), run(2, { removed: ['needs triage'] })],
    });
  });

  it("replaces a run's earlier progress with its latest", () => {
    const partial = mergeAttempt(null, run(1, { added: ['bug'] }), false);
    const done = mergeAttempt(partial, run(1, { added: ['bug'], removed: ['wontfix'] }), false);
    expect(done.attempts).toEqual([run(1, { added: ['bug'], removed: ['wontfix'] })]);
  });

  it('drops a skipped label from the totals once a later run added it', () => {
    const first = mergeAttempt(null, run(1, { skipped: ['area: export'] }), false);
    const second = mergeAttempt(first, run(2, { added: ['area: export'] }), false);
    expect(second).toMatchObject({ added: ['area: export'], skipped: [] });
  });

  it('reads results stored before runs were recorded', () => {
    const legacy = { added: ['bug'], removed: [], skipped: [], dryRun: false };
    expect(mergeAttempt(legacy, run(2), false).attempts).toEqual([run(2)]);
  });
});

describe('write-back jobs', () => {
  let database: DatabaseHandle;
  const logger = pino({ level: 'silent' });

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

  /**
   * An issue labelled `needs triage` with a reviewed suggestion, its write-back job due now, and
   * a fake GitHub that agrees with the database about labels.
   */
  async function reviewed(
    request: ReviewRequest,
    { suggested = ['bug', 'area: export'], priorityLabels = {} } = {},
  ) {
    const labels = ['bug', 'area: export', 'needs triage', 'regression'];
    const repo = await seedRepository(db(), {
      labels: labels.map((name) => ({ name, description: null, color: 'ededed' })),
      labelsFetchedAt: new Date(),
    });
    const issue = await seedIssue(db(), repo.id, { number: ISSUE, labels: ['needs triage'] });
    const suggestion = await seedSuggestion(db(), issue.id, { labels: suggested });
    const review = await submitReview(db(), suggestion.id, request, {
      priorityLabels,
      writeBackDelayMs: 0,
    });
    const github = new FakeGitHub({ labels, issues: { [ISSUE]: ['needs triage'] } });
    return { issue, review, github };
  }

  function workerFor(github: FakeGitHub, mode: WriteBackMode = 'github') {
    const client = new GitHubClient({ token: 'ghp_test', fetch: github.fetch });
    const labels = new RepositoryLabelCache(db(), client);
    return new TriageWorker({
      db: db(),
      model: new FakeTriageModel(),
      labels,
      logger,
      concurrency: 1,
      maxAttempts: 3,
      jobTimeoutMs: 5_000,
      random: () => 0,
      writeBack: { github: client, labels, mode },
    });
  }

  async function writeBackJob() {
    const [job] = await db().select().from(triageJobs).where(eq(triageJobs.kind, 'write_back'));
    if (!job) {
      throw new Error('No write-back job');
    }
    return job;
  }

  it('adds the accepted labels and records what it did', async () => {
    const { github } = await reviewed({ decision: 'accept' });

    expect(await workerFor(github).runNext()).toBe(true);

    expect(github.issueLabels.get(ISSUE)).toEqual(['needs triage', 'bug', 'area: export']);
    expect(github.writes).toEqual([
      { method: 'POST', path: `${ISSUE_PATH}/labels`, body: { labels: ['bug', 'area: export'] } },
    ]);
    expect(await writeBackJob()).toMatchObject({
      status: 'succeeded',
      attempts: 1,
      lastError: null,
      result: { added: ['bug', 'area: export'], removed: [], skipped: [], dryRun: false },
    });
  });

  it('re-reads the label set and skips labels deleted since the review, rather than recreating them', async () => {
    const { github } = await reviewed({ decision: 'accept' });
    // Deleted on GitHub after triage; the cached label set on the repository row still has it.
    github.repositoryLabels.delete('area: export');

    await workerFor(github).runNext();

    expect(github.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /repos/lumen-labs/lumen/labels',
      `GET ${ISSUE_PATH}`,
      `POST ${ISSUE_PATH}/labels`,
    ]);
    expect(github.writes[0]?.body).toEqual({ labels: ['bug'] });
    expect(github.repositoryLabels.has('area: export')).toBe(false);
    expect((await writeBackJob()).result).toMatchObject({
      added: ['bug'],
      skipped: ['area: export'],
    });
    // The cache was refreshed with what GitHub said.
    const [repo] = await db().select({ labels: repositories.labels }).from(repositories);
    expect(repo?.labels?.map((label) => label.name)).not.toContain('area: export');
  });

  it('removes only labels the reviewer removed, and leaves labels added on GitHub since', async () => {
    const { github } = await reviewed({
      decision: 'edit',
      labels: ['bug'],
      baseLabels: ['needs triage'],
    });
    github.issueLabels.set(ISSUE, ['needs triage', 'added-meanwhile']);
    github.repositoryLabels.add('added-meanwhile');

    await workerFor(github).runNext();

    expect(github.issueLabels.get(ISSUE)).toEqual(['added-meanwhile', 'bug']);
    expect((await writeBackJob()).result).toEqual({
      added: ['bug'],
      removed: ['needs triage'],
      skipped: [],
      dryRun: false,
      attempts: [{ attempt: 1, added: ['bug'], removed: ['needs triage'], skipped: [] }],
    });
  });

  it('writes the priority label when one is mapped', async () => {
    const { github } = await reviewed(
      {
        decision: 'edit',
        labels: ['needs triage'],
        baseLabels: ['needs triage'],
        priority: 'high',
      },
      { priorityLabels: { high: 'regression' } },
    );

    await workerFor(github).runNext();
    expect(github.issueLabels.get(ISSUE)).toEqual(['needs triage', 'regression']);
  });

  it('is idempotent: a run whose result was lost changes nothing when it runs again', async () => {
    const { github } = await reviewed({
      decision: 'edit',
      labels: ['bug'],
      baseLabels: ['needs triage'],
    });
    // The first run's lease expires while its GitHub calls are in flight, as if the worker hung;
    // the calls land, but it may no longer record the result.
    github.beforeAnswer = async (call) => {
      if (call.method === 'DELETE') {
        await db().execute(
          sql`update triage_jobs set locked_until = now() - interval '1 second' where kind = 'write_back'`,
        );
      }
    };
    const worker = workerFor(github);
    await worker.runNext();
    // It could not finish the job, but what it did is on record.
    expect(await writeBackJob()).toMatchObject({
      status: 'running',
      result: { added: ['bug'], removed: ['needs triage'] },
    });
    expect(github.issueLabels.get(ISSUE)).toEqual(['bug']);
    const writesAfterFirstRun = github.writes.length;
    github.beforeAnswer = undefined;

    // The expired job is claimed again and finds the change already on GitHub.
    expect(await worker.runNext()).toBe(true);

    expect(github.writes).toHaveLength(writesAfterFirstRun);
    expect(github.issueLabels.get(ISSUE)).toEqual(['bug']);
    expect(await writeBackJob()).toMatchObject({
      status: 'succeeded',
      attempts: 2,
      result: {
        added: ['bug'],
        removed: ['needs triage'],
        attempts: [
          { attempt: 1, added: ['bug'], removed: ['needs triage'] },
          { attempt: 2, added: [], removed: [] },
        ],
      },
    });
  });

  it('keeps what a failed run changed, and merges it with the retry', async () => {
    const { github } = await reviewed({
      decision: 'edit',
      labels: ['bug'],
      baseLabels: ['needs triage'],
    });
    // The labels are added, then removing one hits an outage.
    github.failNext('DELETE', /labels\/needs%20triage$/, {
      status: 503,
      body: { message: 'Service Unavailable' },
    });
    const worker = workerFor(github);

    await worker.runNext();
    expect(await writeBackJob()).toMatchObject({
      status: 'pending',
      result: { added: ['bug'], removed: [], attempts: [{ attempt: 1, added: ['bug'] }] },
    });

    await db().execute(sql`update triage_jobs set run_after = now() where kind = 'write_back'`);
    await worker.runNext();

    expect(github.issueLabels.get(ISSUE)).toEqual(['bug']);
    expect(await writeBackJob()).toMatchObject({
      status: 'succeeded',
      attempts: 2,
      result: {
        added: ['bug'],
        removed: ['needs triage'],
        attempts: [
          { attempt: 1, added: ['bug'], removed: [] },
          { attempt: 2, added: [], removed: ['needs triage'] },
        ],
      },
    });
  });

  it('treats a label removed by someone else mid-run as removed', async () => {
    const { github } = await reviewed({
      decision: 'edit',
      labels: ['bug'],
      baseLabels: ['needs triage'],
    });
    github.failNext('DELETE', /labels\/needs%20triage$/, {
      status: 404,
      body: { message: 'Label does not exist' },
    });

    await workerFor(github).runNext();
    expect(await writeBackJob()).toMatchObject({
      status: 'succeeded',
      result: { added: ['bug'], removed: [] },
    });
  });

  it.each([
    [
      'a token without write access (403)',
      'POST',
      /\/labels$/,
      403,
      { message: 'Resource not accessible by personal access token' },
      /403: forbidden; GITHUB_TOKEN needs Issues write access .*Resource not accessible/,
    ],
    [
      'a missing issue (404)',
      'GET',
      /\/issues\/42$/,
      404,
      { message: 'Not Found' },
      /GET \/repos\/lumen-labs\/lumen\/issues\/42 returned 404: not found, or the token cannot see it/,
    ],
    [
      'a change GitHub rejects (422)',
      'POST',
      /\/labels$/,
      422,
      { message: 'Validation Failed', errors: [{ code: 'invalid' }] },
      /422: GitHub rejected the change \(GitHub: Validation Failed: invalid\)/,
    ],
  ])(
    'fails at once, with a clear error, on %s',
    async (_case, method, path, status, body, error) => {
      const { github } = await reviewed({ decision: 'accept' });
      github.failNext(method, path, { status, body });

      await workerFor(github).runNext();

      const job = await writeBackJob();
      expect(job).toMatchObject({ status: 'failed', attempts: 1 });
      expect(job.lastError).toMatch(error);
      expect(job.finishedAt).not.toBeNull();
    },
  );

  it('retries outages with backoff, then succeeds', async () => {
    const { github } = await reviewed({ decision: 'accept' });
    github.failNext('POST', /\/labels$/, { status: 502, body: { message: 'Bad Gateway' } });
    const worker = workerFor(github);

    await worker.runNext();
    const waiting = await writeBackJob();
    expect(waiting).toMatchObject({ status: 'pending', attempts: 1 });
    expect(waiting.lastError).toMatch(/returned 502/);
    expect(waiting.runAfter.getTime()).toBeGreaterThan(Date.now() + 10_000);

    await db().execute(sql`update triage_jobs set run_after = now() where kind = 'write_back'`);
    await worker.runNext();
    expect(await writeBackJob()).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(github.issueLabels.get(ISSUE)).toEqual(['needs triage', 'bug', 'area: export']);
  });

  it('calls nothing in dry-run mode, and records the change it would make', async () => {
    const { github } = await reviewed({
      decision: 'edit',
      labels: ['bug'],
      baseLabels: ['needs triage'],
    });

    await workerFor(github, 'dry-run').runNext();

    expect(github.calls).toEqual([]);
    expect(await writeBackJob()).toMatchObject({
      status: 'succeeded',
      result: { added: ['bug'], removed: ['needs triage'], skipped: [], dryRun: true },
    });
  });

  it('cancels the write-back of an issue removed from GitHub', async () => {
    const { github, issue } = await reviewed({ decision: 'accept' });
    await db()
      .update(issues)
      .set({ removedAt: new Date(), removalReason: 'deleted' })
      .where(eq(issues.id, issue.id));

    await workerFor(github).runNext();

    expect(github.calls).toEqual([]);
    expect(await writeBackJob()).toMatchObject({
      status: 'cancelled',
      lastError: 'Issue was removed from GitHub',
    });
  });

  it('does not run write-backs in a worker set up for triage only', async () => {
    await reviewed({ decision: 'accept' });
    const worker = new TriageWorker({
      db: db(),
      model: new FakeTriageModel(),
      labels: { labelsFor: () => Promise.resolve([]) },
      logger,
      concurrency: 1,
      maxAttempts: 3,
      jobTimeoutMs: 5_000,
    });

    expect(await worker.runNext()).toBe(false);
    expect((await writeBackJob()).status).toBe('pending');
  });
});
