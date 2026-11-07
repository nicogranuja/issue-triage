/**
 * The eval fixture format: one JSON file per repository, with the repository's labels, a pool of
 * existing issues (what the duplicate pre-filter searches), and labeled cases. The hand-written
 * fixtures in `evals/fixtures/` describe fictional repositories; every issue in them was written
 * for this project.
 *
 * Ground truth per case: the labels a maintainer would apply (from the repository's own set), a
 * priority, which pool issues it duplicates, and a reference summary with the key points a good
 * summary must cover. `notes` say why, where a reasonable maintainer might disagree.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ISSUE_STATES, PRIORITIES } from '@issue-triage/shared';
import { z } from 'zod';

import { EXCERPT_CHARS, rankBySimilarity } from '../src/triage/duplicates.js';
import type { TriageInput } from '../src/triage/model.js';

/** What a case exercises. Hard cases carry one of the tags after `no-label`. */
export const CASE_TAGS = [
  'bug',
  'feature',
  'question',
  'docs',
  'security',
  'performance',
  'crash',
  'no-label',
  'ambiguous',
  'multi-label',
  'injection',
  'duplicate',
  'near-duplicate',
  'very-short',
  'very-long',
  'non-english',
  'no-matching-label',
] as const;

const labelSchema = z.object({ name: z.string().min(1), description: z.string().nullable() });

const issueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1),
  body: z.string().nullable(),
});

const poolIssueSchema = issueSchema.extend({ state: z.enum(ISSUE_STATES) });

const caseSchema = z.object({
  id: z.string().regex(/^[a-z]+-\d{2,}$/),
  tags: z.array(z.enum(CASE_TAGS)).min(1),
  issue: issueSchema,
  expected: z.object({
    labels: z.array(z.string()),
    priority: z.enum(PRIORITIES),
    /** Pool issues this one duplicates. Null when unknown (exported cases). */
    duplicates: z.array(z.number().int()).nullable(),
    /** Null when there is no reference (exported cases): the summary is then not judged. */
    summary: z
      .object({ reference: z.string().min(1), keyPoints: z.array(z.string().min(1)).min(1) })
      .nullable(),
  }),
  /**
   * What text in the issue (or in a candidate) tries to make the triage do. Following any of it
   * where it differs from the ground truth counts as obeying the injection.
   */
  injection: z
    .object({
      labels: z.array(z.string()).optional(),
      priority: z.enum(PRIORITIES).optional(),
      duplicates: z.array(z.number().int()).optional(),
      /** A summary the text demands verbatim. */
      summary: z.string().optional(),
    })
    .optional(),
  notes: z.string().optional(),
});

export const fixtureSchema = z
  .object({
    repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    description: z.string(),
    source: z.enum(['hand-written', 'exported-reviews']),
    labels: z.array(labelSchema),
    pool: z.array(poolIssueSchema),
    cases: z.array(caseSchema).min(1),
  })
  .superRefine((fixture, ctx) => {
    const labels = new Set(fixture.labels.map((label) => label.name));
    const pool = new Set(fixture.pool.map((issue) => issue.number));
    const numbers = [...fixture.pool, ...fixture.cases.map((c) => c.issue)].map((i) => i.number);
    if (new Set(numbers).size !== numbers.length) {
      ctx.addIssue({ code: 'custom', message: 'issue numbers must be unique in a repository' });
    }
    fixture.cases.forEach((c, index) => {
      const path = ['cases', index];
      for (const label of c.expected.labels) {
        if (!labels.has(label)) {
          ctx.addIssue({ code: 'custom', path, message: `${c.id}: unknown label ${label}` });
        }
      }
      for (const number of [...(c.expected.duplicates ?? []), ...(c.injection?.duplicates ?? [])]) {
        if (!pool.has(number)) {
          ctx.addIssue({ code: 'custom', path, message: `${c.id}: #${number} is not in the pool` });
        }
      }
    });
  });

export type Fixture = z.infer<typeof fixtureSchema>;
export type EvalCase = Fixture['cases'][number];
export type CaseTag = (typeof CASE_TAGS)[number];

export const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));

/** Loads and validates every `*.json` fixture in a directory, sorted by file name. */
export function loadFixtures(dir: string = FIXTURES_DIR): Fixture[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const parsed = fixtureSchema.safeParse(JSON.parse(readFileSync(`${dir}/${name}`, 'utf8')));
      if (!parsed.success) {
        throw new Error(`Invalid fixture ${name}:\n${z.prettifyError(parsed.error)}`);
      }
      return parsed.data;
    });
}

/** Candidates per case, as the worker would pick them: the same pre-filter and limits. */
export function candidatesFor(fixture: Fixture, evalCase: EvalCase) {
  return rankBySimilarity(evalCase.issue, fixture.pool).map(({ doc, score }) => ({
    number: doc.number,
    title: doc.title,
    state: doc.state,
    excerpt: (doc.body ?? '').slice(0, EXCERPT_CHARS),
    score,
  }));
}

/** The model input for a case: exactly what the triage worker would send for this issue. */
export function triageInputFor(fixture: Fixture, evalCase: EvalCase): TriageInput {
  return {
    repository: fixture.repository,
    issue: evalCase.issue,
    labels: fixture.labels,
    candidates: candidatesFor(fixture, evalCase).map(({ number, title, state, excerpt }) => ({
      number,
      title,
      state,
      excerpt,
    })),
  };
}
