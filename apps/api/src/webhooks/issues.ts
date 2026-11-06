import type { IssueRemovalReason, IssueState } from '@issue-triage/shared';
import { and, eq, lte, sql } from 'drizzle-orm';

import type { Transaction } from '../db/client.js';
import { issues, repositories, triageSuggestions } from '../db/schema.js';
import { cancelJobsForIssue, enqueueTriageJob } from '../triage/queue.js';
import { REMOVAL_ISSUE_ACTIONS, TRIAGE_ISSUE_ACTIONS, type IssuesEvent } from './payloads.js';

/** `stale` means the stored issue is newer than the event, so the event was skipped. */
export type IssueUpsertResult = 'applied' | 'stale';

/** What the event did to the issue's triage. */
export type TriageOutcome =
  | 'enqueued'
  | 'already_pending'
  | 'cancelled'
  | 'not_needed'
  | 'skipped_closed'
  | 'skipped_removed';

/** Log context for a handled `issues` event. */
export interface IssuesEventResult {
  result: IssueUpsertResult;
  triage: TriageOutcome;
}

interface StoredIssue {
  id: number;
  state: IssueState;
  removedAt: Date | null;
}

function includes<T extends string>(list: readonly T[], value: string): value is T {
  return (list as readonly string[]).includes(value);
}

/**
 * Mirrors the repository and issue from an `issues` event. The issue snapshot in every event is
 * complete (labels included), so all handled actions share this one upsert. Returns the stored
 * issue when the event was applied, or null when it was stale.
 */
async function upsertIssue(tx: Transaction, event: IssuesEvent): Promise<StoredIssue | null> {
  const { repository, issue } = event;

  const repositoryFields = {
    owner: repository.owner.login,
    name: repository.name,
    fullName: repository.full_name,
    private: repository.private,
  };
  const [storedRepository] = await tx
    .insert(repositories)
    .values({ githubId: repository.id, ...repositoryFields })
    .onConflictDoUpdate({
      target: repositories.githubId,
      set: { ...repositoryFields, updatedAt: sql`now()` },
    })
    .returning({ id: repositories.id });
  if (!storedRepository) {
    throw new Error(`Upsert returned no row for repository ${repository.full_name}`);
  }

  const issueFields = {
    repositoryId: storedRepository.id,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? null,
    state: issue.state,
    stateReason: issue.state_reason ?? null,
    labels: issue.labels.map((label) => label.name),
    authorLogin: issue.user?.login ?? null,
    htmlUrl: issue.html_url,
    githubUpdatedAt: issue.updated_at,
    closedAt: issue.closed_at,
  };
  const [written] = await tx
    .insert(issues)
    .values({ githubId: issue.id, githubCreatedAt: issue.created_at, ...issueFields })
    .onConflictDoUpdate({
      target: issues.githubId,
      set: { ...issueFields, updatedAt: sql`now()` },
      // GitHub does not guarantee delivery order, and redeliveries can arrive much later.
      // Only apply an event whose snapshot is at least as new as the stored one.
      setWhere: lte(issues.githubUpdatedAt, issue.updated_at),
    })
    .returning({ id: issues.id, state: issues.state, removedAt: issues.removedAt });

  return written ?? null;
}

/**
 * Marks the issue as removed, cancels its triage jobs, and retires its unreviewed suggestion, so
 * it never reaches the review queue. Applied whatever the event order: removal is final, so an
 * older event that arrives later must not undo it. The upsert before it guarantees the row
 * exists, so a late `opened` for an issue we never saw cannot resurrect it.
 */
async function removeIssue(
  tx: Transaction,
  githubIssueId: number,
  reason: IssueRemovalReason,
): Promise<void> {
  const [removed] = await tx
    .update(issues)
    .set({
      removedAt: sql`coalesce(${issues.removedAt}, now())`,
      removalReason: sql`coalesce(${issues.removalReason}, ${reason}::issue_removal_reason)`,
      updatedAt: sql`now()`,
    })
    .where(eq(issues.githubId, githubIssueId))
    .returning({ id: issues.id });
  if (!removed) {
    throw new Error(`No stored issue with GitHub id ${githubIssueId} to remove`);
  }
  await cancelJobsForIssue(tx, removed.id, `Issue was ${reason} on GitHub`);
  // A worker that saved just before this transaction is covered here; one saving after it finds
  // its job cancelled and saves nothing.
  await tx
    .update(triageSuggestions)
    .set({ status: 'superseded', updatedAt: sql`now()` })
    .where(and(eq(triageSuggestions.issueId, removed.id), eq(triageSuggestions.status, 'pending')));
}

/**
 * Applies an `issues` event: mirrors the issue, then queues triage for new or changed issues, or
 * retires removed ones. Runs inside the webhook transaction, so the issue change and its triage
 * job are committed together or not at all.
 */
export async function applyIssuesEvent(
  tx: Transaction,
  event: IssuesEvent,
): Promise<IssuesEventResult> {
  const stored = await upsertIssue(tx, event);
  const result: IssueUpsertResult = stored ? 'applied' : 'stale';

  if (includes(REMOVAL_ISSUE_ACTIONS, event.action)) {
    await removeIssue(tx, event.issue.id, event.action);
    return { result, triage: 'cancelled' };
  }
  if (!includes(TRIAGE_ISSUE_ACTIONS, event.action) || !stored) {
    return { result, triage: 'not_needed' };
  }
  if (stored.removedAt !== null) {
    return { result, triage: 'skipped_removed' };
  }
  if (stored.state !== 'open') {
    // For example, the title of a closed issue was edited: nothing to triage.
    return { result, triage: 'skipped_closed' };
  }
  const created = await enqueueTriageJob(tx, stored.id);
  return { result, triage: created ? 'enqueued' : 'already_pending' };
}
