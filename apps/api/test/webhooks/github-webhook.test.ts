import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { DatabaseHandle } from '../../src/db/client.js';
import { issues, repositories, triageJobs, webhookDeliveries } from '../../src/db/schema.js';
import { claimTriageJob, completeTriageJob } from '../../src/triage/queue.js';
import { signPayload } from '../../src/webhooks/signature.js';
import { createTestApp, deliver, TEST_WEBHOOK_SECRET } from '../helpers/app.js';
import { createMigratedTestDatabase } from '../helpers/database.js';
import { issuesPayload, payload } from '../helpers/fixtures.js';

const ISSUE_GITHUB_ID = 2849301122;

describe('POST /webhooks/github', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    app = await createTestApp(database);
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  beforeEach(async () => {
    await database.db.execute(
      sql`truncate ${webhookDeliveries}, ${triageJobs}, ${issues}, ${repositories} restart identity cascade`,
    );
  });

  const storedIssue = async () => {
    const rows = await database.db
      .select()
      .from(issues)
      .where(eq(issues.githubId, ISSUE_GITHUB_ID));
    const [row] = rows;
    if (rows.length !== 1 || !row) {
      throw new Error(`Expected exactly one stored issue, found ${rows.length}`);
    }
    return row;
  };
  const deliveryCount = async () => (await database.db.select().from(webhookDeliveries)).length;

  describe('signature verification', () => {
    it('rejects a delivery without a signature', async () => {
      const response = await deliver(app, {
        event: 'issues',
        payload: issuesPayload('issues.opened'),
        signature: null,
      });

      expect(response.statusCode).toBe(401);
      expect(await deliveryCount()).toBe(0);
    });

    it('rejects a delivery signed with the wrong secret', async () => {
      const response = await deliver(app, {
        event: 'issues',
        payload: issuesPayload('issues.opened'),
        secret: 'some-other-webhook-secret',
      });

      expect(response.statusCode).toBe(401);
      expect(await deliveryCount()).toBe(0);
    });

    it('rejects a body that does not match its signature', async () => {
      const signed = issuesPayload('issues.opened');
      const tampered = issuesPayload('issues.opened');
      tampered.issue.title = 'Something else entirely';
      const signature = signPayload(TEST_WEBHOOK_SECRET, JSON.stringify(signed));

      const response = await deliver(app, { event: 'issues', payload: tampered, signature });

      expect(response.statusCode).toBe(401);
      expect(await database.db.select().from(issues)).toEqual([]);
    });

    it('rejects a malformed signature header', async () => {
      const response = await deliver(app, {
        event: 'issues',
        payload: issuesPayload('issues.opened'),
        signature: 'sha256=not-a-digest',
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('issue events', () => {
    it('stores the repository and issue when an issue is opened', async () => {
      const response = await deliver(app, {
        event: 'issues',
        payload: issuesPayload('issues.opened'),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'processed' });

      const [repository] = await database.db.select().from(repositories);
      expect(repository).toMatchObject({
        githubId: 708812345,
        owner: 'lumen-labs',
        name: 'lumen',
        fullName: 'lumen-labs/lumen',
        private: false,
      });
      expect(await storedIssue()).toMatchObject({
        repositoryId: repository?.id,
        number: 42,
        title: 'Export fails for dashboards with an empty panel',
        state: 'open',
        stateReason: null,
        labels: [],
        authorLogin: 'ada-dev',
        htmlUrl: 'https://github.com/lumen-labs/lumen/issues/42',
        githubCreatedAt: new Date('2026-10-30T16:04:11Z'),
        githubUpdatedAt: new Date('2026-10-30T16:04:11Z'),
        closedAt: null,
      });
    });

    it('updates the same issue row when the issue is edited', async () => {
      await deliver(app, { event: 'issues', payload: issuesPayload('issues.opened') });
      const opened = await storedIssue();

      const response = await deliver(app, {
        event: 'issues',
        payload: issuesPayload('issues.edited'),
      });

      expect(response.json()).toEqual({ status: 'processed' });
      const edited = await storedIssue();
      expect(edited.id).toBe(opened.id);
      expect(edited.title).toBe('PDF export fails for dashboards with an empty panel');
      expect(edited.githubUpdatedAt).toEqual(new Date('2026-10-30T16:09:47Z'));
      expect(edited.createdAt).toEqual(opened.createdAt);
      expect(await database.db.select().from(repositories)).toHaveLength(1);
    });

    it('mirrors labels and state from later events', async () => {
      await deliver(app, { event: 'issues', payload: issuesPayload('issues.opened') });

      await deliver(app, { event: 'issues', payload: issuesPayload('issues.labeled') });
      expect((await storedIssue()).labels).toEqual(['bug', 'area: export']);

      await deliver(app, { event: 'issues', payload: issuesPayload('issues.closed') });
      expect(await storedIssue()).toMatchObject({
        state: 'closed',
        stateReason: 'completed',
        closedAt: new Date('2026-10-31T09:02:58Z'),
        labels: ['bug', 'area: export'],
      });
    });

    it('creates the issue from a later event if the opened event never arrived', async () => {
      const response = await deliver(app, {
        event: 'issues',
        payload: issuesPayload('issues.labeled'),
      });

      expect(response.json()).toEqual({ status: 'processed' });
      expect((await storedIssue()).labels).toEqual(['bug', 'area: export']);
    });

    it('does not let an older event overwrite newer data', async () => {
      await deliver(app, { event: 'issues', payload: issuesPayload('issues.edited') });

      // The opened event arrives late, for example after a manual redelivery.
      const response = await deliver(app, {
        event: 'issues',
        payload: issuesPayload('issues.opened'),
      });

      expect(response.json()).toEqual({ status: 'processed' });
      expect((await storedIssue()).title).toBe(
        'PDF export fails for dashboards with an empty panel',
      );
    });
  });

  describe('triage jobs', () => {
    const jobs = () =>
      database.db
        .select({ status: triageJobs.status, lastError: triageJobs.lastError })
        .from(triageJobs)
        .orderBy(triageJobs.id);

    /** Runs the pending job to completion, as a worker would. */
    async function finishPendingJob() {
      const claimed = await claimTriageJob(database.db, { workerId: 'test', leaseMs: 60_000 });
      if (!claimed) {
        throw new Error('Expected a pending triage job');
      }
      await completeTriageJob(database.db, claimed);
    }

    it('queues triage when an issue is opened, in the same transaction', async () => {
      const response = await deliver(app, {
        event: 'issues',
        payload: issuesPayload('issues.opened'),
      });

      expect(response.json()).toEqual({ status: 'processed' });
      const stored = await storedIssue();
      expect(await database.db.select().from(triageJobs)).toMatchObject([
        { issueId: stored.id, status: 'pending', attempts: 0 },
      ]);
    });

    it('does not queue a second job while one is still pending', async () => {
      await deliver(app, { event: 'issues', payload: issuesPayload('issues.opened') });
      await deliver(app, { event: 'issues', payload: issuesPayload('issues.edited') });

      expect(await jobs()).toEqual([{ status: 'pending', lastError: null }]);
    });

    it('queues new triage when a triaged issue is edited or reopened', async () => {
      await deliver(app, { event: 'issues', payload: issuesPayload('issues.opened') });
      await finishPendingJob();
      await deliver(app, { event: 'issues', payload: issuesPayload('issues.edited') });
      await finishPendingJob();
      await deliver(app, { event: 'issues', payload: issuesPayload('issues.closed') });

      const reopened = issuesPayload('issues.closed');
      reopened.action = 'reopened';
      Object.assign(reopened.issue, {
        state: 'open',
        state_reason: 'reopened',
        closed_at: null,
        updated_at: '2026-11-02T08:15:00Z',
      });
      await deliver(app, { event: 'issues', payload: reopened });

      expect((await jobs()).map((job) => job.status)).toEqual([
        'succeeded',
        'succeeded',
        'pending',
      ]);
    });

    it('does not queue triage for label or state changes', async () => {
      await deliver(app, { event: 'issues', payload: issuesPayload('issues.labeled') });
      await deliver(app, { event: 'issues', payload: issuesPayload('issues.closed') });

      expect(await jobs()).toEqual([]);
    });

    it('does not queue triage for an edit to a closed issue', async () => {
      await deliver(app, { event: 'issues', payload: issuesPayload('issues.closed') });
      const edited = issuesPayload('issues.closed');
      edited.action = 'edited';
      edited.issue.title = 'Renamed after closing';
      edited.issue.updated_at = '2026-11-01T10:00:00Z';

      await deliver(app, { event: 'issues', payload: edited });

      expect((await storedIssue()).title).toBe('Renamed after closing');
      expect(await jobs()).toEqual([]);
    });

    it('does not queue triage for a stale event', async () => {
      await deliver(app, { event: 'issues', payload: issuesPayload('issues.edited') });
      await finishPendingJob();

      await deliver(app, { event: 'issues', payload: issuesPayload('issues.opened') });

      expect((await jobs()).map((job) => job.status)).toEqual(['succeeded']);
    });

    it('rolls back the job when the webhook transaction fails', async () => {
      const overflowing = issuesPayload('issues.opened');
      overflowing.issue.number = 2 ** 31;

      const response = await deliver(app, { event: 'issues', payload: overflowing });

      expect(response.statusCode).toBe(500);
      expect(await jobs()).toEqual([]);
    });
  });

  describe('deleted and transferred issues', () => {
    const jobStatuses = async () =>
      (await database.db.select().from(triageJobs).orderBy(triageJobs.id)).map((job) => job.status);

    it.each([
      ['issues.deleted', 'deleted'],
      ['issues.transferred', 'transferred'],
    ] as const)('marks the issue removed and cancels triage on %s', async (fixture, reason) => {
      await deliver(app, { event: 'issues', payload: issuesPayload('issues.opened') });

      const response = await deliver(app, { event: 'issues', payload: issuesPayload(fixture) });

      expect(response.json()).toEqual({ status: 'processed' });
      const stored = await storedIssue();
      expect(stored.removalReason).toBe(reason);
      expect(stored.removedAt).toBeInstanceOf(Date);
      const [job] = await database.db.select().from(triageJobs);
      expect(job).toMatchObject({
        status: 'cancelled',
        lastError: `Issue was ${reason} on GitHub`,
      });
    });

    it('cancels a job that a worker is already running', async () => {
      await deliver(app, { event: 'issues', payload: issuesPayload('issues.opened') });
      const running = await claimTriageJob(database.db, { workerId: 'test', leaseMs: 60_000 });
      if (!running) {
        throw new Error('Expected a pending triage job');
      }

      await deliver(app, { event: 'issues', payload: issuesPayload('issues.deleted') });

      // The worker's result is discarded when it tries to save it.
      expect(await completeTriageJob(database.db, running)).toBe(false);
      expect(await jobStatuses()).toEqual(['cancelled']);
    });

    it('keeps the issue removed and untriaged when later events arrive', async () => {
      await deliver(app, { event: 'issues', payload: issuesPayload('issues.opened') });
      await deliver(app, { event: 'issues', payload: issuesPayload('issues.deleted') });

      // A newer edit (out-of-order delivery) and a redelivered older event.
      const edited = issuesPayload('issues.edited');
      edited.issue.updated_at = '2026-11-01T09:00:00Z';
      await deliver(app, { event: 'issues', payload: edited });
      await deliver(app, { event: 'issues', payload: issuesPayload('issues.opened') });

      expect((await storedIssue()).removalReason).toBe('deleted');
      expect(await jobStatuses()).toEqual(['cancelled']);
    });

    it('records the removal of an issue it never saw, so it cannot be resurrected later', async () => {
      await deliver(app, { event: 'issues', payload: issuesPayload('issues.deleted') });
      await deliver(app, { event: 'issues', payload: issuesPayload('issues.opened') });

      expect((await storedIssue()).removalReason).toBe('deleted');
      expect(await jobStatuses()).toEqual([]);
    });
  });

  describe('redelivery', () => {
    it('acknowledges a repeated delivery id without processing it again', async () => {
      const deliveryId = '6f1c8e2a-41b7-11f0-9a3b-2c4d5e6f7a8b';
      await deliver(app, { event: 'issues', payload: issuesPayload('issues.opened'), deliveryId });

      // Same delivery id, different content: proves the second request is not applied.
      const redelivered = issuesPayload('issues.opened');
      redelivered.issue.title = 'Changed between deliveries';
      redelivered.issue.updated_at = '2026-10-30T18:00:00Z';
      const response = await deliver(app, { event: 'issues', payload: redelivered, deliveryId });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'duplicate' });
      expect((await storedIssue()).title).toBe('Export fails for dashboards with an empty panel');
      expect(await deliveryCount()).toBe(1);
    });

    it('does not record the delivery when applying the event fails', async () => {
      const deliveryId = '9c4fb05d-41b7-11f0-9a3b-2c4d5e6f7a8b';
      // Passes validation but overflows the integer column: a stand-in for any database error.
      const overflowing = issuesPayload('issues.opened');
      overflowing.issue.number = 2 ** 31;

      const failed = await deliver(app, { event: 'issues', payload: overflowing, deliveryId });
      expect(failed.statusCode).toBe(500);
      expect(failed.json()).toEqual({ error: 'Internal Server Error' });
      expect(await deliveryCount()).toBe(0);
      expect(await database.db.select().from(repositories)).toEqual([]);

      // GitHub's redelivery of the same id is then processed normally.
      const retried = await deliver(app, {
        event: 'issues',
        payload: issuesPayload('issues.opened'),
        deliveryId,
      });
      expect(retried.json()).toEqual({ status: 'processed' });
    });

    it('records each delivery with its event, action, and outcome', async () => {
      const deliveryId = '7a2d9f3b-41b7-11f0-9a3b-2c4d5e6f7a8b';
      await deliver(app, { event: 'issues', payload: issuesPayload('issues.closed'), deliveryId });

      const [delivery] = await database.db.select().from(webhookDeliveries);
      expect(delivery).toMatchObject({
        deliveryId,
        event: 'issues',
        action: 'closed',
        outcome: 'processed',
      });
    });
  });

  describe('events that are not handled', () => {
    it('acknowledges ping', async () => {
      const response = await deliver(app, { event: 'ping', payload: payload('ping') });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ignored' });
    });

    it('acknowledges other event types without storing issues', async () => {
      const response = await deliver(app, {
        event: 'issue_comment',
        payload: payload('issue_comment.created'),
      });

      expect(response.json()).toEqual({ status: 'ignored' });
      expect(await database.db.select().from(issues)).toEqual([]);
      const [delivery] = await database.db.select().from(webhookDeliveries);
      expect(delivery).toMatchObject({
        event: 'issue_comment',
        action: 'created',
        outcome: 'ignored',
      });
    });

    it('acknowledges issue actions that do not change mirrored data', async () => {
      const assigned = issuesPayload('issues.opened');
      assigned.action = 'assigned';

      const response = await deliver(app, { event: 'issues', payload: assigned });

      expect(response.json()).toEqual({ status: 'ignored' });
      expect(await database.db.select().from(issues)).toEqual([]);
    });
  });

  describe('malformed deliveries', () => {
    it('rejects an issues payload missing required fields and lets it be redelivered', async () => {
      const deliveryId = '8b3eaf4c-41b7-11f0-9a3b-2c4d5e6f7a8b';
      const broken = issuesPayload('issues.opened');
      delete broken.repository;

      const rejected = await deliver(app, { event: 'issues', payload: broken, deliveryId });
      expect(rejected.statusCode).toBe(400);
      expect(await deliveryCount()).toBe(0);

      const retried = await deliver(app, {
        event: 'issues',
        payload: issuesPayload('issues.opened'),
        deliveryId,
      });
      expect(retried.json()).toEqual({ status: 'processed' });
    });

    it('rejects a signed body that is not JSON', async () => {
      const response = await deliver(app, {
        event: 'issues',
        payload: null,
        rawBody: '{"action":',
      });

      expect(response.statusCode).toBe(400);
    });

    it('rejects a delivery without a delivery id', async () => {
      const response = await deliver(app, {
        event: 'ping',
        payload: payload('ping'),
        headers: { 'x-github-delivery': '' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('rejects form-encoded deliveries', async () => {
      const response = await deliver(app, {
        event: 'ping',
        payload: null,
        rawBody: 'payload=%7B%7D',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });

      expect(response.statusCode).toBe(415);
    });
  });
});
