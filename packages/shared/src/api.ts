import { z } from 'zod';

import {
  ISSUE_STATES,
  PRIORITIES,
  REVIEW_DECISIONS,
  SUGGESTION_STATUSES,
  TRIAGE_JOB_STATUSES,
} from './domain.js';

/*
 * The HTTP contract between the API and the web app. The API validates requests with these
 * schemas and the web app validates responses with them, so a change on one side that the other
 * does not expect fails loudly in tests instead of rendering wrong data.
 */

/** Response body of `GET /healthz`, a liveness check. */
export const healthResponseSchema = z.object({
  status: z.literal('ok'),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** Body of every error response. */
export const errorResponseSchema = z.object({ error: z.string() });
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

const timestamp = z.iso.datetime({ offset: true });
const labelName = z.string().min(1).max(100);
const confidence = z.number().min(0).max(1);

/**
 * Confidence bands for filtering the queue. A suggestion's confidence is the lower of its label
 * and priority confidences: a suggestion is only as sure as its least sure part.
 */
export const CONFIDENCE_BANDS = ['high', 'medium', 'low'] as const;
export type ConfidenceBand = (typeof CONFIDENCE_BANDS)[number];
/** Lower bound (inclusive) of each band; each band ends where the next one up begins. */
export const CONFIDENCE_BAND_FLOORS: Record<ConfidenceBand, number> = {
  high: 0.8,
  medium: 0.5,
  low: 0,
};

export function confidenceBand(value: number): ConfidenceBand {
  if (value >= CONFIDENCE_BAND_FLOORS.high) {
    return 'high';
  }
  return value >= CONFIDENCE_BAND_FLOORS.medium ? 'medium' : 'low';
}

/** A comma-separated list in a query string, such as `priority=urgent,high`. */
function commaList<const T extends readonly [string, ...string[]]>(values: T) {
  return z
    .string()
    .max(200)
    .transform((value) => value.split(',').filter((part) => part.length > 0))
    .pipe(z.array(z.enum(values)).min(1));
}

/** Query string of `GET /api/queue`. */
export const queueQuerySchema = z.object({
  /** `owner/name`. */
  repo: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'must be owner/name')
    .optional(),
  priority: commaList(PRIORITIES).optional(),
  confidence: commaList(CONFIDENCE_BANDS).optional(),
  /** Opaque; the `nextCursor` of the previous page. */
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type QueueQuery = z.input<typeof queueQuerySchema>;

/** The filters a reviewer can set on the queue. */
export interface QueueFilters {
  repo?: string | undefined;
  priority?: (typeof PRIORITIES)[number] | undefined;
  confidence?: ConfidenceBand | undefined;
}

export const queueItemSchema = z.object({
  suggestionId: z.number().int(),
  repository: z.object({ fullName: z.string() }),
  issue: z.object({
    id: z.number().int(),
    number: z.number().int(),
    title: z.string(),
    htmlUrl: z.string(),
    labels: z.array(z.string()),
    /** When the issue was opened on GitHub. */
    openedAt: timestamp,
  }),
  /** Suggested labels. */
  labels: z.array(z.string()),
  priority: z.enum(PRIORITIES),
  confidence,
  createdAt: timestamp,
});
export type QueueItem = z.infer<typeof queueItemSchema>;

/** Response body of `GET /api/queue`: urgent first, then oldest first. */
export const queueResponseSchema = z.object({
  items: z.array(queueItemSchema),
  /** Pass as `cursor` for the next page; null on the last page. */
  nextCursor: z.string().nullable(),
  /** Suggestions matching the filters, across all pages. */
  total: z.number().int(),
});
export type QueueResponse = z.infer<typeof queueResponseSchema>;

/** Response body of `GET /api/repositories`: repositories with something to review, for filters. */
export const repositoriesResponseSchema = z.object({
  repositories: z.array(z.object({ fullName: z.string(), pending: z.number().int() })),
});
export type RepositoriesResponse = z.infer<typeof repositoriesResponseSchema>;

export const repositoryLabelSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  color: z.string(),
});
export type RepositoryLabel = z.infer<typeof repositoryLabelSchema>;

export const writeBackResultSchema = z.object({
  added: z.array(z.string()),
  removed: z.array(z.string()),
  skipped: z.array(z.string()),
  dryRun: z.boolean(),
});

/** Where a review's write-back job is. */
export const writeBackStatusSchema = z.object({
  jobId: z.number().int(),
  status: z.enum(TRIAGE_JOB_STATUSES),
  /** When the job is due (pending) or was last scheduled. Undo works until then. */
  runAfter: timestamp,
  attempts: z.number().int(),
  /** Untrusted text: it can quote GitHub's error messages. Render as plain text. */
  lastError: z.string().nullable(),
  result: writeBackResultSchema.nullable(),
  finishedAt: timestamp.nullable(),
});
export type WriteBackStatus = z.infer<typeof writeBackStatusSchema>;

export const reviewSchema = z.object({
  id: z.number().int(),
  suggestionId: z.number().int(),
  decision: z.enum(REVIEW_DECISIONS),
  labels: z.array(z.string()).nullable(),
  priority: z.enum(PRIORITIES).nullable(),
  labelsAdded: z.array(z.string()),
  labelsRemoved: z.array(z.string()),
  note: z.string().nullable(),
  reviewerLogin: z.string(),
  createdAt: timestamp,
  /** Null when there was nothing to write (a rejection, or no label change). */
  writeBack: writeBackStatusSchema.nullable(),
});
export type Review = z.infer<typeof reviewSchema>;

/**
 * Response body of `GET /api/suggestions/:id`. Every string that came from GitHub or the model
 * (titles, body, summary, rationales, reasons) is untrusted and must be rendered as plain text.
 */
export const suggestionDetailSchema = z.object({
  id: z.number().int(),
  status: z.enum(SUGGESTION_STATUSES),
  /** The issue's pending suggestion when it is not this one (this one is out of date). */
  newerSuggestionId: z.number().int().nullable(),
  createdAt: timestamp,
  model: z.string(),
  promptVersion: z.string(),
  summary: z.string(),
  labels: z.object({ names: z.array(z.string()), confidence, rationale: z.string() }),
  priority: z.object({ level: z.enum(PRIORITIES), confidence, rationale: z.string() }),
  duplicates: z.object({
    issues: z.array(
      z.object({
        issueId: z.number().int(),
        number: z.number().int(),
        title: z.string(),
        state: z.enum(ISSUE_STATES),
        htmlUrl: z.string(),
        reason: z.string(),
      }),
    ),
    confidence,
    rationale: z.string(),
  }),
  issue: z.object({
    id: z.number().int(),
    number: z.number().int(),
    title: z.string(),
    body: z.string().nullable(),
    state: z.enum(ISSUE_STATES),
    removed: z.boolean(),
    htmlUrl: z.string(),
    labels: z.array(z.string()),
    authorLogin: z.string().nullable(),
    githubCreatedAt: timestamp,
  }),
  repository: z.object({
    fullName: z.string(),
    /** The repository's labels, as last fetched from GitHub; null if never fetched. */
    labels: z.array(repositoryLabelSchema).nullable(),
  }),
  /** Which label each priority writes to GitHub. Unmapped priorities are not written. */
  priorityLabels: z.partialRecord(z.enum(PRIORITIES), z.string()),
  review: reviewSchema.nullable(),
});
export type SuggestionDetail = z.infer<typeof suggestionDetailSchema>;

const noteSchema = z.string().trim().max(2000);

/**
 * Body of `POST /api/suggestions/:id/review`. `accept` applies the suggestion as it is; `edit`
 * applies the reviewer's labels and priority (the labels are the full set the issue should have,
 * so an unticked label from `baseLabels` is removed); `reject` records the decision and writes
 * nothing.
 */
export const reviewRequestSchema = z.discriminatedUnion('decision', [
  z.strictObject({ decision: z.literal('accept'), note: noteSchema.optional() }),
  z
    .strictObject({
      decision: z.literal('edit'),
      labels: z.array(labelName).max(100).optional(),
      /**
       * The issue's labels as the reviewer saw them; required with `labels`. Only these can be
       * removed, so a label added on GitHub while the reviewer was editing survives.
       */
      baseLabels: z.array(labelName).max(100).optional(),
      priority: z.enum(PRIORITIES).optional(),
      note: noteSchema.optional(),
    })
    .refine((edit) => (edit.labels === undefined) === (edit.baseLabels === undefined), {
      message: 'labels and baseLabels go together',
      path: ['baseLabels'],
    }),
  z.strictObject({ decision: z.literal('reject'), note: noteSchema.optional() }),
]);
export type ReviewRequest = z.input<typeof reviewRequestSchema>;

/** Response body of a successful review or undo. */
export const reviewResponseSchema = z.object({ review: reviewSchema });
export type ReviewResponse = z.infer<typeof reviewResponseSchema>;

/** Why a review (or an undo) was refused with 409. */
export const CONFLICT_CODES = [
  /** Someone already reviewed this suggestion. */
  'already_reviewed',
  /** A newer suggestion replaced this one, for example because the issue was edited. */
  'superseded',
  /** The issue was closed, deleted, or transferred. */
  'issue_closed',
  /** Undo: the write-back already started, so the labels may be on GitHub. */
  'write_back_started',
] as const;
export type ConflictCode = (typeof CONFLICT_CODES)[number];

/** Body of a 409 response. */
export const conflictResponseSchema = z.object({
  error: z.string(),
  code: z.enum(CONFLICT_CODES),
  /** The issue's current pending suggestion, if there is one to review instead. */
  currentSuggestionId: z.number().int().nullable(),
});
export type ConflictResponse = z.infer<typeof conflictResponseSchema>;

/** Response body of `GET /api/reviews`: the most recent reviews, newest first. */
export const recentReviewsResponseSchema = z.object({
  items: z.array(
    z.object({
      review: reviewSchema,
      repository: z.object({ fullName: z.string() }),
      issue: z.object({ number: z.number().int(), title: z.string(), htmlUrl: z.string() }),
    }),
  ),
});
export type RecentReviewsResponse = z.infer<typeof recentReviewsResponseSchema>;
