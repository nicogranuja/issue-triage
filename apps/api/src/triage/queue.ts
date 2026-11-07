import type { JobKind, WriteBackResult } from '@issue-triage/shared';
import { and, asc, eq, gt, inArray, lte, notExists, or, sql } from 'drizzle-orm';
import { alias, type PgUpdateSetSource } from 'drizzle-orm/pg-core';

import type { Database, Transaction } from '../db/client.js';
import { triageJobs } from '../db/schema.js';

/**
 * A Postgres-backed job queue. It carries two kinds of job: `triage` (ask the model for a
 * suggestion) and `write_back` (apply a review's labels to GitHub).
 *
 * Why Postgres and not a broker: jobs are created by the same transaction that stores the webhook
 * event, so an issue can never be saved without its job (or the other way round), and there is
 * one less piece of infrastructure to run. `FOR UPDATE SKIP LOCKED` lets any number of workers
 * poll the same table without blocking each other or claiming the same row. The trade-off is
 * throughput: polling a table is fine for webhook-rate work like this, not for thousands of jobs
 * per second.
 *
 * All timestamps come from the database clock (`now()`), so workers on hosts with skewed clocks
 * still agree on when a job is due and when a lease has expired.
 */

type Executor = Database | Transaction;

/** Proof that a worker holds a job. Every write that finishes a job must present it. */
export interface Lease {
  jobId: number;
  leaseToken: string;
}

export interface ClaimedJob extends Lease {
  kind: JobKind;
  issueId: number;
  /** The review to apply; set for write-back jobs. */
  reviewId: number | null;
  /** Claims so far, including this one. */
  attempts: number;
  lockedUntil: Date;
}

export interface ClaimOptions {
  /** Identifies the worker in `locked_by`, for operators. */
  workerId: string;
  /** How long the claim is valid. It must outlast the longest possible run of a job. */
  leaseMs: number;
  /** Kinds of job this worker runs. Defaults to all of them. */
  kinds?: readonly JobKind[];
}

/**
 * Adds a pending job for an issue. If the issue already has one, no second job is added: the
 * pending job has not started, so it will read the latest issue text anyway. It does get a fresh
 * attempt budget, since the text it will triage is new (it keeps any backoff it is waiting out).
 * A job that is already running does not count, so an edit made mid-run gets its own job.
 *
 * Returns whether a job was created. Call it in the transaction that changed the issue.
 */
export async function enqueueTriageJob(tx: Executor, issueId: number): Promise<boolean> {
  const inserted = await tx
    .insert(triageJobs)
    .values({ issueId, kind: 'triage' })
    .onConflictDoNothing({
      target: triageJobs.issueId,
      // Must match the predicate of triage_jobs_one_pending_per_issue_key.
      where: sql`${triageJobs.status} = 'pending' and ${triageJobs.kind} = 'triage'`,
    })
    .returning({ id: triageJobs.id });
  if (inserted.length > 0) {
    return true;
  }
  await tx
    .update(triageJobs)
    .set({ attempts: 0, updatedAt: sql`now()` })
    .where(
      and(
        eq(triageJobs.issueId, issueId),
        eq(triageJobs.status, 'pending'),
        eq(triageJobs.kind, 'triage'),
      ),
    );
  return false;
}

/**
 * Adds the job that writes a review back to GitHub. Call it in the transaction that records the
 * review: the two commit together, so a crash can never leave an accepted review without its
 * write-back (the transactional outbox pattern). The job waits `delayMs` before it is due, which
 * is the window in which the reviewer can still undo.
 */
export async function enqueueWriteBackJob(
  tx: Executor,
  { issueId, reviewId, delayMs }: { issueId: number; reviewId: number; delayMs: number },
): Promise<{ jobId: number; runAfter: Date }> {
  const [job] = await tx
    .insert(triageJobs)
    .values({
      kind: 'write_back',
      issueId,
      reviewId,
      runAfter: sql`now() + ${Math.max(0, Math.ceil(delayMs))}::integer * interval '1 millisecond'`,
    })
    .returning({ jobId: triageJobs.id, runAfter: triageJobs.runAfter });
  if (!job) {
    throw new Error(`Insert returned no write-back job for review ${reviewId}`);
  }
  return job;
}

/**
 * Claims the next due job, or returns null when there is none. A job is due when it is pending,
 * its `run_after` has passed, and no other job of the same kind for the same issue is running; or
 * when it is running but its lease expired. One triage job per issue at a time means an older
 * run, which read the issue before an edit, can never finish after the newer run and replace its
 * suggestion; one write-back per issue at a time keeps two reviews from interleaving their label
 * changes.
 *
 * This is one statement, equivalent to:
 *
 *   with next as (
 *     select id from triage_jobs
 *     where (status = 'pending' and run_after <= now() and not exists (
 *             select 1 from triage_jobs running
 *             where running.issue_id = triage_jobs.issue_id
 *               and running.status = 'running' and running.locked_until > now()))
 *        or (status = 'running' and locked_until <= now())
 *     order by run_after, id
 *     limit 1
 *     for update skip locked
 *   )
 *   update triage_jobs set status = 'running', attempts = attempts + 1,
 *     lease_token = gen_random_uuid(), locked_by = $1, locked_until = now() + $2
 *   from next where triage_jobs.id = next.id
 *   returning ...
 *
 * `skip locked` makes a concurrent claimer pass over a row another worker is claiming instead of
 * waiting for it, so N workers claim N different jobs.
 */
