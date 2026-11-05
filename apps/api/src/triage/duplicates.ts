import type { IssueState } from '@issue-triage/shared';
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { issues } from '../db/schema.js';

/**
 * Picks the few existing issues most likely to be duplicates of a new one, so the model compares
 * against a handful of candidates instead of the whole repository.
 *
 * Method: TF-IDF weighted token overlap (cosine similarity) on titles and bodies, computed in
 * TypeScript over the repository's most recent issues. Title words count double, and the inverse
 * document frequency comes from that same pool, so words every issue in the repository uses
 * ("error", "version", template headings) carry little weight on their own.
 *
 * Trade-offs, and why this one:
 * - It is a recall filter, not the decision. The model sees the candidates and decides, so a few
 *   false positives here cost a few prompt tokens; a missed duplicate costs a missed suggestion.
 * - Postgres trigram similarity (`pg_trgm`) would scale to the full history with a GIN index,
 *   but needs an extension, and trigram scores on long bodies are noisy. Full-text search ranks
 *   by matching all query terms, which suits search boxes better than "how much do these overlap".
 * - Embeddings would also catch paraphrases ("crash" vs "panic"), but need an embedding call per
 *   issue and a vector index. Worth revisiting if evals show missed duplicates.
 * - The cost: only the most recent `poolSize` issues are compared, so a duplicate of a very old
 *   issue in a very busy repository can be missed. The pool query reads one bounded page of rows,
 *   with bodies truncated, so the work per job stays constant as the repository grows.
 */

export interface SimilarityDocument {
  title: string;
  body: string | null;
}

export interface DuplicateCandidateIssue {
  issueId: number;
  number: number;
  title: string;
  state: IssueState;
  /** The start of the issue body, for the prompt. */
  excerpt: string;
  /** Cosine similarity to the new issue, between 0 and 1. */
  score: number;
}

export interface DuplicateSearchOptions {
  /** How many candidates to return at most. */
  limit?: number;
  /** Candidates scoring below this are not worth the model's attention. */
  minScore?: number;
  /** How many of the repository's most recent issues to compare against. */
  poolSize?: number;
}

const DEFAULTS = { limit: 5, minScore: 0.15, poolSize: 500 } satisfies DuplicateSearchOptions;

/** Characters of each body compared; enough to capture the problem statement. */
const BODY_CHARS = 2000;
const EXCERPT_CHARS = 300;
const TITLE_WEIGHT = 2;

// Common English function words. Domain words are left to IDF, which learns them per repository.
const STOPWORDS = new Set(
  `a about after all also am an and any are as at be been before being but by can could did do
  does doing for from had has have having he her here him his how i if in into is it its just me
  more most my no not now of off on once only or other our out over own same she should so some
  such than that the their them then there these they this those through to too under until up
  very was we were what when where which while who why will with would you your`.split(/\s+/),
);

/** Lowercased word and number tokens, without stopwords and very short numbers. */
export function tokenize(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token) && !/^\d{1,2}$/.test(token));
}

function termCounts(doc: SimilarityDocument): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (tokens: string[], weight: number) => {
    for (const token of tokens) {
      counts.set(token, (counts.get(token) ?? 0) + weight);
    }
  };
  add(tokenize(doc.title), TITLE_WEIGHT);
  add(tokenize((doc.body ?? '').slice(0, BODY_CHARS)), 1);
  return counts;
}

/**
 * Scores every document in `pool` against `query` and returns the best matches, most similar
 * first (ties broken by pool order). Pure and deterministic, so it is easy to test and tune.
 */
export function rankBySimilarity<T extends SimilarityDocument>(
  query: SimilarityDocument,
  pool: readonly T[],
  { limit = DEFAULTS.limit, minScore = DEFAULTS.minScore }: DuplicateSearchOptions = {},
): { doc: T; score: number }[] {
  const queryCounts = termCounts(query);
  if (queryCounts.size === 0 || pool.length === 0) {
    return [];
  }
  const entries = pool.map((doc) => ({ doc, counts: termCounts(doc) }));

  // Smoothed IDF over the pool plus the query itself.
  const documentFrequency = new Map<string, number>();
  for (const counts of [queryCounts, ...entries.map((entry) => entry.counts)]) {
    for (const token of counts.keys()) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  const documents = pool.length + 1;
  const idf = (token: string) =>
    Math.log((documents + 1) / ((documentFrequency.get(token) ?? 0) + 1)) + 1;

  // Sublinear term frequency, so one word repeated in a long log does not dominate.
  const vector = (counts: Map<string, number>) => {
    const weights = new Map<string, number>();
    let norm = 0;
    for (const [token, count] of counts) {
      const weight = (1 + Math.log(count)) * idf(token);
      weights.set(token, weight);
      norm += weight * weight;
    }
    return { weights, norm: Math.sqrt(norm) };
  };

  const q = vector(queryCounts);
  const scored = entries.map(({ doc, counts }, index) => {
    const d = vector(counts);
    let dot = 0;
    for (const [token, weight] of q.weights) {
      dot += weight * (d.weights.get(token) ?? 0);
    }
    const score = d.norm === 0 ? 0 : dot / (q.norm * d.norm);
    return { doc, index, score };
  });

  return scored
    .filter(({ score }) => score >= minScore)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ doc, score }) => ({ doc, score }));
}

/**
 * Finds likely duplicates of an issue among the other issues of its repository, open or closed
 * (a duplicate of a fixed issue is worth knowing about). Removed issues are skipped.
 */
export async function findDuplicateCandidates(
  db: Database,
  issue: { id: number; repositoryId: number; title: string; body: string | null },
  options: DuplicateSearchOptions = {},
): Promise<DuplicateCandidateIssue[]> {
  const pool = await db
    .select({
      issueId: issues.id,
      number: issues.number,
      title: issues.title,
      state: issues.state,
      body: sql<string | null>`left(${issues.body}, ${BODY_CHARS})`,
    })
    .from(issues)
    .where(
      and(
        eq(issues.repositoryId, issue.repositoryId),
        ne(issues.id, issue.id),
        isNull(issues.removedAt),
      ),
    )
    .orderBy(desc(issues.githubCreatedAt), desc(issues.id))
    .limit(options.poolSize ?? DEFAULTS.poolSize);

  return rankBySimilarity(issue, pool, options).map(({ doc, score }) => ({
    issueId: doc.issueId,
    number: doc.number,
    title: doc.title,
    state: doc.state,
    excerpt: (doc.body ?? '').slice(0, EXCERPT_CHARS),
    score,
  }));
}
