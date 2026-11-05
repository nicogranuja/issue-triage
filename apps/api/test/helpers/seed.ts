import type { Database } from '../../src/db/client.js';
import { issues, repositories } from '../../src/db/schema.js';

type RepositoryRow = typeof repositories.$inferSelect;
type IssueRow = typeof issues.$inferSelect;

let githubIdCounter = 1_000_000;

/** Inserts a repository row, the way the webhook handler would have stored it. */
export async function seedRepository(
  db: Database,
  overrides: Partial<typeof repositories.$inferInsert> = {},
): Promise<RepositoryRow> {
  githubIdCounter += 1;
  const [row] = await db
    .insert(repositories)
    .values({
      githubId: githubIdCounter,
      owner: 'lumen-labs',
      name: 'lumen',
      fullName: 'lumen-labs/lumen',
      private: false,
      ...overrides,
    })
    .returning();
  if (!row) {
    throw new Error('Repository insert returned no row');
  }
  return row;
}

let issueNumberCounter = 0;

/** Inserts an open issue in the given repository. */
export async function seedIssue(
  db: Database,
  repositoryId: number,
  overrides: Partial<typeof issues.$inferInsert> = {},
): Promise<IssueRow> {
  githubIdCounter += 1;
  issueNumberCounter += 1;
  const number = overrides.number ?? issueNumberCounter;
  const now = new Date('2026-11-01T12:00:00Z');
  const [row] = await db
    .insert(issues)
    .values({
      repositoryId,
      githubId: githubIdCounter,
      number,
      title: `Issue ${number}`,
      body: null,
      state: 'open',
      htmlUrl: `https://github.com/lumen-labs/lumen/issues/${number}`,
      githubCreatedAt: now,
      githubUpdatedAt: now,
      ...overrides,
    })
    .returning();
  if (!row) {
    throw new Error('Issue insert returned no row');
  }
  return row;
}
