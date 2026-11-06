import {
  ISSUE_REMOVAL_REASONS,
  ISSUE_STATES,
  JOB_KINDS,
  PRIORITIES,
  REVIEW_DECISIONS,
  SUGGESTION_STATUSES,
  TRIAGE_JOB_STATUSES,
  type DuplicateCandidate,
  type WriteBackResult,
} from '@issue-triage/shared';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import type { GitHubLabel } from '../github/client.js';

// GitHub ids fit comfortably in a JS number (2^53), so bigint columns map to `number`.
const id = () => bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity();
const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => timestamptz('created_at').notNull().defaultNow();
const updatedAt = () => timestamptz('updated_at').notNull().defaultNow();

export const issueState = pgEnum('issue_state', ISSUE_STATES);
export const issueRemovalReason = pgEnum('issue_removal_reason', ISSUE_REMOVAL_REASONS);
export const priority = pgEnum('priority', PRIORITIES);
export const suggestionStatus = pgEnum('suggestion_status', SUGGESTION_STATUSES);
export const reviewDecision = pgEnum('review_decision', REVIEW_DECISIONS);
export const webhookDeliveryOutcome = pgEnum('webhook_delivery_outcome', ['processed', 'ignored']);
export const triageJobStatus = pgEnum('triage_job_status', TRIAGE_JOB_STATUSES);
export const jobKind = pgEnum('job_kind', JOB_KINDS);

/**
 * Repositories we have received events for. Keyed internally by a surrogate id; `github_id` is
 * GitHub's stable id, which survives renames and transfers (unlike `full_name`).
 *
 * `labels` caches the repository's label set from the GitHub API: triage may only suggest these.
 */
