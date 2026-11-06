import { eq, sql } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { repositories } from '../db/schema.js';
import type { GitHubClient, GitHubLabel } from '../github/client.js';

/** How long a repository's label set is reused before it is fetched again. */
export const DEFAULT_LABEL_CACHE_TTL_MS = 15 * 60 * 1000;

export interface RepositoryRef {
  id: number;
  owner: string;
  name: string;
}

export interface LabelOptions {
  signal?: AbortSignal;
  /** Skip the cache and fetch from GitHub (refreshing the cache), for writes. */
  fresh?: boolean;
}

export interface LabelSource {
  labelsFor(repository: RepositoryRef, options?: LabelOptions): Promise<GitHubLabel[]>;
}

/**
 * The repository's label set, cached on the `repositories` row. Labels change rarely and every
 * triage job needs them, so one GitHub request serves every job in the repository for the TTL,
 * across all workers. Freshness is judged by the database clock, like the rest of the queue.
 *
 * A failed fetch is not papered over with stale labels: suggesting a label that was deleted would
 * recreate it when the suggestion is written back, so the job fails and retries instead. The
 * write-back itself always asks for `fresh` labels, since the cache can be minutes old.
 */
export class RepositoryLabelCache implements LabelSource {
  readonly #db: Database;
  readonly #github: Pick<GitHubClient, 'listLabels'>;
  readonly #ttlMs: number;

  constructor(
    db: Database,
    github: Pick<GitHubClient, 'listLabels'>,
    ttlMs: number = DEFAULT_LABEL_CACHE_TTL_MS,
  ) {
    this.#db = db;
    this.#github = github;
    this.#ttlMs = ttlMs;
  }

  async labelsFor(
    repository: RepositoryRef,
    { signal, fresh = false }: LabelOptions = {},
  ): Promise<GitHubLabel[]> {
    if (!fresh) {
      const cached = await this.#cached(repository);
      if (cached) {
        return cached;
      }
    }
    const labels = await this.#github.listLabels(
      repository.owner,
      repository.name,
      signal ? { signal } : {},
    );
    await this.#db
      .update(repositories)
      .set({ labels, labelsFetchedAt: sql`now()` })
      .where(eq(repositories.id, repository.id));
    return labels;
  }

  async #cached(repository: RepositoryRef): Promise<GitHubLabel[] | null> {
    const [cached] = await this.#db
      .select({
        labels: repositories.labels,
        fresh: sql<boolean>`${repositories.labelsFetchedAt} > now() - ${Math.ceil(this.#ttlMs)}::integer * interval '1 millisecond'`,
      })
      .from(repositories)
      .where(eq(repositories.id, repository.id));
    return cached?.labels && cached.fresh ? cached.labels : null;
  }
}
