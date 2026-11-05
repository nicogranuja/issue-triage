import { and, asc, eq, inArray, lte, or, sql } from 'drizzle-orm';

import type { Database, Transaction } from '../db/client.js';
import { triageJobs } from '../db/schema.js';

/**
 * A Postgres-backed job queue for triage work.
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
  issueId: number;
  /** Claims so far, including this one. */
  attempts: number;
  lockedUntil: Date;
}

export interface ClaimOptions {
  /** Identifies the worker in `locked_by`, for operators. */
  workerId: string;
  /** How long the claim is valid. It must outlast the longest possible run of a job. */
  leaseMs: number;
}

/**
 * Adds a pending job for an issue. A no-op if the issue already has a pending job: that job has
 * not started yet, so it will see the latest issue text anyway. A job that is already running
 * does not count, so an edit made mid-run still gets its own, later job.
 *
 * Returns whether a job was created. Call it in the transaction that changed the issue.
 */
export async function enqueueTriageJob(tx: Executor, issueId: number): Promise<boolean> {
  const inserted = await tx
    .insert(triageJobs)
    .values({ issueId })
    .onConflictDoNothing({
      target: triageJobs.issueId,
      where: sql`${triageJobs.status} = 'pending'`,
    })
    .returning({ id: triageJobs.id });
  return inserted.length > 0;
}

/**
 * Claims the next due job, or returns null when there is none. A job is due when it is pending
 * and its `run_after` has passed, or when it is running but its lease expired.
 *
 * This is one statement, equivalent to:
 *
 *   with next as (
 *     select id from triage_jobs
 *     where (status = 'pending' and run_after <= now())
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
export async function claimTriageJob(
  db: Executor,
  { workerId, leaseMs }: ClaimOptions,
): Promise<ClaimedJob | null> {
  const next = db.$with('next').as(
    db
      .select({ id: triageJobs.id })
      .from(triageJobs)
      .where(
        or(
          and(eq(triageJobs.status, 'pending'), lte(triageJobs.runAfter, sql`now()`)),
          and(eq(triageJobs.status, 'running'), lte(triageJobs.lockedUntil, sql`now()`)),
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
      issueId: triageJobs.issueId,
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

type JobUpdate = Partial<typeof triageJobs.$inferInsert>;

/**
 * Applies an update only while the caller still holds the lease. Returns false when the lease
 * was lost: it expired and another worker reclaimed the job, or the job was cancelled.
 */
async function updateLeased(tx: Executor, lease: Lease, set: JobUpdate): Promise<boolean> {
  const updated = await tx
    .update(triageJobs)
    .set({ ...set, updatedAt: sql`now()` })
    .where(
      and(
        eq(triageJobs.id, lease.jobId),
        eq(triageJobs.leaseToken, lease.leaseToken),
        eq(triageJobs.status, 'running'),
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
 */
export function completeTriageJob(tx: Executor, lease: Lease): Promise<boolean> {
  return updateLeased(tx, lease, {
    ...releaseLease,
    status: 'succeeded',
    lastError: null,
    finishedAt: sql`now()`,
  });
}

/** Puts a job back in the queue to run again after `delayMs`. */
export function scheduleTriageRetry(
  tx: Executor,
  lease: Lease,
  { error, delayMs }: { error: string; delayMs: number },
): Promise<boolean> {
  return updateLeased(tx, lease, {
    ...releaseLease,
    status: 'pending',
    lastError: truncateError(error),
    runAfter: sql`now() + ${Math.ceil(delayMs)}::integer * interval '1 millisecond'`,
  });
}

/** Gives up on a job for good. */
export function failTriageJob(tx: Executor, lease: Lease, error: string): Promise<boolean> {
  return updateLeased(tx, lease, {
    ...releaseLease,
    status: 'failed',
    lastError: truncateError(error),
    finishedAt: sql`now()`,
  });
}

/** Ends a job whose work is no longer needed, for example because the issue was closed. */
export function cancelTriageJob(tx: Executor, lease: Lease, reason: string): Promise<boolean> {
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
export function releaseTriageJob(tx: Executor, lease: Lease): Promise<boolean> {
  return updateLeased(tx, lease, {
    ...releaseLease,
    status: 'pending',
    attempts: sql`greatest(${triageJobs.attempts} - 1, 0)`,
    runAfter: sql`now()`,
  });
}

/**
 * Cancels the issue's pending and running jobs. A worker running one of them finds its lease gone
 * when it tries to save the result, and discards it. Returns how many jobs were cancelled.
 */
export async function cancelTriageJobsForIssue(
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