export const repositories = pgTable(
  'repositories',
  {
    id: id(),
    githubId: bigint('github_id', { mode: 'number' }).notNull().unique(),
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    fullName: text('full_name').notNull(),
    private: boolean('private').notNull(),
    labels: jsonb('labels').$type<GitHubLabel[]>(),
    labelsFetchedAt: timestamptz('labels_fetched_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('repositories_full_name_idx').on(t.fullName)],
);

/**
 * Issues mirrored from GitHub. `github_updated_at` is GitHub's own timestamp and orders webhook
 * events, so a late or redelivered event never overwrites newer data.
 *
 * A deleted or transferred issue keeps its row with `removed_at` set, so a late event for it
 * cannot bring it back as a new issue.
 */
export const issues = pgTable(
  'issues',
  {
    id: id(),
    repositoryId: bigint('repository_id', { mode: 'number' })
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    githubId: bigint('github_id', { mode: 'number' }).notNull().unique(),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    state: issueState('state').notNull(),
    stateReason: text('state_reason'),
    labels: text('labels')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    authorLogin: text('author_login'),
    htmlUrl: text('html_url').notNull(),
    githubCreatedAt: timestamptz('github_created_at').notNull(),
    githubUpdatedAt: timestamptz('github_updated_at').notNull(),
    closedAt: timestamptz('closed_at'),
    removedAt: timestamptz('removed_at'),
    removalReason: issueRemovalReason('removal_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Also serves as the index for the repository_id foreign key.
    uniqueIndex('issues_repository_id_number_key').on(t.repositoryId, t.number),
    check('issues_removal_complete', sql`(${t.removedAt} is null) = (${t.removalReason} is null)`),
  ],
);

/**
 * The work queue: triage jobs, and write-back jobs that apply a review to GitHub. Workers claim
 * jobs with `FOR UPDATE SKIP LOCKED` and hold a lease while they run; a job whose lease expires
 * (its worker crashed or hung) can be claimed again. Every claim issues a fresh `lease_token`, and
 * a worker can only finish a job while it still holds the matching token, so a worker that lost
 * its lease can never overwrite the result of the next one.
 *
 * A write-back job is inserted in the transaction that records its review (`review_id`), so an
 * accepted review is never stored without the job that applies it: an outbox on this queue.
 */
export const triageJobs = pgTable(
  'triage_jobs',
  {
    id: id(),
    issueId: bigint('issue_id', { mode: 'number' })
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    kind: jobKind('kind').notNull().default('triage'),
    /** The review a write-back job applies. Set exactly for write-back jobs. */
    reviewId: bigint('review_id', { mode: 'number' }).references((): AnyPgColumn => reviews.id, {
      onDelete: 'cascade',
    }),
    status: triageJobStatus('status').notNull().default('pending'),
    /** How many times the job has been claimed, including the current run. */
    attempts: integer('attempts').notNull().default(0),
    /** A pending job is not claimed before this time. Backoff after a failure moves it forward. */
    runAfter: timestamptz('run_after').notNull().defaultNow(),
    leaseToken: uuid('lease_token'),
    /** Which worker holds the lease. For operators; correctness relies on `lease_token`. */
    lockedBy: text('locked_by'),
    lockedUntil: timestamptz('locked_until'),
    lastError: text('last_error'),
    /** What a finished write-back job changed on GitHub. */
    result: jsonb('result').$type<WriteBackResult>(),
    finishedAt: timestamptz('finished_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // At most one pending triage job per issue: enqueueing again while one waits is a no-op, and
    // the waiting job reads the latest issue text when it runs.
    uniqueIndex('triage_jobs_one_pending_per_issue_key')
      .on(t.issueId)
      .where(sql`${t.status} = 'pending' and ${t.kind} = 'triage'`),
    // One write-back job per review, ever: retries reuse the job instead of adding another.
    uniqueIndex('triage_jobs_review_id_key').on(t.reviewId),
    // The two ways a job becomes claimable: pending and due, or running with an expired lease.
    index('triage_jobs_pending_run_after_idx')
      .on(t.runAfter)
      .where(sql`${t.status} = 'pending'`),
    index('triage_jobs_running_locked_until_idx')
      .on(t.lockedUntil)
      .where(sql`${t.status} = 'running'`),
    // Also serves the issue_id foreign key.
    index('triage_jobs_issue_id_idx').on(t.issueId),
    check('triage_jobs_attempts_non_negative', sql`${t.attempts} >= 0`),
    check(
      'triage_jobs_write_back_has_review',
      sql`(${t.kind} = 'write_back') = (${t.reviewId} is not null)`,
    ),
    check(
      'triage_jobs_running_has_lease',
      sql`(${t.status} = 'running') = (${t.leaseToken} is not null and ${t.lockedUntil} is not null)`,
    ),
  ],
);

const confidence = (name: string) => real(name).notNull();
const confidenceRange = (column: AnyPgColumn) =>
  check(`triage_suggestions_${column.name}_range`, sql`${column} between 0 and 1`);

/**
 * Model output for an issue, awaiting human review. Written by the triage worker. Each judgement
 * (labels, priority, duplicates) carries the model's confidence and a one-sentence rationale for
 * the reviewer. `model`, `prompt_version`, token usage, and latency let evals compare prompt
 * versions and models on cost as well as quality.
 */
export const triageSuggestions = pgTable(
  'triage_suggestions',
  {
    id: id(),
    issueId: bigint('issue_id', { mode: 'number' })
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    status: suggestionStatus('status').notNull().default('pending'),
    summary: text('summary').notNull(),
    labels: text('labels').array().notNull(),
    labelsConfidence: confidence('labels_confidence'),
    labelsRationale: text('labels_rationale').notNull(),
    priority: priority('priority').notNull(),
    priorityConfidence: confidence('priority_confidence'),
    priorityRationale: text('priority_rationale').notNull(),
    duplicates: jsonb('duplicates')
      .$type<DuplicateCandidate[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    duplicatesConfidence: confidence('duplicates_confidence'),
    duplicatesRationale: text('duplicates_rationale').notNull(),
    /** The model that answered, as reported by the provider (a fallback model, if one ran). */
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    cacheReadInputTokens: integer('cache_read_input_tokens').notNull(),
    cacheCreationInputTokens: integer('cache_creation_input_tokens').notNull(),
    /** 2 when the first output failed validation and the model corrected it. */
    modelCalls: integer('model_calls').notNull(),
    latencyMs: integer('latency_ms').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('triage_suggestions_issue_id_created_at_idx').on(t.issueId, t.createdAt),
    // The review queue reads pending suggestions oldest first; keep that index small.
    index('triage_suggestions_pending_created_at_idx')
      .on(t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    // A newer suggestion supersedes the pending one, so reviewers see one per issue.
    uniqueIndex('triage_suggestions_one_pending_per_issue_key')
      .on(t.issueId)
      .where(sql`${t.status} = 'pending'`),
    confidenceRange(t.labelsConfidence),
    confidenceRange(t.priorityConfidence),
    confidenceRange(t.duplicatesConfidence),
  ],
);

/**
 * A reviewer's decision on a suggestion. `labels` and `priority` are what the reviewer settled on
 * (null for a rejection): the ground truth evals compare suggestions against.
 *
 * `labels_added` and `labels_removed` are the change to write to GitHub, worked out against the
 * issue's labels when the review was made. Storing the change rather than a final label set means
 * the write-back never undoes a label someone else changed on GitHub in the meantime, and a label
 * is only ever removed because the reviewer removed it.
 */
export const reviews = pgTable('reviews', {
  id: id(),
  suggestionId: bigint('suggestion_id', { mode: 'number' })
    .notNull()
    .unique()
    .references(() => triageSuggestions.id, { onDelete: 'cascade' }),
  decision: reviewDecision('decision').notNull(),
  labels: text('labels').array(),
  priority: priority('priority'),
  labelsAdded: text('labels_added')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  labelsRemoved: text('labels_removed')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  note: text('note'),
  /** Who reviewed. Until sign-in exists (roadmap: auth), every review is by `local`. */
  reviewerLogin: text('reviewer_login').notNull(),
  createdAt: createdAt(),
});

/**
 * Every verified webhook delivery, keyed by GitHub's `X-GitHub-Delivery` id. Inserting the row
 * and applying the event happen in one transaction, which makes redeliveries no-ops.
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    deliveryId: text('delivery_id').primaryKey(),
    event: text('event').notNull(),
    action: text('action'),
    outcome: webhookDeliveryOutcome('outcome').notNull(),
    receivedAt: timestamptz('received_at').notNull().defaultNow(),
  },
  (t) => [index('webhook_deliveries_received_at_idx').on(t.receivedAt)],
);
