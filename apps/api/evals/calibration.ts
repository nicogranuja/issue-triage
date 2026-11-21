/**
 * The calibration set: summaries scored by hand on the judge's 1-5 anchors, and how far a judge
 * agrees with those scores.
 *
 * The files in `calibration/` are inputs, not results: hand scores with a note for each, written
 * against one rubric version (`rubric`). Each item names an eval case, and the judge sees that
 * case's issue and key points exactly as in a run, plus the item's summary. It never sees the
 * hand scores, the notes, the item's kind, or its id.
 *
 * Agreement is only meaningful for a real judge. The fake judge is a keyword rule: its figures
 * show that the plumbing works, nothing more.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { agreement, type Agreement } from './agreement.js';
import type { Fixture } from './cases.js';
import { JUDGE_CRITERIA, type JudgeCriterion } from './judge.js';
import type { JudgeItem, JudgeRun } from './judging.js';

export const CALIBRATION_FILE = fileURLToPath(
  new URL('./calibration/summaries-v1.json', import.meta.url),
);

/** Kinds of item. The known negatives must all be present (see the tests). */
export const CALIBRATION_KINDS = [
  'good',
  'empty',
  'dont-know',
  'wrong-issue',
  'unfaithful',
  'verbose',
  'incomplete',
  'overstated',
  'minor-imprecision',
  'missing-point',
  'invented-details',
  'some-filler',
  'copies-issue',
  'injection-echo',
] as const;

const handScore = z.object({
  score: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  note: z.string().min(10),
});

const itemSchema = z.object({
  id: z.string().regex(/^cal-\d{2,}$/),
  repository: z.string(),
  caseId: z.string(),
  kind: z.enum(CALIBRATION_KINDS),
  /** May be empty: an empty summary is one of the known negatives. */
  summary: z.string(),
  hand: z.object({ faithfulness: handScore, coverage: handScore, concision: handScore }).strict(),
});

export const calibrationSchema = z.object({
  version: z.string().min(1),
  /** The judge prompt version whose anchors the hand scores apply. */
  rubric: z.string().min(1),
  scoredBy: z.string().min(1),
  description: z.string().min(1),
  items: z.array(itemSchema).min(1),
});

export type CalibrationSet = z.infer<typeof calibrationSchema>;
export type CalibrationItem = CalibrationSet['items'][number];

/**
 * Loads and validates a calibration file against the eval fixtures: ids are unique, and every
 * item names a case that exists and has key points to judge coverage against.
 */
export function loadCalibration(
  fixtures: readonly Fixture[],
  path: string = CALIBRATION_FILE,
): CalibrationSet {
  const parsed = calibrationSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    throw new Error(`Invalid calibration file ${path}:\n${z.prettifyError(parsed.error)}`);
  }
  const set = parsed.data;
  const problems: string[] = [];
  const ids = set.items.map((item) => item.id);
  if (new Set(ids).size !== ids.length) {
    problems.push('item ids must be unique');
  }
  for (const item of set.items) {
    const evalCase = fixtures
      .find((fixture) => fixture.repository === item.repository)
      ?.cases.find((c) => c.id === item.caseId);
    if (!evalCase) {
      problems.push(`${item.id}: no case ${item.repository}/${item.caseId}`);
    } else if (!evalCase.expected.summary) {
      problems.push(`${item.id}: case ${item.caseId} has no key points to judge against`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`Invalid calibration file ${path}:\n${problems.join('\n')}`);
  }
  return set;
}

/** The judge input per item: the case's issue and key points, and the item's summary. */
export function calibrationItems(set: CalibrationSet, fixtures: readonly Fixture[]): JudgeItem[] {
  return set.items.map((item) => {
    const evalCase = fixtures
      .find((fixture) => fixture.repository === item.repository)
      ?.cases.find((c) => c.id === item.caseId);
    const reference = evalCase?.expected.summary;
    if (!evalCase || !reference) {
      throw new Error(`${item.id}: no case with key points (load with loadCalibration)`);
    }
    return {
      id: item.id,
      input: {
        issue: { title: evalCase.issue.title, body: evalCase.issue.body },
        keyPoints: reference.keyPoints,
        summary: item.summary,
      },
    };
  });
}

export interface CalibrationResult {
  version: string;
  rubric: string;
  scoredBy: string;
  items: number;
  /** Items the judge scored; failures and errors leave an item out of every figure. */
  judged: number;
  agreement: Record<JudgeCriterion, Agreement>;
  /** Per item, for reading the disagreements. */
  pairs: {
    id: string;
    kind: string;
    judge: Record<JudgeCriterion, number> | null;
    hand: Record<JudgeCriterion, number>;
  }[];
}

export function calibrationResult(set: CalibrationSet, run: JudgeRun): CalibrationResult {
  const verdicts = new Map(
    run.results.flatMap((result) =>
      result.outcome.status === 'judged' ? [[result.id, result.outcome.verdict] as const] : [],
    ),
  );
  const pairs = set.items.map((item) => {
    const verdict = verdicts.get(item.id);
    const scores = (pick: (criterion: JudgeCriterion) => number) =>
      Object.fromEntries(JUDGE_CRITERIA.map((c) => [c, pick(c)])) as Record<JudgeCriterion, number>;
    return {
      id: item.id,
      kind: item.kind,
      judge: verdict ? scores((c) => verdict[c].score) : null,
      hand: scores((c) => item.hand[c].score),
    };
  });
  const judged = pairs.filter((pair) => pair.judge !== null);
  return {
    version: set.version,
    rubric: set.rubric,
    scoredBy: set.scoredBy,
    items: set.items.length,
    judged: judged.length,
    agreement: Object.fromEntries(
      JUDGE_CRITERIA.map((criterion) => [
        criterion,
        agreement(
          judged.map((pair) => ({
            judge: pair.judge?.[criterion] ?? 0,
            hand: pair.hand[criterion],
          })),
        ),
      ]),
    ) as Record<JudgeCriterion, Agreement>,
    pairs,
  };
}
