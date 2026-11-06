import {
  queueQuerySchema,
  reviewRequestSchema,
  type ConflictResponse,
  type ErrorResponse,
  type PriorityLabels,
} from '@issue-triage/shared';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';

import type { Database } from '../db/client.js';
import {
  getSuggestionDetail,
  InvalidCursorError,
  listQueue,
  listRecentReviews,
  listRepositories,
} from './queries.js';
import {
  ReviewConflictError,
  ReviewNotFoundError,
  submitReview,
  undoReview,
  UnknownLabelsError,
} from './service.js';

export interface ReviewRoutesOptions {
  db: Database;
  priorityLabels: PriorityLabels;
  writeBackDelayMs: number;
}

const idParamsSchema = z.object({
  id: z.coerce
    .number()
    .int()
    .positive()
    .max(2 ** 53 - 1),
});
const recentQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** A short description of what failed validation, safe to return to the caller. */
function describeProblems(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join('.')}: ` : '') + issue.message)
    .join('; ');
}

function parse<T extends z.ZodType>(
  schema: T,
  value: unknown,
  reply: FastifyReply,
  what: string,
): z.output<T> | null {
  const result = schema.safeParse(value);
  if (!result.success) {
    void reply
      .code(400)
      .send({
        error: `Invalid ${what}: ${describeProblems(result.error)}`,
      } satisfies ErrorResponse);
    return null;
  }
  return result.data;
}

function sendReviewError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ReviewConflictError) {
    return reply.code(409).send({
      error: error.message,
      code: error.code,
      currentSuggestionId: error.currentSuggestionId,
    } satisfies ConflictResponse);
  }
  if (error instanceof ReviewNotFoundError) {
    return reply.code(404).send({ error: error.message } satisfies ErrorResponse);
  }
  if (error instanceof UnknownLabelsError) {
    return reply.code(422).send({ error: error.message } satisfies ErrorResponse);
  }
  throw error;
}

/**
 * The review API under `/api`: the queue, one suggestion in detail, and reviews.
 *
 * It has no authentication yet, so the server listens on 127.0.0.1 by default; sign-in is on
 * the roadmap. Requests that change data must be JSON (or carry no body): a cross-site form can
 * only send form encodings or text/plain, and a cross-site `fetch` with JSON or DELETE needs a
 * CORS preflight this API never grants.
 */
export const reviewRoutes: FastifyPluginAsync<ReviewRoutesOptions> = async (
  app,
  { db, priorityLabels, writeBackDelayMs },
) => {
  app.addHook('preValidation', async (request, reply) => {
    if (request.method !== 'POST') {
      return;
    }
    const type = request.headers['content-type'] ?? '';
    if (!/^application\/json\s*(;|$)/i.test(type)) {
      return reply
        .code(415)
        .send({ error: 'Send the request body as application/json' } satisfies ErrorResponse);
    }
  });

  app.get('/api/queue', async (request, reply) => {
    const query = parse(queueQuerySchema, request.query, reply, 'query');
    if (!query) {
      return reply;
    }
    try {
      return await listQueue(db, query);
    } catch (error) {
      if (error instanceof InvalidCursorError) {
        return reply.code(400).send({ error: error.message } satisfies ErrorResponse);
      }
      throw error;
    }
  });

  app.get('/api/repositories', async () => listRepositories(db));

  app.get('/api/reviews', async (request, reply) => {
    const query = parse(recentQuerySchema, request.query, reply, 'query');
    return query ? listRecentReviews(db, query.limit) : reply;
  });

  app.get('/api/suggestions/:id', async (request, reply) => {
    const params = parse(idParamsSchema, request.params, reply, 'suggestion id');
    if (!params) {
      return reply;
    }
    const detail = await getSuggestionDetail(db, params.id, priorityLabels);
    if (!detail) {
      return reply.code(404).send({ error: `No suggestion ${params.id}` } satisfies ErrorResponse);
    }
    return detail;
  });

  app.post('/api/suggestions/:id/review', async (request, reply) => {
    const params = parse(idParamsSchema, request.params, reply, 'suggestion id');
    const body = params && parse(reviewRequestSchema, request.body, reply, 'review');
    if (!params || !body) {
      return reply;
    }
    try {
      const review = await submitReview(db, params.id, body, { priorityLabels, writeBackDelayMs });
      request.log.info(
        { suggestionId: params.id, decision: review.decision, writeBack: review.writeBack?.jobId },
        'suggestion reviewed',
      );
      return { review };
    } catch (error) {
      return sendReviewError(reply, error);
    }
  });

  app.delete('/api/suggestions/:id/review', async (request, reply) => {
    const params = parse(idParamsSchema, request.params, reply, 'suggestion id');
    if (!params) {
      return reply;
    }
    try {
      await undoReview(db, params.id);
      request.log.info({ suggestionId: params.id }, 'review undone');
      return await reply.code(204).send();
    } catch (error) {
      return sendReviewError(reply, error);
    }
  });
};
