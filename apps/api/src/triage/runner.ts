import { and, eq, sql } from 'drizzle-orm';

import type { Database, Transaction } from '../db/client.js';
import { issues, repositories, triageSuggestions } from '../db/schema.js';
import { genAiSystem, record } from '../telemetry/metrics.js';
import { inSpan, SpanKind } from '../telemetry/tracing.js';
import { findDuplicateCandidates, type DuplicateSearchOptions } from './duplicates.js';
import type { LabelSource } from './labels.js';
import {
  InvalidModelOutputError,
  ModelRefusalError,
  type TriageInput,
  type TriageModel,
  type TriageResult,
} from './model.js';
import { outputContext, suggestionSchema } from './output.js';
import { cancelJob, completeJob, type ClaimedJob } from './queue.js';

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
export function runTriageJob(
  dependencies: TriageJobDependencies,
  job: ClaimedJob,
  signal: AbortSignal,
): Promise<TriageJobOutcome> {
  const { model } = dependencies;
  const attributes = {
    'triage.job.id': job.jobId,
    'triage.job.attempt': job.attempts,
    'triage.provider': model.provider,
    'triage.model': model.modelId,
    'triage.prompt_version': model.promptVersion,
  };
  return inSpan('triage.job', attributes, async (span) => {
    const outcome = await runJob(dependencies, job, signal);
    span.setAttribute('triage.outcome', outcome.status);
    return outcome;
  });
}

async function runJob(
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
    (await cancelJob(db, job, reason)) ? { status: 'cancelled', reason } : { status: 'lease_lost' };
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

  const result = await suggest(model, input, signal);

  // Every provider's output is untrusted, whatever it validated itself: check it again against
  // the labels and candidates this job actually sent.
  const checked = suggestionSchema(outputContext(input)).safeParse(result.suggestion);
  if (!checked.success) {
    throw new InvalidModelOutputError(checked.error.issues.map((problem) => problem.message));
  }
  const issueIdByNumber = new Map(candidates.map((c) => [c.number, c.issueId]));

  try {
    return await db.transaction(async (tx) => {
      if (!(await completeJob(tx, job))) {
        throw new LeaseLost();
      }
      const suggestionId = await saveSuggestion(
        tx,
        issue.id,
        { ...result, suggestion: checked.data },
        { promptVersion: model.promptVersion, effort: model.effort },
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

/**
 * Asks the model, in a client span with GenAI semantic-convention attributes, and records the
 * model metrics. Metadata only: the system, the models, token counts, the number of calls, and
 * whether a fallback answered. Never the prompt, the issue, or the reply.
 */
function suggest(
  model: TriageModel,
  input: TriageInput,
  signal: AbortSignal,
): Promise<TriageResult> {
  const labels = {
    'gen_ai.system': genAiSystem(model.provider),
    'gen_ai.request.model': model.modelId,
  };
  const attributes = { 'gen_ai.operation.name': 'chat', ...labels };
  return inSpan(
    `chat ${model.modelId}`,
    attributes,
    async (span) => {
      const started = performance.now();
      const duration = () => (performance.now() - started) / 1000;
      try {
        const result = await model.suggest(input, { signal });
        const { usage } = result;
        span.setAttributes({
          'gen_ai.response.model': result.model,
          'gen_ai.usage.input_tokens':
            usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens,
          'gen_ai.usage.output_tokens': usage.outputTokens,
          'gen_ai.usage.cache_read.input_tokens': usage.cacheReadInputTokens,
          'gen_ai.usage.cache_creation.input_tokens': usage.cacheCreationInputTokens,
          'triage.model.calls': result.modelCalls,
          'triage.model.fallback': result.fallback ?? false,
        });
        record('modelDuration', { 'gen_ai.operation.name': 'chat', ...labels }, duration());
        recordTokens(labels, result);
        const retried = result.modelCalls > 1;
        record('modelSuggestions', {
          ...labels,
          outcome: retried ? 'valid_after_retry' : 'valid_first_try',
        });
        if (retried) {
          record('validationRetries', labels);
        }
        if (result.fallback) {
          record('fallbacks', labels);
        }
        return result;
      } catch (error) {
        record('modelDuration', { 'gen_ai.operation.name': 'chat', ...labels }, duration());
        if (error instanceof InvalidModelOutputError) {
          // Validation failed twice: the first time led to a corrective turn.
          record('validationRetries', labels);
        }
        record('modelSuggestions', {
          ...labels,
          outcome:
            error instanceof ModelRefusalError
              ? 'refused'
              : error instanceof InvalidModelOutputError
                ? 'invalid'
                : 'failed',
        });
        throw error;
      }
    },
    SpanKind.CLIENT,
  );
}

function recordTokens(
  labels: { 'gen_ai.system': ReturnType<typeof genAiSystem>; 'gen_ai.request.model': string },
  { usage }: TriageResult,
): void {
  const counts = {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cache_read: usage.cacheReadInputTokens,
    cache_write: usage.cacheCreationInputTokens,
  } as const;
  for (const [type, count] of Object.entries(counts) as [keyof typeof counts, number][]) {
    if (count > 0) {
      record('modelTokens', { ...labels, type }, count);
    }
  }
}

async function saveSuggestion(
  tx: Transaction,
  issueId: number,
  { suggestion, model, usage, modelCalls, latencyMs }: TriageResult,
  { promptVersion, effort }: Pick<TriageModel, 'promptVersion' | 'effort'>,
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
      promptVersion,
      effort,
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
