import {
  ISSUE_REMOVAL_REASONS,
  ISSUE_STATES,
  PRIORITIES,
  REVIEW_DECISIONS,
  SUGGESTION_STATUSES,
  TRIAGE_JOB_STATUSES,
  type DuplicateCandidate,
} from '@issue-triage/shared';
import { sql } from 'drizzle-orm';
import {
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

/**
 * Repositories we have received events for. Keyed internally by a surrogate id; `github_id` is
 * GitHub's stable id, which survives renames and transfers (unlike `full_name`).
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
 * The triage work queue. Workers claim jobs with `FOR UPDATE SKIP LOCKED` and hold a lease while
 * they run; a job whose lease expires (its worker crashed or hung) can be claimed again. Every
 * claim issues a fresh `lease_token`, and a worker can only finish a job while it still holds the
 * matching token, so a worker that lost its lease can never overwrite the result of the next one.
 */
export const triageJobs = pgTable(
  'triage_jobs',
  {
    id: id(),
    issueId: bigint('issue_id', { mode: 'number' })
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
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
    finishedAt: timestamptz('finished_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // At most one pending job per issue: enqueueing again while one waits is a no-op, and the
    // waiting job reads the latest issue text when it runs.
    uniqueIndex('triage_jobs_one_pending_per_issue_key')
      .on(t.issueId)
      .where(sql`${t.status} = 'pending'`),
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
      'triage_jobs_running_has_lease',
      sql`(${t.status} = 'running') = (${t.leaseToken} is not null and ${t.lockedUntil} is not null)`,
    ),
  ],
);

/** Model output for an issue, awaiting human review. Written by the triage engine. */
export const triageSuggestions = pgTable(
  'triage_suggestions',
  {
    id: id(),
    issueId: bigint('issue_id', { mode: 'number' })
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    status: suggestionStatus('status').notNull().default('pending'),
    labels: text('labels').array().notNull(),
    priority: priority('priority').notNull(),
    duplicates: jsonb('duplicates')
      .$type<DuplicateCandidate[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    summary: text('summary').notNull(),
    confidence: real('confidence').notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('triage_suggestions_issue_id_created_at_idx').on(t.issueId, t.createdAt),
    // The review queue reads pending suggestions oldest first; keep that index small.
    index('triage_suggestions_pending_created_at_idx')
      .on(t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    check('triage_suggestions_confidence_range', sql`${t.confidence} between 0 and 1`),
  ],
);

/** A reviewer's decision on a suggestion, and the labels and priority they settled on. */
export const reviews = pgTable('reviews', {
  id: id(),
  suggestionId: bigint('suggestion_id', { mode: 'number' })
    .notNull()
    .unique()
    .references(() => triageSuggestions.id, { onDelete: 'cascade' }),
  decision: reviewDecision('decision').notNull(),
  labels: text('labels').array(),
  priority: priority('priority'),
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
