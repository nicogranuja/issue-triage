import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';

import type { Config } from './config.js';
import type { Database } from './db/client.js';
import { reviewRoutes } from './review/routes.js';
import { healthRoutes } from './routes/health.js';
import { githubWebhookRoutes } from './webhooks/routes.js';

export interface AppDependencies {
  config: Config;
  db: Database;
  logger: FastifyBaseLogger;
}

/** Builds the HTTP app without listening, so tests can drive it with `app.inject()`. */
export async function buildApp({ config, db, logger }: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({ loggerInstance: logger });

  // Log server-side failures with full detail, but never leak internals to the caller.
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      request.log.error({ err: error }, 'request failed');
      return reply.code(500).send({ error: 'Internal Server Error' });
    }
    return reply.code(statusCode).send({ error: error.message });
  });

  await app.register(healthRoutes);
  await app.register(githubWebhookRoutes, { db, secret: config.github.webhookSecret });
  await app.register(reviewRoutes, {
    db,
    priorityLabels: config.review.priorityLabels,
    writeBackDelayMs: config.review.writeBackDelayMs,
  });
  return app;
}
