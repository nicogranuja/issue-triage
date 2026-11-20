/**
 * Deterministic label and priority metrics over eval cases. Pure functions: they take what the
 * model predicted and the ground truth, and never call anything.
 *
 * Labels are compared by `labelKey` (GitHub label names are case-insensitive). A case with no
 * expected labels and no predicted ones counts as an exact match but adds nothing to precision or
 * recall, so "no label" cases are measured by the exact-set rate.
 */
import { labelKey, PRIORITIES, type Priority } from '@issue-triage/shared';

/** Precision, recall, and F1 from counts. Each is null when its denominator is 0. */
export interface PrecisionRecall {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export function precisionRecall(tp: number, fp: number, fn: number): PrecisionRecall {
  const precision = tp + fp === 0 ? null : tp / (tp + fp);
  const recall = tp + fn === 0 ? null : tp / (tp + fn);
  const f1 =
    precision === null || recall === null
      ? null
      : precision + recall === 0
        ? 0
        : (2 * precision * recall) / (precision + recall);
  return { truePositives: tp, falsePositives: fp, falseNegatives: fn, precision, recall, f1 };
}

export interface LabelOutcome {
  predicted: readonly string[];
  expected: readonly string[];
}

export interface LabelMetrics {
  cases: number;
  /** Counts summed over every label of every case. */
  micro: PrecisionRecall;
  /** By label key, sorted by key: every label that was expected or predicted at least once. */
  perLabel: Record<string, PrecisionRecall>;
  /** Share of cases whose predicted set equals the expected set exactly. Null with no cases. */
  exactSetMatch: number | null;
}

export function labelMetrics(outcomes: readonly LabelOutcome[]): LabelMetrics {
  const counts = new Map<string, { tp: number; fp: number; fn: number }>();
  const count = (key: string) => {
    let entry = counts.get(key);
    if (!entry) {
      entry = { tp: 0, fp: 0, fn: 0 };
      counts.set(key, entry);
    }
    return entry;
  };
  let exact = 0;
  for (const { predicted, expected } of outcomes) {
    const predictedKeys = new Set(predicted.map(labelKey));
    const expectedKeys = new Set(expected.map(labelKey));
    for (const key of predictedKeys) {
      if (expectedKeys.has(key)) {
        count(key).tp += 1;
      } else {
        count(key).fp += 1;
      }
    }
    for (const key of expectedKeys) {
      if (!predictedKeys.has(key)) {
        count(key).fn += 1;
      }
    }
    if (
      predictedKeys.size === expectedKeys.size &&
      [...predictedKeys].every((key) => expectedKeys.has(key))
    ) {
      exact += 1;
    }
  }
  let tp = 0;
  let fp = 0;
  let fn = 0;
  const perLabel: Record<string, PrecisionRecall> = {};
  for (const key of [...counts.keys()].sort()) {
    const entry = count(key);
    tp += entry.tp;
    fp += entry.fp;
    fn += entry.fn;
    perLabel[key] = precisionRecall(entry.tp, entry.fp, entry.fn);
  }
  return {
    cases: outcomes.length,
    micro: precisionRecall(tp, fp, fn),
    perLabel,
    exactSetMatch: outcomes.length === 0 ? null : exact / outcomes.length,
  };
}

export interface PriorityOutcome {
  predicted: Priority;
  expected: Priority;
}

export interface PriorityMetrics {
  cases: number;
  /** Null with no cases. */
  accuracy: number | null;
  /** Share of cases at most one level off (urgent/high, high/medium, medium/low). */
  withinOne: number | null;
  /** `confusion[expected][predicted]`: how many cases. Every level appears, most urgent first. */
  confusion: Record<Priority, Record<Priority, number>>;
  /**
   * What always answering the most common expected priority would score: the bar a model has to
   * clear. Ties go to the more urgent level. Null with no cases.
   */
  majorityBaseline: { level: Priority; accuracy: number } | null;
}

const rank = (level: Priority) => PRIORITIES.indexOf(level);

export function priorityMetrics(outcomes: readonly PriorityOutcome[]): PriorityMetrics {
  const row = () =>
    Object.fromEntries(PRIORITIES.map((level) => [level, 0])) as Record<Priority, number>;
  const confusion = Object.fromEntries(PRIORITIES.map((level) => [level, row()])) as Record<
    Priority,
    Record<Priority, number>
  >;
  const expectedCounts = row();
  let correct = 0;
  let withinOne = 0;
  for (const { predicted, expected } of outcomes) {
    confusion[expected][predicted] += 1;
    expectedCounts[expected] += 1;
    if (predicted === expected) {
      correct += 1;
    }
    if (Math.abs(rank(predicted) - rank(expected)) <= 1) {
      withinOne += 1;
    }
  }
  const n = outcomes.length;
  let majority: Priority = PRIORITIES[0];
  for (const level of PRIORITIES) {
    if (expectedCounts[level] > expectedCounts[majority]) {
      majority = level;
    }
  }
  return {
    cases: n,
    accuracy: n === 0 ? null : correct / n,
    withinOne: n === 0 ? null : withinOne / n,
    confusion,
    majorityBaseline: n === 0 ? null : { level: majority, accuracy: expectedCounts[majority] / n },
  };
}

export interface DuplicateOutcome {
  predicted: readonly number[];
  /** Null when the case's duplicates are unknown: the case is left out. */
  expected: readonly number[] | null;
  /** What the pre-filter offered the model. */
  candidates: readonly number[];
}

export interface DuplicateMetrics {
  /** Cases with known duplicates. */
  cases: number;
  /**
   * Over every true duplicate, offered or not: a duplicate the pre-filter missed counts against
   * recall, because the reviewer never sees it.
   */
  micro: PrecisionRecall;
  /**
   * Share of true duplicates the pre-filter offered as candidates: the ceiling on the model's
   * recall. Null when no case has a duplicate.
   */
  preFilterRecall: number | null;
}

export function duplicateMetrics(outcomes: readonly DuplicateOutcome[]): DuplicateMetrics {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let expectedTotal = 0;
  let offered = 0;
  let cases = 0;
  for (const { predicted, expected, candidates } of outcomes) {
    if (expected === null) {
      continue;
    }
    cases += 1;
    const truth = new Set(expected);
    const named = new Set(predicted);
    for (const number of named) {
      if (truth.has(number)) {
        tp += 1;
      } else {
        fp += 1;
      }
    }
    for (const number of truth) {
      expectedTotal += 1;
      if (!named.has(number)) {
        fn += 1;
      }
      if (candidates.includes(number)) {
        offered += 1;
      }
    }
  }
  return {
    cases,
    micro: precisionRecall(tp, fp, fn),
    preFilterRecall: expectedTotal === 0 ? null : offered / expectedTotal,
  };
}
