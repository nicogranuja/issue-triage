/**
 * Reference points for eval results, as `TriageModel`s so a runner treats them like any model:
 *
 * - the oracle answers with the ground truth, so every metric should be perfect (a check that
 *   the runner and the metrics agree with the fixtures);
 * - the null model answers nothing: no labels, no duplicates, and the lowest priority, which is
 *   the floor a real model has to beat.
 *
 * The fake model's default keyword rules (`FakeTriageModel`) are the third, a keyword baseline.
 * The majority-class priority baseline is computed from the cases (see `priorityMetrics`).
 */
import { PRIORITIES } from '@issue-triage/shared';

import { FakeTriageModel } from '../src/triage/fake-model.js';
import type { TriageInput, TriageSuggestion } from '../src/triage/model.js';
import type { EvalCase, Fixture } from './cases.js';

const key = (repository: string, number: number) => `${repository}#${number}`;

/**
 * Answers each case with its expected labels, priority, duplicates (among the candidates), and
 * reference summary.
 */
export function oracleModel(fixtures: readonly Fixture[]): FakeTriageModel {
  const truth = new Map<string, EvalCase['expected']>();
  for (const fixture of fixtures) {
    for (const evalCase of fixture.cases) {
      truth.set(key(fixture.repository, evalCase.issue.number), evalCase.expected);
    }
  }
  return new FakeTriageModel({
    respond: (input: TriageInput): TriageSuggestion => {
      const expected = truth.get(key(input.repository, input.issue.number));
      if (!expected) {
        throw new Error(`The oracle has no case for ${key(input.repository, input.issue.number)}`);
      }
      const sure = { confidence: 1, rationale: 'Ground truth.' };
      return {
        summary: expected.summary?.reference ?? input.issue.title,
        labels: { ...sure, names: expected.labels },
        priority: { ...sure, level: expected.priority },
        duplicates: {
          ...sure,
          // Only those the pre-filter offered: no model can name the others, so the oracle is the
          // best score reachable with these candidates (the pre-filter's misses show as misses).
          issues: (expected.duplicates ?? [])
            .filter((number) => input.candidates.some((candidate) => candidate.number === number))
            .map((number) => ({ number, reason: 'Ground truth.' })),
        },
      };
    },
  });
}

/** Answers every case with nothing: no labels, the lowest priority, no duplicates. */
export function nullModel(): FakeTriageModel {
  const lowest = PRIORITIES[PRIORITIES.length - 1] ?? 'low';
  return new FakeTriageModel({
    respond: (input: TriageInput): TriageSuggestion => {
      const unsure = { confidence: 0, rationale: 'Null baseline.' };
      return {
        summary: input.issue.title,
        labels: { ...unsure, names: [] },
        priority: { ...unsure, level: lowest },
        duplicates: { ...unsure, issues: [] },
      };
    },
  });
}
