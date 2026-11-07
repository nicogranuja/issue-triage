import {
  labelKey,
  uniqueLabels,
  type WriteBackAttempt,
  type WriteBackResult,
} from '@issue-triage/shared';
import { eq } from 'drizzle-orm';

import type { WriteBackMode } from '../config.js';
import type { Database } from '../db/client.js';
import { issues, repositories, reviews, triageJobs } from '../db/schema.js';
import type { GitHubClient } from '../github/client.js';
import type { LabelSource } from './labels.js';
import { cancelJob, completeJob, saveProgress, type ClaimedJob } from './queue.js';

/** The GitHub calls a write-back makes. */
export type IssueLabelWriter = Pick<GitHubClient, 'getIssue' | 'addLabels' | 'removeLabel'>;

export interface WriteBackDependencies {
  db: Database;
  github: IssueLabelWriter;
  labels: LabelSource;
  mode: WriteBackMode;
}

export type WriteBackOutcome =
  | { status: 'succeeded'; result: WriteBackResult }
  | { status: 'cancelled'; reason: string }
  /** The lease expired or the job was cancelled while it ran; nothing was recorded. */
  | { status: 'lease_lost' };

export interface WriteBackPlanInput {
  /** Labels the review adds, as stored with it. */
  labelsAdded: readonly string[];
  /** Labels the reviewer explicitly removed. */
  labelsRemoved: readonly string[];
  /** The issue's labels right now. */
  current: readonly string[];
  /** Every label defined in the repository right now. */
  repositoryLabels: readonly string[];
}

export interface WriteBackPlan {
  add: string[];
  remove: string[];
  /** Labels the review asked for that the repository no longer has. */
  skipped: string[];
}

/**
 * Turns a review's stored change into the calls to make now, against the issue's and the
 * repository's current labels.
 *
 * - A label is only added if the repository still defines it: GitHub would silently create any
 *   other name, so a label deleted since triage (or a typo) would come back. Its spelling is
 *   taken from the repository.
 * - Labels the issue already has are not added again, and only labels it still has are removed,
 *   so running the same plan twice makes no calls the second time.
 * - Nothing is removed unless the reviewer removed it. Labels someone added on GitHub since the
 *   review are left alone, which a "replace all labels" call would have wiped.
 */
export function planWriteBack({
  labelsAdded,
  labelsRemoved,
  current,
  repositoryLabels,
}: WriteBackPlanInput): WriteBackPlan {
  const defined = new Map(repositoryLabels.map((name) => [labelKey(name), name]));
  const onIssue = new Map(current.map((name) => [labelKey(name), name]));
  const removedKeys = new Set(labelsRemoved.map(labelKey));

  const add: string[] = [];
  const skipped: string[] = [];
  for (const name of labelsAdded) {
    const key = labelKey(name);
    const canonical = defined.get(key);
    if (canonical === undefined) {
      skipped.push(name);
    } else if (!onIssue.has(key) && !removedKeys.has(key) && !add.includes(canonical)) {
      add.push(canonical);
    }
  }
  const remove = [...removedKeys].flatMap((key) => {
    const name = onIssue.get(key);
    return name === undefined ? [] : [name];
  });
  return { add, remove, skipped };
}

/**
 * Folds one run into the job's record. A run that saves progress more than once replaces its own
 * earlier entry. Totals are the union over runs; a label counts as skipped only if no run added it
 * (it can be recreated in the repository between runs).
 */
export function mergeAttempt(
  previous: WriteBackResult | null,
  attempt: WriteBackAttempt,
  dryRun: boolean,
): WriteBackResult {
  const attempts = [
    ...(previous?.attempts ?? []).filter((entry) => entry.attempt !== attempt.attempt),
    attempt,
  ].sort((a, b) => a.attempt - b.attempt);
  const added = uniqueLabels(attempts.flatMap((entry) => entry.added));
  const addedKeys = new Set(added.map(labelKey));
  return {
    added,
    removed: uniqueLabels(attempts.flatMap((entry) => entry.removed)),
    skipped: uniqueLabels(attempts.flatMap((entry) => entry.skipped)).filter(
      (name) => !addedKeys.has(labelKey(name)),
    ),
    dryRun,
    attempts,
  };
}

