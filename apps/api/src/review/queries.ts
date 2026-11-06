import {
  CONFIDENCE_BAND_FLOORS,
  PRIORITIES,
  type ConfidenceBand,
  type Priority,
  type PriorityLabels,
  type QueueItem,
  type QueueResponse,
  type RecentReviewsResponse,
  type RepositoriesResponse,
  type Review,
  type ReviewDecision,
  type SuggestionDetail,
  type TriageJobStatus,
  type WriteBackResult,
} from '@issue-triage/shared';
import { and, asc, count, desc, eq, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import type { Database, Transaction } from '../db/client.js';
import { issues, repositories, reviews, triageJobs, triageSuggestions } from '../db/schema.js';

type Executor = Database | Transaction;

/**
 * A suggestion's confidence, for filtering: the lower of its label and priority confidences.
 * (Duplicate confidence says how likely duplicates are, not how sure the triage is.)
 */
const overallConfidence = sql<number>`least(${triageSuggestions.labelsConfidence}, ${triageSuggestions.priorityConfidence})`;

/** A suggestion is in the review queue while it is pending and its issue is open and present. */
const inQueue = and(
  eq(triageSuggestions.status, 'pending'),
  eq(issues.state, 'open'),
  isNull(issues.removedAt),
);

/** Where each band ends (exclusive): at the floor of the band above it. */
const CONFIDENCE_BAND_CEILINGS: Record<ConfidenceBand, number | null> = {
  high: null,
  medium: CONFIDENCE_BAND_FLOORS.high,
  low: CONFIDENCE_BAND_FLOORS.medium,
};

function confidenceIn(bands: readonly ConfidenceBand[]): SQL | undefined {
  return or(
    ...bands.map((band) => {
      const floor = sql`${overallConfidence} >= ${CONFIDENCE_BAND_FLOORS[band]}`;
      const ceiling = CONFIDENCE_BAND_CEILINGS[band];
      return ceiling === null ? floor : sql`(${floor} and ${overallConfidence} < ${ceiling})`;
    }),
  );
}

/**
 * The queue is ordered by priority (the enum's order: urgent first), then by suggestion id, which
 * grows with creation time. Pages are cut by keyset, not offset: the cursor is the last row's
 * (priority, id), so reviews that remove rows mid-way never make the next page skip or repeat
 * one. Ids rather than timestamps keep the key exact (timestamps have microseconds that a JS
 * Date would round away).
 */
const cursorSchema = z.tuple([z.enum(PRIORITIES), z.number().int().positive()]);
type Cursor = z.infer<typeof cursorSchema>;

export class InvalidCursorError extends Error {
  override readonly name = 'InvalidCursorError';
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeCursor(value: string): Cursor {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
  } catch {
    throw new InvalidCursorError('Invalid cursor');
  }
}

export interface QueueOptions {
  repo?: string | undefined;
  priority?: readonly Priority[] | undefined;
  confidence?: readonly ConfidenceBand[] | undefined;
  cursor?: string | undefined;
  limit: number;
}

export async function listQueue(db: Executor, options: QueueOptions): Promise<QueueResponse> {
  const filters = and(
    inQueue,
    options.repo === undefined ? undefined : eq(repositories.fullName, options.repo),
    options.priority === undefined
      ? undefined
      : inArray(triageSuggestions.priority, [...options.priority]),
    options.confidence === undefined ? undefined : confidenceIn(options.confidence),
  );
  const after = options.cursor === undefined ? null : decodeCursor(options.cursor);

  const rows = await db
    .select({
      suggestionId: triageSuggestions.id,
      fullName: repositories.fullName,
      issueId: issues.id,
      number: issues.number,
      title: issues.title,
      htmlUrl: issues.htmlUrl,
      issueLabels: issues.labels,
      labels: triageSuggestions.labels,
      priority: triageSuggestions.priority,
      confidence: overallConfidence.mapWith(Number),
      createdAt: triageSuggestions.createdAt,
    })
    .from(triageSuggestions)
    .innerJoin(issues, eq(issues.id, triageSuggestions.issueId))
    .innerJoin(repositories, eq(repositories.id, issues.repositoryId))
    .where(
      and(
        filters,
        after === null
          ? undefined
          : sql`(${triageSuggestions.priority}, ${triageSuggestions.id}) > (${after[0]}::priority, ${after[1]})`,
      ),
    )
    .orderBy(asc(triageSuggestions.priority), asc(triageSuggestions.id))
    .limit(options.limit + 1);

  const [totals] = await db
    .select({ total: count() })
    .from(triageSuggestions)
    .innerJoin(issues, eq(issues.id, triageSuggestions.issueId))
    .innerJoin(repositories, eq(repositories.id, issues.repositoryId))
    .where(filters);

  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  const items = page.map((row): QueueItem => ({
    suggestionId: row.suggestionId,
    repository: { fullName: row.fullName },
    issue: {
      id: row.issueId,
      number: row.number,
      title: row.title,
      htmlUrl: row.htmlUrl,
      labels: row.issueLabels,
    },
    labels: row.labels,
    priority: row.priority,
    confidence: row.confidence,
    createdAt: row.createdAt.toISOString(),
  }));
  return {
    items,
    nextCursor:
      rows.length > options.limit && last ? encodeCursor([last.priority, last.suggestionId]) : null,
    total: totals?.total ?? 0,
  };
}

/** Every repository, with how many suggestions in it await review. */
export async function listRepositories(db: Executor): Promise<RepositoriesResponse> {
  const rows = await db
    .select({
      fullName: repositories.fullName,
      pending: sql<number>`count(${triageSuggestions.id})`.mapWith(Number),
    })
    .from(repositories)
    .leftJoin(issues, eq(issues.repositoryId, repositories.id))
    .leftJoin(triageSuggestions, and(eq(triageSuggestions.issueId, issues.id), inQueue))
    .groupBy(repositories.id, repositories.fullName)
    .orderBy(asc(repositories.fullName));
  return { repositories: rows };
}

const reviewColumns = {
  id: reviews.id,
  suggestionId: reviews.suggestionId,
  decision: reviews.decision,
  labels: reviews.labels,
  priority: reviews.priority,
  labelsAdded: reviews.labelsAdded,
  labelsRemoved: reviews.labelsRemoved,
  note: reviews.note,
  reviewerLogin: reviews.reviewerLogin,
  createdAt: reviews.createdAt,
  jobId: triageJobs.id,
  jobStatus: triageJobs.status,
  jobRunAfter: triageJobs.runAfter,
  jobAttempts: triageJobs.attempts,
  jobLastError: triageJobs.lastError,
  jobResult: triageJobs.result,
  jobFinishedAt: triageJobs.finishedAt,
};

interface ReviewRow {
  id: number;
  suggestionId: number;
  decision: ReviewDecision;
  labels: string[] | null;
  priority: Priority | null;
  labelsAdded: string[];
  labelsRemoved: string[];
  note: string | null;
  reviewerLogin: string;
  createdAt: Date;
  // From the left-joined write-back job: all null when the review has none.
  jobId: number | null;
  jobStatus: TriageJobStatus | null;
  jobRunAfter: Date | null;
  jobAttempts: number | null;
  jobLastError: string | null;
  jobResult: WriteBackResult | null;
  jobFinishedAt: Date | null;
}

function toReview(row: ReviewRow): Review {
  return {
    id: row.id,
    suggestionId: row.suggestionId,
    decision: row.decision,
    labels: row.labels,
    priority: row.priority,
    labelsAdded: row.labelsAdded,
    labelsRemoved: row.labelsRemoved,
    note: row.note,
    reviewerLogin: row.reviewerLogin,
    createdAt: row.createdAt.toISOString(),
    writeBack:
      row.jobId === null ||
      row.jobStatus === null ||
      row.jobRunAfter === null ||
      row.jobAttempts === null
        ? null
        : {
            jobId: row.jobId,
            status: row.jobStatus,
            runAfter: row.jobRunAfter.toISOString(),
            attempts: row.jobAttempts,
            lastError: row.jobLastError,
            result: row.jobResult,
            finishedAt: row.jobFinishedAt?.toISOString() ?? null,
          },
  };
}

/** The review of a suggestion, with the state of its write-back, or null if not reviewed. */
export async function findReview(db: Executor, suggestionId: number): Promise<Review | null> {
  const [row] = await db
    .select(reviewColumns)
    .from(reviews)
    .leftJoin(triageJobs, eq(triageJobs.reviewId, reviews.id))
    .where(eq(reviews.suggestionId, suggestionId));
  return row ? toReview(row) : null;
}

/** The most recent reviews, newest first, with their write-back state. */
export async function listRecentReviews(
  db: Executor,
  limit: number,
): Promise<RecentReviewsResponse> {
  const rows = await db
    .select({
      ...reviewColumns,
      fullName: repositories.fullName,
      number: issues.number,
      title: issues.title,
      htmlUrl: issues.htmlUrl,
    })
    .from(reviews)
    .innerJoin(triageSuggestions, eq(triageSuggestions.id, reviews.suggestionId))
    .innerJoin(issues, eq(issues.id, triageSuggestions.issueId))
    .innerJoin(repositories, eq(repositories.id, issues.repositoryId))
    .leftJoin(triageJobs, eq(triageJobs.reviewId, reviews.id))
    .orderBy(desc(reviews.id))
    .limit(limit);
  return {
    items: rows.map((row) => ({
      review: toReview(row),
      repository: { fullName: row.fullName },
      issue: { number: row.number, title: row.title, htmlUrl: row.htmlUrl },
    })),
  };
}

/** The issue's pending suggestion, other than `exceptId`, if it has one. */
export async function findPendingSuggestionId(
  db: Executor,
  issueId: number,
  exceptId: number,
): Promise<number | null> {
  const [row] = await db
    .select({ id: triageSuggestions.id })
    .from(triageSuggestions)
    .where(
      and(
        eq(triageSuggestions.issueId, issueId),
        eq(triageSuggestions.status, 'pending'),
        ne(triageSuggestions.id, exceptId),
      ),
    );
  return row?.id ?? null;
}

/** Everything the reviewer needs to decide on one suggestion, or null if there is no such id. */
export async function getSuggestionDetail(
  db: Executor,
  suggestionId: number,
  priorityLabels: PriorityLabels,
): Promise<SuggestionDetail | null> {
  const [row] = await db
    .select({
      suggestion: triageSuggestions,
      issue: issues,
      fullName: repositories.fullName,
      repositoryLabels: repositories.labels,
    })
    .from(triageSuggestions)
    .innerJoin(issues, eq(issues.id, triageSuggestions.issueId))
    .innerJoin(repositories, eq(repositories.id, issues.repositoryId))
    .where(eq(triageSuggestions.id, suggestionId));
  if (!row) {
    return null;
  }
  const { suggestion, issue } = row;

  // Duplicates are stored as internal issue ids; show them with their number and title, in the
  // model's order. One that has since been deleted from GitHub is left out.
  const duplicateIds = suggestion.duplicates.map((duplicate) => duplicate.issueId);
  const duplicateRows =
    duplicateIds.length === 0
      ? []
      : await db
          .select({
            id: issues.id,
            number: issues.number,
            title: issues.title,
            state: issues.state,
            htmlUrl: issues.htmlUrl,
          })
          .from(issues)
          .where(and(inArray(issues.id, duplicateIds), isNull(issues.removedAt)));
  const duplicateById = new Map(duplicateRows.map((duplicate) => [duplicate.id, duplicate]));

  return {
    id: suggestion.id,
    status: suggestion.status,
    newerSuggestionId:
      suggestion.status === 'pending'
        ? null
        : await findPendingSuggestionId(db, issue.id, suggestion.id),
    createdAt: suggestion.createdAt.toISOString(),
    model: suggestion.model,
    promptVersion: suggestion.promptVersion,
    summary: suggestion.summary,
    labels: {
      names: suggestion.labels,
      confidence: suggestion.labelsConfidence,
      rationale: suggestion.labelsRationale,
    },
    priority: {
      level: suggestion.priority,
      confidence: suggestion.priorityConfidence,
      rationale: suggestion.priorityRationale,
    },
    duplicates: {
      issues: suggestion.duplicates.flatMap(({ issueId, reason }) => {
        const duplicate = duplicateById.get(issueId);
        return duplicate
          ? [
              {
                issueId,
                number: duplicate.number,
                title: duplicate.title,
                state: duplicate.state,
                htmlUrl: duplicate.htmlUrl,
                reason,
              },
            ]
          : [];
      }),
      confidence: suggestion.duplicatesConfidence,
      rationale: suggestion.duplicatesRationale,
    },
    issue: {
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      removed: issue.removedAt !== null,
      htmlUrl: issue.htmlUrl,
      labels: issue.labels,
      authorLogin: issue.authorLogin,
      githubCreatedAt: issue.githubCreatedAt.toISOString(),
    },
    repository: {
      fullName: row.fullName,
      labels:
        row.repositoryLabels?.map(({ name, description, color }) => ({
          name,
          description,
          color,
        })) ?? null,
    },
    priorityLabels,
    review: await findReview(db, suggestion.id),
  };
}