export async function claimJob(
  db: Executor,
  { workerId, leaseMs, kinds }: ClaimOptions,
): Promise<ClaimedJob | null> {
  const running = alias(triageJobs, 'running');
  const next = db.$with('next').as(
    db
      .select({ id: triageJobs.id })
      .from(triageJobs)
      .where(
        and(
          kinds ? inArray(triageJobs.kind, [...kinds]) : undefined,
          or(
            and(
              eq(triageJobs.status, 'pending'),
              lte(triageJobs.runAfter, sql`now()`),
              notExists(
                db
                  .select({ id: running.id })
                  .from(running)
                  .where(
                    and(
                      eq(running.issueId, triageJobs.issueId),
                      eq(running.kind, triageJobs.kind),
                      eq(running.status, 'running'),
                      gt(running.lockedUntil, sql`now()`),
                    ),
                  ),
              ),
            ),
            and(eq(triageJobs.status, 'running'), lte(triageJobs.lockedUntil, sql`now()`)),
          ),
        ),
      )
      .orderBy(asc(triageJobs.runAfter), asc(triageJobs.id))
      .limit(1)
      .for('update', { skipLocked: true }),
  );

  const [claimed] = await db
    .with(next)
    .update(triageJobs)
    .set({
      status: 'running',
      attempts: sql`${triageJobs.attempts} + 1`,
      leaseToken: sql`gen_random_uuid()`,
      lockedBy: workerId,
      lockedUntil: sql`now() + ${Math.ceil(leaseMs)}::integer * interval '1 millisecond'`,
      updatedAt: sql`now()`,
    })
    .from(next)
    .where(eq(triageJobs.id, next.id))
    .returning({
      jobId: triageJobs.id,
      kind: triageJobs.kind,
      issueId: triageJobs.issueId,
      reviewId: triageJobs.reviewId,
      attempts: triageJobs.attempts,
      leaseToken: triageJobs.leaseToken,
      lockedUntil: triageJobs.lockedUntil,
    });

  if (!claimed) {
    return null;
  }
  const { leaseToken, lockedUntil } = claimed;
  if (leaseToken === null || lockedUntil === null) {
    // Ruled out by the triage_jobs_running_has_lease check constraint.
    throw new Error(`Claimed triage job ${claimed.jobId} without a lease`);
  }
  return { ...claimed, leaseToken, lockedUntil };
}

type JobUpdate = PgUpdateSetSource<typeof triageJobs>;

/**
 * Applies an update only while the caller still holds the lease. Returns false when the lease
 * was lost: another worker reclaimed the job, or the job was cancelled. With `unexpired`, a lease
 * past its `locked_until` counts as lost too, even if nobody has reclaimed it yet.
 */
async function updateLeased(
  tx: Executor,
  lease: Lease,
  set: JobUpdate,
  { unexpired = false }: { unexpired?: boolean } = {},
): Promise<boolean> {
  const updated = await tx
    .update(triageJobs)
    .set({ ...set, updatedAt: sql`now()` })
    .where(
      and(
        eq(triageJobs.id, lease.jobId),
        eq(triageJobs.leaseToken, lease.leaseToken),
        eq(triageJobs.status, 'running'),
        unexpired ? gt(triageJobs.lockedUntil, sql`now()`) : undefined,
      ),
    )
    .returning({ id: triageJobs.id });
  return updated.length > 0;
}

const releaseLease = { leaseToken: null, lockedUntil: null } satisfies JobUpdate;

/** Longest error message kept on a job row. */
const MAX_ERROR_LENGTH = 2000;

