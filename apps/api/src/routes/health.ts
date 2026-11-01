import type { HealthResponse } from '@issue-triage/shared';
import type { FastifyPluginAsync } from 'fastify';

/** Liveness check: answers as long as the process can serve requests. */
export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/healthz', async (): Promise<HealthResponse> => ({ status: 'ok' }));
};
