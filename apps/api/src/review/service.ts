import {
  labelKey,
  planLabelChange,
  uniqueLabels,
  type ConflictCode,
  type PriorityLabels,
  type Review,
  type ReviewDecision,
  type ReviewRequest,
} from '@issue-triage/shared';
import { and, eq, sql } from 'drizzle-orm';

import type { Database, Transaction } from '../db/client.js';
import { issues, repositories, reviews, triageJobs, triageSuggestions } from '../db/schema.js';
import { enqueueWriteBackJob } from '../triage/queue.js';
import { findPendingSuggestionId, findReview } from './queries.js';

/**
 * Who reviews, until sign-in exists. The review API has no authentication yet (it listens on
 * 127.0.0.1 only); GitHub sign-in on the roadmap replaces this with the reviewer's login.
 */
export const LOCAL_REVIEWER = 'local';

/** A review or undo that cannot apply to the suggestion as it is now. Answered with 409. */
export class ReviewConflictError extends Error {
  override readonly name = 'ReviewConflictError';
  readonly code: ConflictCode;
  readonly currentSuggestionId: number | null;

  constructor(code: ConflictCode, message: string, currentSuggestionId: number | null = null) {
    super(message);
    this.code = code;
    this.currentSuggestionId = currentSuggestionId;
  }
}

/** The suggestion or review does not exist. Answered with 404. */
export class ReviewNotFoundError extends Error {
  override readonly name = 'ReviewNotFoundError';
}

/** The request names labels the repository doesn't have. Answered with 422. */
export class UnknownLabelsError extends Error {
  override readonly name = 'UnknownLabelsError';
  readonly labels: string[];

  constructor(labels: string[]) {
    super(`Not labels of this repository: ${labels.join(', ')}`);
    this.labels = labels;
  }
}

export interface ReviewOptions {
  priorityLabels: PriorityLabels;
  /** How long the write-back waits before it is due: the undo window. */
  writeBackDelayMs: number;
  reviewerLogin?: string;
}

const DECISIONS: Record<ReviewRequest['decision'], ReviewDecision> = {
  accept: 'accepted',
  edit: 'edited',
  reject: 'rejected',
};

/**
 * Locks the suggestion's row and reads what a review needs. The lock serializes this review
 * with anything else that changes the suggestion's status (another review, an undo, or the
 * triage worker superseding it with a newer suggestion), so the status checks below stay true
 * until the transaction commits.
 */
async function lockSuggestion(tx: Transaction, suggestionId: number) {
  const [row] = await tx
    .select({
      id: triageSuggestions.id,
      status: triageSuggestions.status,
      labels: triageSuggestions.labels,
      priority: triageSuggestions.priority,
      issueId: issues.id,
      issueState: issues.state,
      issueRemovedAt: issues.removedAt,
      issueLabels: issues.labels,
      repositoryLabels: repositories.labels,
    })
    .from(triageSuggestions)
    .innerJoin(issues, eq(issues.id, triageSuggestions.issueId))
    .innerJoin(repositories, eq(repositories.id, issues.repositoryId))
    .where(eq(triageSuggestions.id, suggestionId))
    .for('update', { of: triageSuggestions });
  return row ?? null;
}

type LockedSuggestion = NonNullable<Awaited<ReturnType<typeof lockSuggestion>>>;

/** Throws the 409 that explains why a locked suggestion can't be reviewed, if it can't. */
async function assertReviewable(tx: Transaction, suggestion: LockedSuggestion): Promise<void> {
  if (suggestion.issueRemovedAt !== null || suggestion.issueState !== 'open') {
    throw new ReviewConflictError(
      'issue_closed',
      'This issue was closed or removed on GitHub, so there is nothing to triage.',
    );
  }
  if (suggestion.status === 'reviewed') {
    throw new ReviewConflictError('already_reviewed', 'This suggestion was already reviewed.');
  }
  if (suggestion.status === 'superseded') {
    const current = await findPendingSuggestionId(tx, suggestion.issueId, suggestion.id);
    throw new ReviewConflictError(
      'superseded',
      'This suggestion is out of date: the issue changed and was triaged again.',
      current,
    );
  }
}

/**
 * Maps requested labels to the repository's own spelling, and refuses any it doesn't have. Labels
 * already on the issue are allowed even if the repository has since deleted them, so keeping
 * one is never an error.
 */
function canonicalLabels(requested: readonly string[], suggestion: LockedSuggestion): string[] {
  const known = new Map<string, string>();
  for (const name of [
    ...suggestion.issueLabels,
    ...suggestion.labels,
    ...(suggestion.repositoryLabels?.map((label) => label.name) ?? []),
  ]) {
    known.set(labelKey(name), name);
  }
  const unknown = requested.filter((name) => !known.has(labelKey(name)));
  if (unknown.length > 0) {
    throw new UnknownLabelsError(unknown);
  }
  return uniqueLabels(requested.map((name) => known.get(labelKey(name)) ?? name));
}

