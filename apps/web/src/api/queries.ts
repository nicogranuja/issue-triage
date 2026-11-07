import type {
  QueueFilters,
  QueueItem,
  QueueResponse,
  RecentReviewsResponse,
  Review,
  ReviewRequest,
  SuggestionDetail,
} from '@issue-triage/shared';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query';

import { api, type ApiError } from './client.ts';

export const queryKeys = {
  queue: (filters: QueueFilters) => ['queue', filters] as const,
  allQueues: ['queue'] as const,
  suggestion: (id: number) => ['suggestion', id] as const,
  repositories: ['repositories'] as const,
  reviews: ['reviews'] as const,
};

type QueuePages = InfiniteData<QueueResponse, string | undefined>;

/** The queue, a page at a time (keyset cursors), refreshed in the background. */
export function useQueue(filters: QueueFilters) {
  return useInfiniteQuery({
    queryKey: queryKeys.queue(filters),
    queryFn: ({ pageParam }) => api.queue(filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // New suggestions arrive as issues are triaged.
    refetchInterval: 30_000,
  });
}

export function useSuggestion(id: number | null) {
  return useQuery<SuggestionDetail, ApiError>({
    queryKey: queryKeys.suggestion(id ?? 0),
    queryFn: () => api.suggestion(id ?? 0),
    enabled: id !== null,
    staleTime: 30_000,
  });
}

/** Loads a suggestion before it is needed, so moving to it shows it at once. */
export function prefetchSuggestion(client: QueryClient, id: number): void {
  client
    .query({
      queryKey: queryKeys.suggestion(id),
      queryFn: () => api.suggestion(id),
      staleTime: 30_000,
    })
    .catch(() => undefined);
}

export function useRepositories() {
  return useQuery({
    queryKey: queryKeys.repositories,
    queryFn: api.repositories,
    staleTime: 60_000,
  });
}

function writeBackInFlight(data: RecentReviewsResponse | undefined): boolean {
  return (
    data?.items.some(({ review }) =>
      ['pending', 'running'].includes(review.writeBack?.status ?? ''),
    ) ?? false
  );
}

/** Recent reviews; polled quickly while a write-back is still on its way to GitHub. */
export function useRecentReviews({ enabled }: { enabled: boolean }) {
  return useQuery({
    queryKey: queryKeys.reviews,
    queryFn: api.recentReviews,
    enabled,
    refetchInterval: (query) => (writeBackInFlight(query.state.data) ? 2_000 : 30_000),
  });
}

/** Where a suggestion sat in one cached queue, so a failed review can put it back there. */
interface Position {
  page: number;
  index: number;
  item: QueueItem;
}

function findPosition(data: QueuePages | undefined, id: number): Position | null {
  for (const [page, { items }] of (data?.pages ?? []).entries()) {
    const index = items.findIndex((item) => item.suggestionId === id);
    const item = items[index];
    if (item) {
      return { page, index, item };
    }
  }
  return null;
}

function withoutSuggestion(data: QueuePages, id: number): QueuePages {
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.filter((item) => item.suggestionId !== id),
      total: Math.max(0, page.total - 1),
    })),
  };
}

function withSuggestionAt(data: QueuePages, { page, index, item }: Position): QueuePages {
  if (findPosition(data, item.suggestionId)) {
    return data;
  }
  return {
    ...data,
    pages: data.pages.map((current, pageIndex) => ({
      ...current,
      items: pageIndex === page ? current.items.toSpliced(index, 0, item) : current.items,
      total: current.total + 1,
    })),
  };
}

const REVIEW_MUTATION = ['review'] as const;

export interface ReviewVariables {
  suggestionId: number;
  issueNumber: number;
  request: ReviewRequest;
}

interface ReviewContext {
  positions: [QueryKey, Position][];
}

/**
 * Submits a review optimistically: the suggestion leaves every cached queue at once, and if the
 * API refuses or fails, it goes back exactly where it was. Only that suggestion is put back, so
 * other reviews still in flight stay out. Either way the queue is refetched afterwards, so it
 * ends up matching the server.
 */
export function useReviewMutation({
  onSuccess,
  onError,
}: {
  onSuccess: (review: Review, variables: ReviewVariables) => void;
  onError: (error: ApiError, variables: ReviewVariables) => void;
}) {
  const client = useQueryClient();
  return useMutation<Review, ApiError, ReviewVariables, ReviewContext>({
    mutationKey: REVIEW_MUTATION,
    mutationFn: ({ suggestionId, request }) => api.review(suggestionId, request),
    onMutate: async ({ suggestionId }) => {
      // A refetch landing now would put the item back before the review is saved.
      await client.cancelQueries({ queryKey: queryKeys.allQueues });
      const positions: [QueryKey, Position][] = [];
      for (const [key, data] of client.getQueriesData<QueuePages>({
        queryKey: queryKeys.allQueues,
      })) {
        const position = findPosition(data, suggestionId);
        if (data && position) {
          positions.push([key, position]);
          client.setQueryData<QueuePages>(key, withoutSuggestion(data, suggestionId));
        }
      }
      return { positions };
    },
    onError: (error, variables, context) => {
      for (const [key, position] of context?.positions ?? []) {
        client.setQueryData<QueuePages>(key, (data) =>
          data ? withSuggestionAt(data, position) : data,
        );
      }
      onError(error, variables);
    },
    onSuccess,
    onSettled: (_review, _error, { suggestionId }) => {
      void client.invalidateQueries({ queryKey: queryKeys.suggestion(suggestionId) });
      // Refetching the queue while another review is still on its way would bring that one
      // back; the last review to settle refetches for all of them. (This one still counts.)
      if (client.isMutating({ mutationKey: REVIEW_MUTATION }) > 1) {
        return;
      }
      void client.invalidateQueries({ queryKey: queryKeys.allQueues });
      void client.invalidateQueries({ queryKey: queryKeys.repositories });
      void client.invalidateQueries({ queryKey: queryKeys.reviews });
    },
  });
}

/** Takes back a review while its write-back hasn't started. */
export function useUndoMutation({
  onSuccess,
  onError,
}: {
  onSuccess: (suggestionId: number) => void;
  onError: (error: ApiError) => void;
}) {
  const client = useQueryClient();
  return useMutation<undefined, ApiError, number>({
    mutationFn: (suggestionId) => api.undo(suggestionId),
    onSuccess: async (_result, suggestionId) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.allQueues }),
        client.invalidateQueries({ queryKey: queryKeys.suggestion(suggestionId) }),
        client.invalidateQueries({ queryKey: queryKeys.repositories }),
        client.invalidateQueries({ queryKey: queryKeys.reviews }),
      ]);
      onSuccess(suggestionId);
    },
    onError,
  });
}
