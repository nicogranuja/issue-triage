/**
 * Turns stored reviews into eval cases: `npm run eval -- export-reviews`.
 *
 * A reviewer's labels and priority (`reviews.labels`, `reviews.priority`) are the ground truth the
 * suggestion is judged against, so a reviewed issue can become a case:
 *
 * - gold labels: the review's labels that are in the repository's label set (as last fetched),
 *   minus the labels that stand for a priority (`PRIORITY_LABELS`): those are the priority, which
 *   is scored on its own;
 * - gold priority: the review's;
 * - duplicates and the reference summary: unknown (null). A review doesn't record which
 *   duplicates were right or what a good summary would say, so exported cases are left out of
 *   duplicate metrics and aren't judged.
 *
 * Rejected reviews have no labels or priority and are skipped, and so are repositories whose
 * label set was never fetched. With several reviews of one issue (re-triage), the latest wins.
 * The other issues of the repository become the pool the duplicate pre-filter searches.
 *
 * The bias: an accepted review is the model's own answer, confirmed. A reviewer anchors on what
 * they're shown, so these cases favor the model (and prompt) that produced the suggestions, and
 * comparing that model against another on them is not a fair comparison. Each case's notes say
 * which model and prompt version it came from, and whether the review accepted or edited.
 */
import { labelKey, type PriorityLabels } from '@issue-triage/shared';
import { and, desc, eq, isNull, ne } from 'drizzle-orm';

import type { Database } from '../src/db/client.js';
import { issues, repositories, reviews, triageSuggestions } from '../src/db/schema.js';
import { fixtureSchema, type Fixture } from './cases.js';

export const EXPORT_BIAS_NOTE =
  'Exported from human reviews. Accepted reviews favor the model and prompt that produced them ' +
  '(the reviewer saw its answer first), so these cases are biased toward it; duplicates and ' +
  'summaries are unknown.';

export interface ExportResult {
  fixtures: Fixture[];
  /** Reviews left out, and why. */
  skipped: { reviewId: number; reason: string }[];
}

export async function exportReviewedCases(
  db: Database,
  { priorityLabels = {} }: { priorityLabels?: PriorityLabels } = {},
): Promise<ExportResult> {
  const rows = await db
    .select({
      reviewId: reviews.id,
      decision: reviews.decision,
      labels: reviews.labels,
      priority: reviews.priority,
      createdAt: reviews.createdAt,
      model: triageSuggestions.model,
      promptVersion: triageSuggestions.promptVersion,
      issueId: issues.id,
      number: issues.number,
      title: issues.title,
      body: issues.body,
      repositoryId: repositories.id,
      fullName: repositories.fullName,
      repositoryLabels: repositories.labels,
    })
    .from(reviews)
    .innerJoin(triageSuggestions, eq(reviews.suggestionId, triageSuggestions.id))
    .innerJoin(issues, eq(triageSuggestions.issueId, issues.id))
    .innerJoin(repositories, eq(issues.repositoryId, repositories.id))
    .where(and(ne(reviews.decision, 'rejected'), isNull(issues.removedAt)))
    .orderBy(desc(reviews.createdAt), desc(reviews.id));

  const skipped: ExportResult['skipped'] = [];
  const latest = new Map<number, (typeof rows)[number]>();
  for (const row of rows) {
    if (latest.has(row.issueId)) {
      skipped.push({ reviewId: row.reviewId, reason: 'a later review of the same issue' });
      continue;
    }
    latest.set(row.issueId, row);
  }

  const priorityKeys = new Set(Object.values(priorityLabels).map(labelKey));
  const byRepository = new Map<number, (typeof rows)[number][]>();
  for (const row of latest.values()) {
    if (row.labels === null || row.priority === null) {
      skipped.push({ reviewId: row.reviewId, reason: 'no labels or priority on the review' });
      continue;
    }
    if (!row.repositoryLabels) {
      skipped.push({
        reviewId: row.reviewId,
        reason: "the repository's labels were never fetched",
      });
      continue;
    }
    byRepository.set(row.repositoryId, [...(byRepository.get(row.repositoryId) ?? []), row]);
  }

  const fixtures: Fixture[] = [];
  for (const [repositoryId, cases] of byRepository) {
    const first = cases[0];
    if (!first?.repositoryLabels) {
      continue;
    }
    const labelSet = first.repositoryLabels.map(({ name, description }) => ({ name, description }));
    const spelling = new Map(labelSet.map((label) => [labelKey(label.name), label.name]));
    const pool = await db
      .select({
        number: issues.number,
        title: issues.title,
        body: issues.body,
        state: issues.state,
      })
      .from(issues)
      .where(and(eq(issues.repositoryId, repositoryId), isNull(issues.removedAt)))
      .orderBy(issues.number);
    const caseNumbers = new Set(cases.map((c) => c.number));
    const sorted = [...cases].sort((a, b) => a.number - b.number);
    const fixture = fixtureSchema.parse({
      repository: first.fullName,
      description: EXPORT_BIAS_NOTE,
      source: 'exported-reviews',
      labels: labelSet,
      pool: pool.filter((issue) => !caseNumbers.has(issue.number)),
      cases: sorted.map((row) => {
        const gold = [
          ...new Set(
            (row.labels ?? [])
              .map((name) => spelling.get(labelKey(name)))
              .filter((name): name is string => name !== undefined)
              .filter((name) => !priorityKeys.has(labelKey(name))),
          ),
        ];
        return {
          id: `review-${String(row.reviewId).padStart(2, '0')}`,
          tags: ['exported'],
          issue: { number: row.number, title: row.title, body: row.body },
          expected: {
            labels: gold,
            priority: row.priority,
            duplicates: null,
            summary: null,
          },
          notes:
            `From review ${row.reviewId} (${row.decision}) of a suggestion by ${row.model} ` +
            `(${row.promptVersion}).`,
        };
      }),
    });
    fixtures.push(fixture);
  }
  fixtures.sort((a, b) => a.repository.localeCompare(b.repository));
  return { fixtures, skipped };
}
