import {
  labelKey,
  uniqueLabels,
  type WriteBackAttempt,
  type WriteBackResult,
} from '@issue-triage/shared';
import { and, eq, gt } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import type { WriteBackMode } from '../config.js';
import type { Database } from '../db/client.js';
import { issues, repositories, reviews, triageJobs, triageSuggestions } from '../db/schema.js';
import type { GitHubClient, LabelEvent } from '../github/client.js';
import type { LabelSource } from './labels.js';
import { cancelJob, completeJob, saveProgress, type ClaimedJob } from './queue.js';

/** The GitHub calls a write-back makes. */
export type IssueLabelWriter = Pick<
  GitHubClient,
  'getIssue' | 'listLabelEvents' | 'addLabels' | 'removeLabel'
>;

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
 * How far before the review a label change on GitHub still counts as made after it. GitHub's
 * timestamps are whole seconds from GitHub's clock, the review's are from the database's, so the
 * two can disagree by a little; within this margin the person who changed the label on GitHub
 * wins.
 */
export const CLOCK_SKEW_ALLOWANCE_MS = 5_000;

/**
 * Drops from the plan the labels someone changed on GitHub after the review, so a late run (a
 * retry after an outage, or after a rate limit) never undoes a maintainer's hand edit:
 *
 * - a label the review adds, that was taken off the issue since, stays off: it was there at some
 *   point after the review (an earlier run of this job added it, or someone else did), and then
 *   someone removed it on purpose;
 * - a label the review removes, that was put on again since, stays on.
 *
 * This job never takes off a label it adds or puts back one it removes, so these events are always
 * someone else's: a person, another app, or the write-back of a later review. (A job whose review
 * has been followed by a newer review of the same issue cancels itself before this point, so an
 * older decision never overrides a newer one.) Labels the plan doesn't touch, and changes from before the review, are not
 * considered: the review already accounted for those.
 */
export function respectChangesSince(
  plan: Pick<WriteBackPlan, 'add' | 'remove'>,
  events: readonly LabelEvent[],
  since: Date,
): { add: string[]; remove: string[]; kept: string[] } {
  const takenOff = new Set<string>();
  const putOn = new Set<string>();
  for (const { event, label, createdAt } of events) {
    if (createdAt.getTime() >= since.getTime()) {
      (event === 'unlabeled' ? takenOff : putOn).add(labelKey(label));
    }
  }
  const changed = (name: string, keys: Set<string>) => keys.has(labelKey(name));
  return {
    add: plan.add.filter((name) => !changed(name, takenOff)),
    remove: plan.remove.filter((name) => !changed(name, putOn)),
    kept: [
      ...plan.add.filter((name) => changed(name, takenOff)),
      ...plan.remove.filter((name) => changed(name, putOn)),
    ],
  };
}

/** The earliest time a change on GitHub counts as made after a review (see the allowance). */
export function changesCountFrom(reviewedAt: Date): Date {
  const earliest = reviewedAt.getTime() - CLOCK_SKEW_ALLOWANCE_MS;
  return new Date(Math.floor(earliest / 1000) * 1000);
}

/**
 * Folds one run into the job's record. A run that saves progress more than once updates its own
 * entry; entries with the same number are merged rather than replaced, because a run interrupted
 * by a shutdown gives its attempt back, so the next run reuses its number. Totals are the union over runs; a label counts as skipped only if no run added it
 * (it can be recreated in the repository between runs).
 */
