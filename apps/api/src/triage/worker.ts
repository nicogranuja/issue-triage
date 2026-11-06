import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

import { DrizzleQueryError } from 'drizzle-orm';
import type { Logger } from 'pino';

import type { Database } from '../db/client.js';
import { GitHubApiError } from '../github/client.js';
import type { DuplicateSearchOptions } from './duplicates.js';
import type { LabelSource } from './labels.js';
import { TriageModelError, type TriageModel } from './model.js';
import {
  claimJob,
  failJob,
  releaseJob,
  retryDelayMs,
  scheduleRetry,
  type BackoffPolicy,
  type ClaimedJob,
} from './queue.js';
import { runTriageJob } from './runner.js';
import { runWriteBackJob, type WriteBackDependencies } from './write-back.js';

export interface TriageWorkerOptions {
  db: Database;
  model: TriageModel;
  labels: LabelSource;
  logger: Logger;
  /** Jobs run at the same time by this worker. */
  concurrency: number;
  /** Claims per job before it fails for good, counting runs whose lease expired. */
  maxAttempts: number;
  /** Hard deadline for one run of a job, model calls included. */
  jobTimeoutMs: number;
  /** How long a claim lasts. Must outlast `jobTimeoutMs`; defaults to it plus a minute. */
  leaseMs?: number;
  /** Wait between polls when the queue is empty. Jittered by up to 50%. */
  pollIntervalMs?: number;
  backoff?: BackoffPolicy;
  duplicates?: DuplicateSearchOptions;
  /** Runs write-back jobs too when set. Without it, the worker only claims triage jobs. */
  writeBack?: Omit<WriteBackDependencies, 'db'>;
  workerId?: string;
  random?: () => number;
}

const DEFAULT_BACKOFF: BackoffPolicy = { baseMs: 30_000, maxMs: 30 * 60_000 };

interface Failure {
  message: string;
  retryable: boolean;
  retryAfterMs?: number | undefined;
}

/** Whether a failed run may be retried, and what to record about it. */
function classify(error: unknown, timedOutAfterMs: number | null): Failure {
  if (timedOutAfterMs !== null) {
    return { message: `Timed out after ${timedOutAfterMs} ms`, retryable: true };
  }
  if (error instanceof TriageModelError || error instanceof GitHubApiError) {
    return { message: error.message, retryable: error.retryable, retryAfterMs: error.retryAfterMs };
  }
  // Unexpected errors (a database hiccup, a bug) get the normal retry budget, then fail.
  return { message: describeUnexpected(error), retryable: true };
}

/**
 * A message for `last_error`. Drizzle's query errors repeat the SQL and its parameters, which
 * here include model output and issue text, so only the database's own message is kept.
 */