/**
 * Applies a review's label change to the issue on GitHub.
 *
 * The job is diff-based: it adds and removes specific labels, rather than replacing the issue's
 * label set with one computed here. Both calls are idempotent (adding a present label and
 * removing an absent one change nothing), so a job that crashed half-way, or whose result failed
 * to save, can simply run again. Before each run it re-reads the repository's labels and the
 * issue's labels from GitHub, so it acts on the state of now, not of when the review was made.
 *
 * After each change it makes, it saves what it did so far on the job, so a run that fails part-way
 * (a rate limit between adding and removing, say) still leaves a true record: the retry finds that
 * part of the change already on GitHub and adds its own entry, and the totals cover both runs.
 *
 * In `dry-run` mode it plans against the labels stored here and records the plan, calling
 * nothing.
 *
 * Errors from GitHub are thrown for the worker to classify: rate limits and outages retry with
 * backoff; 401, 403, 404, and 422 fail the job with a message saying what to fix.
 */
export async function runWriteBackJob(
  { db, github, labels, mode }: WriteBackDependencies,
  job: ClaimedJob,
  signal: AbortSignal,
): Promise<WriteBackOutcome> {
  const cancel = async (reason: string): Promise<WriteBackOutcome> =>
    (await cancelJob(db, job, reason)) ? { status: 'cancelled', reason } : { status: 'lease_lost' };
  if (job.reviewId === null) {
    return cancel('Write-back job has no review');
  }

  const [row] = await db
    .select({
      labelsAdded: reviews.labelsAdded,
      labelsRemoved: reviews.labelsRemoved,
      issueNumber: issues.number,
      issueLabels: issues.labels,
      removedAt: issues.removedAt,
      repositoryId: repositories.id,
      owner: repositories.owner,
      name: repositories.name,
      cachedLabels: repositories.labels,
      previous: triageJobs.result,
    })
    .from(reviews)
    .innerJoin(triageJobs, eq(triageJobs.id, job.jobId))
    .innerJoin(issues, eq(issues.id, job.issueId))
    .innerJoin(repositories, eq(repositories.id, issues.repositoryId))
    .where(eq(reviews.id, job.reviewId));
  if (!row) {
    return cancel('Review no longer exists');
  }
  if (row.removedAt !== null) {
    return cancel('Issue was removed from GitHub');
  }

  const dryRun = mode === 'dry-run';
  let current: readonly string[];
  let repositoryLabels: readonly string[];
  if (dryRun) {
    current = row.issueLabels;
    repositoryLabels = row.cachedLabels?.map((label) => label.name) ?? [];
  } else {
    const repository = { id: row.repositoryId, owner: row.owner, name: row.name };
    repositoryLabels = (await labels.labelsFor(repository, { signal, fresh: true })).map(
      (label) => label.name,
    );
    current = (await github.getIssue(row.owner, row.name, row.issueNumber, { signal })).labels;
  }

  const plan = planWriteBack({
    labelsAdded: row.labelsAdded,
    labelsRemoved: row.labelsRemoved,
    current,
    repositoryLabels,
  });
  const attempt: WriteBackAttempt = {
    attempt: job.attempts,
    added: [],
    removed: [],
    skipped: plan.skipped,
  };
  const record = () => mergeAttempt(row.previous, attempt, dryRun);
  const lost: WriteBackOutcome = { status: 'lease_lost' };
  if (dryRun) {
    attempt.added = plan.add;
    attempt.removed = plan.remove;
  } else {
    if (plan.add.length > 0) {
      await github.addLabels(row.owner, row.name, row.issueNumber, plan.add, { signal });
      attempt.added = plan.add;
      if (!(await saveProgress(db, job, record()))) {
        return lost;
      }
    }
    for (const label of plan.remove) {
      if (await github.removeLabel(row.owner, row.name, row.issueNumber, label, { signal })) {
        attempt.removed = [...attempt.removed, label];
        if (!(await saveProgress(db, job, record()))) {
          return lost;
        }
      }
    }
  }

  const result = record();
  return (await completeJob(db, job, result)) ? { status: 'succeeded', result } : lost;
}
