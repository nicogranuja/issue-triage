import { and, eq, sql } from 'drizzle-orm';

import type { Database, Transaction } from '../db/client.js';
import { issues, repositories, triageSuggestions } from '../db/schema.js';
import { findDuplicateCandidates, type DuplicateSearchOptions } from './duplicates.js';
import type { LabelSource } from './labels.js';
import {
  InvalidModelOutputError,
  type TriageInput,
  type TriageModel,
  type TriageResult,
} from './model.js';
import { outputContext, suggestionSchema } from './output.js';
import { PROMPT_VERSION } from './prompt.js';
import { cancelTriageJob, completeTriageJob, type ClaimedJob } from './queue.js';

export interface TriageJobDependencies {
  db: Database;
  model: TriageModel;
  labels: LabelSource;
  duplicates?: DuplicateSearchOptions;
}

export type TriageJobOutcome =
  | { status: 'succeeded'; suggestionId: number }
  | { status: 'cancelled'; reason: string }
  /** The lease expired or the job was cancelled while it ran; its result was discarded. */
  | { status: 'lease_lost' };

/** Rolls back the save transaction when the lease turns out to be gone. */
class LeaseLost extends Error {}

/**
 * Runs one claimed job: gathers the issue, the repository's labels, and duplicate candidates;
 * asks the model; validates the answer; and stores it as a pending suggestion.
 *
 * No database transaction is held while the model runs, which can take a minute. The result is
 * saved in one short transaction that first proves the lease is still held, so a worker that
 * lost its lease, or a job cancelled mid-run (the issue was deleted), writes nothing.
 *
 * Failures are thrown for the worker to classify as retryable or not.
 */
export async function runTriageJob(
  { db, model, labels, duplicates }: TriageJobDependencies,
  job: ClaimedJob,
  signal: AbortSignal,
): Promise<TriageJobOutcome> {
  const [issue] = await db
    .select({
      id: issues.id,
      repositoryId: issues.repositoryId,
      number: issues.number,
      title: issues.title,
      body: issues.body,
      state: issues.state,
      removedAt: issues.removedAt,
      owner: repositories.owner,
      name: repositories.name,
      fullName: repositories.fullName,
    })
    .from(issues)
    .innerJoin(repositories, eq(repositories.id, issues.repositoryId))
    .where(eq(issues.id, job.issueId));

  const cancel = async (reason: string): Promise<TriageJobOutcome> =>
    (await cancelTriageJob(db, job, reason))
      ? { status: 'cancelled', reason }
      : { status: 'lease_lost' };
  if (!issue) {
    return cancel('Issue no longer exists');
  }
  if (issue.removedAt) {
    return cancel('Issue was removed from GitHub');
  }
  if (issue.state !== 'open') {
    return cancel('Issue was closed before triage ran');
  }

  const repositoryLabels = await labels.labelsFor(
    { id: issue.repositoryId, owner: issue.owner, name: issue.name },
    { signal },
  );
  const candidates = await findDuplicateCandidates(db, issue, duplicates);
  const input: TriageInput = {
    repository: issue.fullName,
    issue: { number: issue.number, title: issue.title, body: issue.body },
    labels: repositoryLabels.map(({ name, description }) => ({ name, description })),
    candidates: candidates.map(({ number, title, state, excerpt }) => ({
      number,
      title,
      state,
      excerpt,
    })),
  };

  const result = await model.suggest(input, { signal });

  // Every provider's output is untrusted, whatever it validated itself: check it again against
  // the labels and candidates this job actually sent.
  const checked = suggestionSchema(outputContext(input)).safeParse(result.suggestion);
  if (!checked.success) {
    throw new InvalidModelOutputError(checked.error.issues.map((problem) => problem.message));
  }
  const issueIdByNumber = new Map(candidates.map((c) => [c.number, c.issueId]));

  try {
    return await db.transaction(async (tx) => {
      if (!(await completeTriageJob(tx, job))) {
        throw new LeaseLost();
      }
      const suggestionId = await saveSuggestion(
        tx,
        issue.id,
        { ...result, suggestion: checked.data },
        issueIdByNumber,
      );
      return { status: 'succeeded', suggestionId } as const;
    });
  } catch (error) {
    if (error instanceof LeaseLost) {
      return { status: 'lease_lost' };
    }
    throw error;
  }
}

async function saveSuggestion(
  tx: Transaction,
  issueId: number,
  { suggestion, model, usage, modelCalls, latencyMs }: TriageResult,
  issueIdByNumber: Map<number, number>,
): Promise<number> {
  // Reviewers see one pending suggestion per issue: the newest replaces any unreviewed one.
  await tx
    .update(triageSuggestions)
    .set({ status: 'superseded', updatedAt: sql`now()` })
    .where(and(eq(triageSuggestions.issueId, issueId), eq(triageSuggestions.status, 'pending')));

  const [saved] = await tx
    .insert(triageSuggestions)
    .values({
      issueId,
      summary: suggestion.summary,
      labels: suggestion.labels.names,
      labelsConfidence: suggestion.labels.confidence,
      labelsRationale: suggestion.labels.rationale,
      priority: suggestion.priority.level,
      priorityConfidence: suggestion.priority.confidence,
      priorityRationale: suggestion.priority.rationale,
      duplicates: suggestion.duplicates.issues.flatMap(({ number, reason }) => {
        const duplicateId = issueIdByNumber.get(number);
        return duplicateId === undefined ? [] : [{ issueId: duplicateId, reason }];
      }),
      duplicatesConfidence: suggestion.duplicates.confidence,
      duplicatesRationale: suggestion.duplicates.rationale,
      model,
      promptVersion: PROMPT_VERSION,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      modelCalls,
      latencyMs,
    })
    .returning({ id: triageSuggestions.id });
  if (!saved) {
    throw new Error(`Insert returned no suggestion for issue ${issueId}`);
  }
  return saved.id;
}