function describeUnexpected(error: unknown): string {
  if (error instanceof DrizzleQueryError) {
    return `Database error: ${error.cause?.message ?? 'query failed'}`;
  }
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Polls the queue and runs jobs, `concurrency` at a time: triage jobs, and write-back jobs when
 * it has what they need.
 *
 * Each run has a hard deadline, enforced with an AbortSignal that reaches the GitHub and model
 * requests. The lease outlasts the deadline, so a healthy worker always finishes (or gives up on)
 * a job before anyone else may claim it; a crashed worker's jobs are reclaimed when their lease
 * expires.
 *
 * `stop()` shuts down gracefully: no new claims, in-flight jobs get a grace period to finish,
 * and any still running after it are interrupted and put back in the queue without using up an
 * attempt.
 */
export class TriageWorker {
  readonly workerId: string;
  readonly #options: TriageWorkerOptions;
  readonly #leaseMs: number;
  readonly #pollIntervalMs: number;
  readonly #backoff: BackoffPolicy;
  readonly #random: () => number;
  /** Aborted to stop polling. */
  readonly #stopping = new AbortController();
  /** Aborted to interrupt jobs that outlive the shutdown grace period. */
  readonly #interrupt = new AbortController();
  #loops: Promise<void>[] = [];

  constructor(options: TriageWorkerOptions) {
    this.#options = options;
    this.workerId = options.workerId ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    this.#leaseMs = options.leaseMs ?? options.jobTimeoutMs + 60_000;
    if (this.#leaseMs <= options.jobTimeoutMs) {
      throw new Error('The lease must outlast the job timeout');
    }
    this.#pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.#backoff = options.backoff ?? DEFAULT_BACKOFF;
    this.#random = options.random ?? Math.random;
  }

  /** Starts the polling loops. */
  start(): void {
    if (this.#loops.length > 0) {
      throw new Error('Worker already started');
    }
    this.#options.logger.info(
      { workerId: this.workerId, concurrency: this.#options.concurrency },
      'triage worker started',
    );
    this.#loops = Array.from({ length: this.#options.concurrency }, () => this.#loop());
  }

  /**
   * Stops claiming jobs and waits for in-flight ones, interrupting them after `graceMs`. The
   * default leaves time to put interrupted jobs back before a container runtime's usual 10
   * second stop timeout sends SIGKILL.
   */
  async stop({ graceMs = 5_000 }: { graceMs?: number } = {}): Promise<void> {
    this.#stopping.abort();
    const loops = Promise.allSettled(this.#loops);
    const timer = new AbortController();
    const finished = await Promise.race([
      loops.then(() => true),
      sleep(graceMs, false, { signal: timer.signal }).catch(() => false),
    ]);
    timer.abort();
    if (!finished) {
      this.#options.logger.warn({ graceMs }, 'interrupting triage jobs still running');
      this.#interrupt.abort(new Error('Worker is shutting down'));
      await loops;
    }
    this.#options.logger.info({ workerId: this.workerId }, 'triage worker stopped');
  }

  async #loop(): Promise<void> {
    while (!this.#stopping.signal.aborted) {
      let claimed = false;
      try {
        claimed = await this.runNext();
      } catch (error) {
        // Claiming failed, for example because the database is unreachable. Try again later.
        this.#options.logger.error({ err: error }, 'triage worker poll failed');
      }
      if (!claimed) {
        const jitter = 1 + this.#random() * 0.5;
        await sleep(this.#pollIntervalMs * jitter, undefined, {
          signal: this.#stopping.signal,
        }).catch(() => undefined);
      }
    }
  }

  /** Claims and runs one job. Returns false when no job was due. */
  async runNext(): Promise<boolean> {
    const { db, logger, maxAttempts } = this.#options;
    const job = await claimJob(db, {
      workerId: this.workerId,
      leaseMs: this.#leaseMs,
      kinds: this.#options.writeBack ? ['triage', 'write_back'] : ['triage'],
    });
    if (!job) {
      return false;
    }
    const log = logger.child({
      jobId: job.jobId,
      kind: job.kind,
      issueId: job.issueId,
      attempt: job.attempts,
    });

    if (job.attempts > maxAttempts) {
      // Earlier runs ended with an expired lease (a crash or hang), not a recorded failure.
      await failJob(db, job, `Gave up after ${maxAttempts} attempts`);
      log.error('triage job exceeded its attempts');
      return true;
    }

    const deadline = AbortSignal.timeout(this.#options.jobTimeoutMs);
    const signal = AbortSignal.any([deadline, this.#interrupt.signal]);
    try {
      const { writeBack } = this.#options;
      const outcome =
        job.kind === 'write_back' && writeBack
          ? await runWriteBackJob({ db, ...writeBack }, job, signal)
          : await runTriageJob(this.#options, job, signal);
      log.info(outcome, `${job.kind} job finished`);
    } catch (error) {
      await this.#recordFailure(job, error, deadline.aborted, log);
    }
    return true;
  }

  async #recordFailure(
    job: ClaimedJob,
    error: unknown,
    timedOut: boolean,
    log: Logger,
  ): Promise<void> {
    const { db, maxAttempts, jobTimeoutMs } = this.#options;
    try {
      if (this.#interrupt.signal.aborted && !timedOut) {
        const result = await releaseJob(db, job);
        log.info({ result }, 'triage job interrupted by shutdown');
        return;
      }
      const failure = classify(error, timedOut ? jobTimeoutMs : null);
      if (failure.retryable && job.attempts < maxAttempts) {
        const delayMs = Math.max(
          retryDelayMs(job.attempts, this.#backoff, this.#random),
          failure.retryAfterMs ?? 0,
        );
        const result = await scheduleRetry(db, job, { error: failure.message, delayMs });
        log.warn({ err: error, delayMs, result }, 'triage job failed; will retry');
      } else {
        await failJob(db, job, failure.message);
        log.error({ err: error, retryable: failure.retryable }, 'triage job failed');
      }
    } catch (recordError) {
      // The job stays leased until it expires, then another worker picks it up.
      log.error({ err: recordError, cause: error }, 'could not record triage job failure');
    }
  }
}
