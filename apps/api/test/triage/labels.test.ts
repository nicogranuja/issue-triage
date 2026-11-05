import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DatabaseHandle } from '../../src/db/client.js';
import { repositories } from '../../src/db/schema.js';
import { GitHubApiError, type GitHubClient, type GitHubLabel } from '../../src/github/client.js';
import { RepositoryLabelCache } from '../../src/triage/labels.js';
import { createMigratedTestDatabase } from '../helpers/database.js';
import { seedRepository } from '../helpers/seed.js';

const bug: GitHubLabel = { name: 'bug', description: "Something isn't working", color: 'd73a4a' };
const docs: GitHubLabel = { name: 'documentation', description: null, color: '0075ca' };

describe('RepositoryLabelCache', () => {
  let database: DatabaseHandle;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.db.execute(sql`truncate ${repositories} restart identity cascade`);
  });

  function setup(labels: GitHubLabel[] = [bug, docs]) {
    const listLabels = vi.fn<GitHubClient['listLabels']>(() => Promise.resolve(labels));
    return { listLabels, cache: new RepositoryLabelCache(database.db, { listLabels }) };
  }

  it('fetches the labels once and serves later jobs from the database', async () => {
    const repository = await seedRepository(database.db);
    const { listLabels, cache } = setup();

    expect(await cache.labelsFor(repository)).toEqual([bug, docs]);
    expect(await cache.labelsFor(repository)).toEqual([bug, docs]);

    expect(listLabels).toHaveBeenCalledTimes(1);
    expect(listLabels).toHaveBeenCalledWith('lumen-labs', 'lumen', {});
    const [row] = await database.db.select().from(repositories);
    expect(row?.labels).toEqual([bug, docs]);
    expect(row?.labelsFetchedAt).toBeInstanceOf(Date);
  });

  it('shares the cache across instances, as separate workers would', async () => {
    const repository = await seedRepository(database.db);
    await setup().cache.labelsFor(repository);
    const other = setup();

    await other.cache.labelsFor(repository);

    expect(other.listLabels).not.toHaveBeenCalled();
  });

  it('fetches again once the cached labels are older than the TTL', async () => {
    const repository = await seedRepository(database.db);
    const { listLabels, cache } = setup();
    await cache.labelsFor(repository);
    await database.db
      .update(repositories)
      .set({ labelsFetchedAt: sql`now() - interval '16 minutes'` })
      .where(eq(repositories.id, repository.id));

    await cache.labelsFor(repository);

    expect(listLabels).toHaveBeenCalledTimes(2);
  });

  it('keeps a cache per repository', async () => {
    const first = await seedRepository(database.db);
    const second = await seedRepository(database.db, { name: 'lumen-docs' });
    const { listLabels, cache } = setup();

    await cache.labelsFor(first);
    await cache.labelsFor(second);

    expect(listLabels.mock.calls.map(([owner, repo]) => `${owner}/${repo}`)).toEqual([
      'lumen-labs/lumen',
      'lumen-labs/lumen-docs',
    ]);
  });

  it('caches an empty label set', async () => {
    const repository = await seedRepository(database.db);
    const { listLabels, cache } = setup([]);

    expect(await cache.labelsFor(repository)).toEqual([]);
    expect(await cache.labelsFor(repository)).toEqual([]);
    expect(listLabels).toHaveBeenCalledTimes(1);
  });

  it('does not fall back to stale labels when GitHub fails', async () => {
    const repository = await seedRepository(database.db);
    await setup().cache.labelsFor(repository);
    await database.db
      .update(repositories)
      .set({ labelsFetchedAt: sql`now() - interval '1 day'` })
      .where(eq(repositories.id, repository.id));
    const failure = new GitHubApiError(
      'GET /repos/lumen-labs/lumen/labels returned 503',
      503,
      true,
    );
    const cache = new RepositoryLabelCache(database.db, {
      listLabels: () => Promise.reject(failure),
    });

    await expect(cache.labelsFor(repository)).rejects.toBe(failure);
  });
});
