import {
  conflictResponseSchema,
  errorResponseSchema,
  queueResponseSchema,
  recentReviewsResponseSchema,
  repositoriesResponseSchema,
  reviewResponseSchema,
  suggestionDetailSchema,
  type ConflictResponse,
  type QueueFilters,
  type QueueResponse,
  type RecentReviewsResponse,
  type RepositoriesResponse,
  type Review,
  type ReviewRequest,
  type SuggestionDetail,
} from '@issue-triage/shared';
import type { z } from 'zod';

/** A failed API call, with a message fit to show the reviewer. */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  /** HTTP status, or 0 when the API could not be reached. */
  readonly status: number;
  /** Set on a 409: why the suggestion could not be reviewed as it is. */
  readonly conflict: ConflictResponse | undefined;

  constructor(status: number, message: string, conflict?: ConflictResponse) {
    super(message);
    this.status = status;
    this.conflict = conflict;
  }
}

async function request<T>(schema: z.ZodType<T> | null, path: string, init?: RequestInit) {
  let response: Response;
  try {
    const headers = new Headers(init?.headers);
    headers.set('accept', 'application/json');
    response = await fetch(path, { ...init, headers });
  } catch {
    throw new ApiError(0, 'Can’t reach the API. Is it running?');
  }

  const body: unknown = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const conflict = response.status === 409 ? conflictResponseSchema.safeParse(body) : null;
    if (conflict?.success) {
      throw new ApiError(409, conflict.data.error, conflict.data);
    }
    const error = errorResponseSchema.safeParse(body);
    throw new ApiError(
      response.status,
      error.success ? error.data.error : `The API answered ${response.status}`,
    );
  }
  if (schema === null) {
    return undefined as T;
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(response.status, 'The API sent a response this page doesn’t understand.');
  }
  return parsed.data;
}

function queueParams(filters: QueueFilters, cursor: string | undefined): string {
  const params = new URLSearchParams();
  if (filters.repo) {
    params.set('repo', filters.repo);
  }
  if (filters.priority) {
    params.set('priority', filters.priority);
  }
  if (filters.confidence) {
    params.set('confidence', filters.confidence);
  }
  if (cursor) {
    params.set('cursor', cursor);
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  queue: (filters: QueueFilters, cursor?: string): Promise<QueueResponse> =>
    request(queueResponseSchema, `/api/queue${queueParams(filters, cursor)}`),
  repositories: (): Promise<RepositoriesResponse> =>
    request(repositoriesResponseSchema, '/api/repositories'),
  suggestion: (id: number): Promise<SuggestionDetail> =>
    request(suggestionDetailSchema, `/api/suggestions/${id}`),
  recentReviews: (): Promise<RecentReviewsResponse> =>
    request(recentReviewsResponseSchema, '/api/reviews?limit=30'),
  review: async (id: number, body: ReviewRequest): Promise<Review> =>
    (await request(reviewResponseSchema, `/api/suggestions/${id}/review`, json(body))).review,
  undo: (id: number): Promise<undefined> =>
    request(null, `/api/suggestions/${id}/review`, { method: 'DELETE' }),
};
