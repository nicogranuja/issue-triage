import { eq, sql } from 'drizzle-orm';

import type { Transaction } from '../db/client.js';
import { repositories } from '../db/schema.js';
import type { LabelEvent } from './payloads.js';

/** Log context for a handled `label` event. */
export interface LabelEventResult {
  /** False when the repository isn't one we track yet: there is no cache to refresh. */
  cacheInvalidated: boolean;
}

/**
 * Marks the repository's cached label set as stale after a label was created, edited, or
 * deleted on GitHub. The next triage job then fetches the set again, so it neither suggests a
 * label that was just deleted nor misses one that was just created, instead of waiting out the
 * cache's 15 minutes. The cached labels themselves stay until then: the review UI still shows
 * them, and the write-back always re-reads the set from GitHub before it changes anything.
 */
export async function applyLabelEvent(
  tx: Transaction,
  event: LabelEvent,
): Promise<LabelEventResult> {
  const updated = await tx
    .update(repositories)
    .set({ labelsFetchedAt: null, updatedAt: sql`now()` })
    .where(eq(repositories.githubId, event.repository.id))
    .returning({ id: repositories.id });
  return { cacheInvalidated: updated.length > 0 };
}
