import type { Logger } from 'pino';

import type { ProcessConfig } from '../config.js';
import type { Database } from '../db/client.js';
import { GitHubClient } from '../github/client.js';
import { RepositoryLabelCache } from './labels.js';
import { createTriageModel } from './providers.js';
import { TriageWorker } from './worker.js';

/**
 * A job's deadline, in model timeouts: one for the first answer, one for a corrective turn, and
 * one to spare for a request the SDK had to retry.
 */
const MODEL_TIMEOUTS_PER_JOB = 3;

/** Builds and starts the triage worker, or returns null when this process should not run one. */
export async function startTriageWorker(
  config: ProcessConfig,
  db: Database,
  logger: Logger,
): Promise<TriageWorker | null> {
  if (config.worker.concurrency === 0) {
    logger.info('triage worker disabled (TRIAGE_WORKER_CONCURRENCY=0)');
    return null;
  }
  if (!config.github.token) {
    logger.warn(
      'GITHUB_TOKEN is not set: label lookups are unauthenticated (public repositories only, 60 requests per hour)',
    );
  }

  const model = await createTriageModel(config.triage);
  const github = new GitHubClient({ token: config.github.token });
  const worker = new TriageWorker({
    db,
    model,
    labels: new RepositoryLabelCache(db, github),
    logger: logger.child({ component: 'triage-worker' }),
    concurrency: config.worker.concurrency,
    maxAttempts: config.worker.maxAttempts,
    jobTimeoutMs: config.triage.modelTimeoutMs * MODEL_TIMEOUTS_PER_JOB,
  });
  logger.info(
    { provider: model.provider, model: model.modelId, effort: config.triage.effort },
    'triage model ready',
  );
  worker.start();
  return worker;
}