/**
 * Records a reviewer's decision on a pending suggestion and, when it changes labels, queues the
 * job that writes the change to GitHub, all in one transaction. Either both are stored or
 * neither is, so an accepted review can't be lost between the two (a transactional outbox).
 *
 * Concurrency is optimistic: the reviewer decided on one specific suggestion, by id. If that
 * suggestion is no longer pending when the review arrives (someone else reviewed it, or the
 * issue changed and a newer suggestion replaced it), the review is refused with a conflict that
 * says why, rather than applied to something the reviewer never saw.
 */
export async function submitReview(
  db: Database,
  suggestionId: number,
  request: ReviewRequest,
  { priorityLabels, writeBackDelayMs, reviewerLogin = LOCAL_REVIEWER }: ReviewOptions,
): Promise<Review> {
  return db.transaction(async (tx) => {
    const suggestion = await lockSuggestion(tx, suggestionId);
    if (!suggestion) {
      throw new ReviewNotFoundError(`No suggestion ${suggestionId}`);
    }
    await assertReviewable(tx, suggestion);

    await tx
      .update(triageSuggestions)
      .set({ status: 'reviewed', updatedAt: sql`now()` })
      .where(eq(triageSuggestions.id, suggestion.id));

    const decision = DECISIONS[request.decision];
    const note = request.note === undefined || request.note === '' ? null : request.note;
    if (request.decision === 'reject') {
      const [review] = await tx
        .insert(reviews)
        .values({ suggestionId, decision, note, reviewerLogin })
        .returning({ id: reviews.id });
      if (!review) {
        throw new Error(`Insert returned no review for suggestion ${suggestionId}`);
      }
      return requireReview(tx, suggestionId);
    }

    const edit = request.decision === 'edit' ? request : null;
    const priority = edit?.priority ?? suggestion.priority;
    const change = planLabelChange({
      current: suggestion.issueLabels,
      target: edit?.labels ? canonicalLabels(edit.labels, suggestion) : suggestion.labels,
      removeUnlisted: edit?.labels !== undefined,
      priorityLabel: priorityLabels[priority],
    });

    const [review] = await tx
      .insert(reviews)
      .values({
        suggestionId,
        decision,
        labels: change.final,
        priority,
        labelsAdded: change.add,
        labelsRemoved: change.remove,
        note,
        reviewerLogin,
      })
      .returning({ id: reviews.id });
    if (!review) {
      throw new Error(`Insert returned no review for suggestion ${suggestionId}`);
    }
    if (change.add.length > 0 || change.remove.length > 0) {
      await enqueueWriteBackJob(tx, {
        issueId: suggestion.issueId,
        reviewId: review.id,
        delayMs: writeBackDelayMs,
      });
    }
    return requireReview(tx, suggestionId);
  });
}

async function requireReview(tx: Transaction, suggestionId: number): Promise<Review> {
  const review = await findReview(tx, suggestionId);
  if (!review) {
    throw new Error(`Review of suggestion ${suggestionId} vanished inside its transaction`);
  }
  return review;
}

/**
 * Takes back a review, returning the suggestion to the queue, as long as nothing has been
 * written to GitHub yet: its write-back job must still be waiting and never have run. The job
 * row is locked first, so a worker can't claim it while the undo commits (claims skip locked
 * rows), and a job a worker already claimed is seen as running and refuses the undo.
 */
export async function undoReview(db: Database, suggestionId: number): Promise<void> {
  await db.transaction(async (tx) => {
    const suggestion = await lockSuggestion(tx, suggestionId);
    const [review] = suggestion
      ? await tx
          .select({ id: reviews.id })
          .from(reviews)
          .where(eq(reviews.suggestionId, suggestionId))
      : [];
    if (!suggestion || !review) {
      throw new ReviewNotFoundError(`Suggestion ${suggestionId} has no review to undo`);
    }

    const [job] = await tx
      .select({ status: triageJobs.status, attempts: triageJobs.attempts })
      .from(triageJobs)
      .where(eq(triageJobs.reviewId, review.id))
      .for('update');
    if (job && (job.status !== 'pending' || job.attempts > 0)) {
      throw new ReviewConflictError(
        'write_back_started',
        'Too late to undo: the change is already being written to GitHub.',
      );
    }
    if (suggestion.issueRemovedAt !== null || suggestion.issueState !== 'open') {
      throw new ReviewConflictError(
        'issue_closed',
        'This issue was closed or removed on GitHub since the review.',
      );
    }
    const newer = await findPendingSuggestionId(tx, suggestion.issueId, suggestion.id);
    if (newer !== null) {
      throw new ReviewConflictError(
        'superseded',
        'The issue changed and was triaged again since the review; review the new suggestion.',
        newer,
      );
    }

    // Deleting the review deletes its write-back job too (on delete cascade).
    await tx.delete(reviews).where(eq(reviews.id, review.id));
    await tx
      .update(triageSuggestions)
      .set({ status: 'pending', updatedAt: sql`now()` })
      .where(and(eq(triageSuggestions.id, suggestionId), eq(triageSuggestions.status, 'reviewed')));
  });
}
