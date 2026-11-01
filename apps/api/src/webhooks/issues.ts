import { lte, sql } from 'drizzle-orm';

import type { Transaction } from '../db/client.js';
import { issues, repositories } from '../db/schema.js';
import type { IssuesEvent } from './payloads.js';

/** `stale` means the stored issue is newer than the event, so the event was skipped. */
export type IssueUpsertResult = 'applied' | 'stale';

/**
 * Mirrors the repository and issue from an `issues` event. The issue snapshot in every event is
 * complete (labels included), so all handled actions share this one upsert.
 */
export async function upsertIssue(tx: Transaction, event: IssuesEvent): Promise<IssueUpsertResult> {
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
  const written = await tx
    .insert(issues)
    .values({ githubId: issue.id, githubCreatedAt: issue.created_at, ...issueFields })
    .onConflictDoUpdate({
      target: issues.githubId,
      set: { ...issueFields, updatedAt: sql`now()` },
      // GitHub does not guarantee delivery order, and redeliveries can arrive much later.
      // Only apply an event whose snapshot is at least as new as the stored one.
      setWhere: lte(issues.githubUpdatedAt, issue.updated_at),
    })
    .returning({ id: issues.id });

  return written.length > 0 ? 'applied' : 'stale';
}
