import {
  ISSUE_STATES,
  PRIORITIES,
  REVIEW_DECISIONS,
  SUGGESTION_STATUSES,
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
} from 'drizzle-orm/pg-core';

// GitHub ids fit comfortably in a JS number (2^53), so bigint columns map to `number`.
const id = () => bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity();
const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => timestamptz('created_at').notNull().defaultNow();
const updatedAt = () => timestamptz('updated_at').notNull().defaultNow();

export const issueState = pgEnum('issue_state', ISSUE_STATES);
export const priority = pgEnum('priority', PRIORITIES);
export const suggestionStatus = pgEnum('suggestion_status', SUGGESTION_STATUSES);
export const reviewDecision = pgEnum('review_decision', REVIEW_DECISIONS);
export const webhookDeliveryOutcome = pgEnum('webhook_delivery_outcome', ['processed', 'ignored']);

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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  // Also serves as the index for the repository_id foreign key.
  (t) => [uniqueIndex('issues_repository_id_number_key').on(t.repositoryId, t.number)],
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