function truncateError(message: string): string {
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)}…` : message;
}

/**
 * Marks a job done. Call it in the transaction that stores the job's result, and roll that
 * transaction back when this returns false, so a worker that lost its lease writes nothing.
 *
 * The lease must also be unexpired: once it expires, a newer job for the issue may start, and a
 * late result from this one must not land after it.
 */
export function completeJob(
  tx: Executor,
  lease: Lease,
  result: WriteBackResult | null = null,
): Promise<boolean> {
  return updateLeased(
    tx,
    lease,
    { ...releaseLease, status: 'succeeded', lastError: null, result, finishedAt: sql`now()` },
    { unexpired: true },
  );
}

/**
 * Saves what a running job has done so far, without finishing it, so that the record survives a
 * failure later in the run. Write-back jobs call it after each change they make on GitHub. Returns
 * false when the lease was lost to another worker (or the job was cancelled): the caller should
 * stop. An expired lease that nobody has reclaimed still counts, since what it records did happen.
 */
export function saveProgress(
  tx: Executor,
  lease: Lease,
  result: WriteBackResult,
): Promise<boolean> {
  return updateLeased(tx, lease, { result });
}

/** What happened when a job was put back in the queue. */
export type RequeueResult = 'requeued' | 'superseded' | 'lease_lost';

/** The partial unique index that allows one pending job per issue. */
const ONE_PENDING_JOB_PER_ISSUE = 'triage_jobs_one_pending_per_issue_key';

/** Postgres error 23505 on the given constraint, wherever it sits in the error's cause chain. */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    const { code, constraint: name } = current as { code?: unknown; constraint?: unknown };
    if (code === '23505' && name === constraint) {
      return true;
    }
  }
  return false;
}

/**
 * Sets a running job back to pending. If the issue changed while the job ran, a newer job may
 * already be pending for it, and the unique index refuses a second one. That newer job will read
 * the latest issue text, so this one is cancelled as superseded rather than run twice.
 *
 * Must not run inside a transaction: on Postgres the refused update would abort it.
 */
async function requeue(db: Database, lease: Lease, set: JobUpdate): Promise<RequeueResult> {
  try {
    return (await updateLeased(db, lease, { ...releaseLease, ...set, status: 'pending' }))
      ? 'requeued'
      : 'lease_lost';
  } catch (error) {
    if (!isUniqueViolation(error, ONE_PENDING_JOB_PER_ISSUE)) {
      throw error;
    }
    const reason = 'Superseded by a newer job for the same issue';
    return (await cancelJob(db, lease, reason)) ? 'superseded' : 'lease_lost';
  }
}

/** Longest delay a retry is scheduled for, whatever a provider asks. */
export const MAX_RETRY_DELAY_MS = 6 * 60 * 60 * 1000;

/** Puts a job back in the queue to run again after `delayMs` (capped at six hours). */
export function scheduleRetry(
  db: Database,
  lease: Lease,
  { error, delayMs }: { error: string; delayMs: number },
): Promise<RequeueResult> {
  const delay = Math.min(MAX_RETRY_DELAY_MS, Math.max(0, Math.ceil(delayMs)));
  return requeue(db, lease, {
    lastError: truncateError(error),
    runAfter: sql`now() + ${delay}::integer * interval '1 millisecond'`,
  });
}

/** Gives up on a job for good. */
export function failJob(tx: Executor, lease: Lease, error: string): Promise<boolean> {
  return updateLeased(tx, lease, {
    ...releaseLease,
    status: 'failed',
    lastError: truncateError(error),
    finishedAt: sql`now()`,
  });
}

/** Ends a job whose work is no longer needed, for example because the issue was closed. */
export function cancelJob(tx: Executor, lease: Lease, reason: string): Promise<boolean> {
  return updateLeased(tx, lease, {
    ...releaseLease,
    status: 'cancelled',
    lastError: truncateError(reason),
    finishedAt: sql`now()`,
  });
}

/**
 * Returns a job to the queue without counting the attempt, for a worker that is shutting down
 * and interrupted the job itself. The job is due again immediately.
 */
export function releaseJob(db: Database, lease: Lease): Promise<RequeueResult> {
  return requeue(db, lease, {
    attempts: sql`greatest(${triageJobs.attempts} - 1, 0)`,
    runAfter: sql`now()`,
  });
}

/**
 * Cancels the issue's pending and running jobs. A worker running one of them finds its lease gone
 * when it tries to save the result, and discards it. Returns how many jobs were cancelled.
 */
export async function cancelJobsForIssue(
  tx: Executor,
  issueId: number,
  reason: string,
): Promise<number> {
  const cancelled = await tx
    .update(triageJobs)
    .set({
      ...releaseLease,
      status: 'cancelled',
      lastError: truncateError(reason),
      finishedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(triageJobs.issueId, issueId), inArray(triageJobs.status, ['pending', 'running'])))
    .returning({ id: triageJobs.id });
  return cancelled.length;
}

export interface BackoffPolicy {
  /** Delay before the first retry. */
  baseMs: number;
  /** Upper bound on any single delay. */
  maxMs: number;
}

/**
 * Exponential backoff with jitter: the ceiling doubles with every attempt (up to `maxMs`), and the
 * actual delay is drawn from the upper half of it. Waiting at least half the ceiling keeps the
 * backoff meaningful; the random half spreads out jobs that failed together, for example during
 * a provider outage, so they don't all retry in the same instant.
 *
 * @param attempt the attempt that just failed, starting at 1
 */
export function retryDelayMs(
  attempt: number,
  { baseMs, maxMs }: BackoffPolicy,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}