export function mergeAttempt(
  previous: WriteBackResult | null,
  attempt: WriteBackAttempt,
  dryRun: boolean,
): WriteBackResult {
  const earlier = previous?.attempts ?? [];
  const same = earlier.find((entry) => entry.attempt === attempt.attempt);
  const merged: WriteBackAttempt = same
    ? {
        attempt: attempt.attempt,
        added: uniqueLabels([...same.added, ...attempt.added]),
        removed: uniqueLabels([...same.removed, ...attempt.removed]),
        skipped: attempt.skipped,
        kept: uniqueLabels([...same.kept, ...attempt.kept]),
      }
    : attempt;
  const attempts = [...earlier.filter((entry) => entry !== same), merged].sort(
    (a, b) => a.attempt - b.attempt,
  );
  const added = uniqueLabels(attempts.flatMap((entry) => entry.added));
  const addedKeys = new Set(added.map(labelKey));
  return {
    added,
    removed: uniqueLabels(attempts.flatMap((entry) => entry.removed)),
    skipped: uniqueLabels(attempts.flatMap((entry) => entry.skipped)).filter(
      (name) => !addedKeys.has(labelKey(name)),
    ),
    kept: uniqueLabels(attempts.flatMap((entry) => entry.kept)),
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
 * Labels someone changed on GitHub after the review are left as they are (see
 * {@link respectChangesSince}). The issue's `updated_at` says whether anything changed at all; only
 * then does the job read the issue's label events, which say exactly which labels changed and when.
 *
 * After each change it makes, it saves what it did so far on the job, so a run that fails part-way
 * (a rate limit between adding and removing, say) keeps a record of it: the retry finds that part
 * of the change already on GitHub and adds its own entry, and the totals cover both runs. A change
 * can still go unrecorded if the process dies, or the save fails, between a GitHub call and the
 * save that follows it; the retry then sees the label already in place and records nothing.
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
      reviewedAt: reviews.createdAt,
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
  // Two reviews of one issue (it changed and was triaged again) can both have write-backs waiting,
  // and a retrying older one may run last. The newer review's label change is the newer decision.
  // A newer review that changes no labels (a rejection, say) has no write-back and doesn't count.
  const newerJob = alias(triageJobs, 'newer_job');
  const [newer] = await db
    .select({ id: reviews.id })
    .from(reviews)
    .innerJoin(triageSuggestions, eq(triageSuggestions.id, reviews.suggestionId))
    .innerJoin(newerJob, eq(newerJob.reviewId, reviews.id))
    .where(and(eq(triageSuggestions.issueId, job.issueId), gt(reviews.id, job.reviewId)))
    .limit(1);
  if (newer) {
    return cancel('Superseded by a newer review of the same issue');
  }

  const dryRun = mode === 'dry-run';
  const target = { owner: row.owner, repo: row.name, number: row.issueNumber };
  let current: readonly string[];
  let repositoryLabels: readonly string[];
  let updatedAt: Date | null = null;
  if (dryRun) {
    current = row.issueLabels;
    repositoryLabels = row.cachedLabels?.map((label) => label.name) ?? [];
  } else {
    const repository = { id: row.repositoryId, owner: row.owner, name: row.name };
    repositoryLabels = (await labels.labelsFor(repository, { signal, fresh: true })).map(
      (label) => label.name,
    );
    const issue = await github.getIssue(target.owner, target.repo, target.number, { signal });
    current = issue.labels;
    updatedAt = issue.updatedAt;
  }

  let plan = planWriteBack({
    labelsAdded: row.labelsAdded,
    labelsRemoved: row.labelsRemoved,
    current,
    repositoryLabels,
  });
  let kept: string[] = [];
  const since = changesCountFrom(row.reviewedAt);
  if (
    updatedAt !== null &&
    updatedAt.getTime() >= since.getTime() &&
    (plan.add.length > 0 || plan.remove.length > 0)
  ) {
    const events = await github.listLabelEvents(target.owner, target.repo, target.number, {
      signal,
    });
    const respected = respectChangesSince(plan, events, since);
    plan = { ...plan, add: respected.add, remove: respected.remove };
    kept = respected.kept;
  }

  const attempt: WriteBackAttempt = {
    attempt: job.attempts,
    added: [],
    removed: [],
    skipped: plan.skipped,
    kept,
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
