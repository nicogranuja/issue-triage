/**
 * Comparison mode: two configurations on the same cases, compared case by case.
 *
 * For each metric, every case gets a value under configuration A and under B; the reported
 * difference is B minus A over the cases both have a value for, with a seeded paired bootstrap
 * interval over cases (see `bootstrap.ts`). Case values follow the report's strict reading: a
 * refusal or invalid output predicted nothing, so it misses every expected label and duplicate
 * and gets the priority wrong. With several reps, a case's value is its mean over the reps that
 * were scored, and the bootstrap still resamples cases (the case is the unit, not the rep).
 *
 * What the intervals are not:
 *
 * - Evidence about real repositories. The cases are hand-written fixtures, not a sample of real
 *   issues; an interval says how much these cases would move if drawn again, nothing more.
 * - A significance test. No figure here is called significant. There is no correction for
 *   comparing many metrics at once: where there is no real difference, about one 95% interval in
 *   twenty still excludes 0.
 * - Trustworthy at small n: below `MIN_PAIRED_CASES` every metric carries a warning.
 */
import { labelKey } from '@issue-triage/shared';

import { mean, pairedBootstrap, type BootstrapOptions, type PairedInterval } from './bootstrap.js';
import type { Fixture } from './cases.js';
import { LOCAL_EVAL_PROVIDERS } from './guard.js';
import { JUDGE_CRITERIA } from './judge.js';
import type { JudgeRun } from './judging.js';
import { obeyedFields } from './metrics.js';
import type { PairTally, PairVerdict } from './pairwise.js';
import type { RunConfig, RunResult } from './runner.js';

/**
 * Below this many paired cases, every metric gets a small-n warning. Two reasons: with n cases one
 * case moves a rate by 1/n (more than 3 points below 30), and the percentile bootstrap's interval
 * is too narrow on small samples (it covers less than its nominal 95%), so it would overstate
 * what the data shows. 30 is the usual rule of thumb for when that undercoverage gets small; it
 * is a floor for reading the figure at all, not a guarantee above it.
 */
export const MIN_PAIRED_CASES = 30;

export const DEFAULT_BOOTSTRAP: BootstrapOptions = { seed: 0, resamples: 10_000, level: 0.95 };

/** Label counts for one case, for micro F1 over the resampled cases. */
interface Counts {
  tp: number;
  fp: number;
  fn: number;
}

/** One case's values under one configuration. Null where the case has no value for a metric. */
export interface CaseValues {
  labels: Counts;
  exactSet: number;
  priority: number;
  /** Null when the case's duplicates are unknown or it has none (recall has nothing to find). */
  duplicates: Counts | null;
  /** 1 resisted, 0 obeyed. Null when the case demands nothing testable or was never answered. */
  injection: number | null;
  /** Per criterion, the mean judge score. Absent without `--judge` or when nothing was judged. */
  judge?: Partial<Record<string, number>>;
}

const caseKey = (repository: string, caseId: string) => `${repository}/${caseId}`;

const sumCounts = (counts: readonly Counts[]): Counts =>
  counts.reduce((sum, c) => ({ tp: sum.tp + c.tp, fp: sum.fp + c.fp, fn: sum.fn + c.fn }), {
    tp: 0,
    fp: 0,
    fn: 0,
  });

const meanCounts = (counts: readonly Counts[]): Counts => {
  const sum = sumCounts(counts);
  const n = counts.length;
  return { tp: sum.tp / n, fp: sum.fp / n, fn: sum.fn / n };
};

/** Micro F1 over summed counts. Null when there is nothing to score (no positives at all). */
export function microF1(counts: readonly Counts[]): number | null {
  const { tp, fp, fn } = sumCounts(counts);
  return tp + fp + fn === 0 ? null : (2 * tp) / (2 * tp + fp + fn);
}

/** Micro recall over summed counts. Null when no case has a true positive to find. */
export function microRecall(counts: readonly Counts[]): number | null {
  const { tp, fn } = sumCounts(counts);
  return tp + fn === 0 ? null : tp / (tp + fn);
}

/** Every scored case's values for a run, keyed by `repository/caseId`. */
export function caseValues(
  run: RunResult,
  fixtures: readonly Fixture[],
  judged?: JudgeRun,
): Map<string, CaseValues> {
  const cases = new Map(
    fixtures.flatMap((f) => f.cases.map((c) => [caseKey(f.repository, c.id), c] as const)),
  );
  const reps = new Map<string, RunResult['results']>();
  for (const result of run.results) {
    const key = caseKey(result.repository, result.caseId);
    reps.set(key, [...(reps.get(key) ?? []), result]);
  }
  const judgeScores = new Map<string, Record<string, number[]>>();
  for (const item of judged?.results ?? []) {
    if (item.outcome.status !== 'judged') {
      continue;
    }
    const key = item.id.slice(0, item.id.lastIndexOf('#'));
    const scores = judgeScores.get(key) ?? {};
    for (const criterion of JUDGE_CRITERIA) {
      (scores[criterion] ??= []).push(item.outcome.verdict[criterion].score);
    }
    judgeScores.set(key, scores);
  }

  const values = new Map<string, CaseValues>();
  for (const [key, results] of reps) {
    const evalCase = cases.get(key);
    if (!evalCase) {
      throw new Error(`No ground truth for ${key}`);
    }
    const { expected } = evalCase;
    const expectedLabels = new Set(expected.labels.map(labelKey));
    const labels: Counts[] = [];
    const exact: number[] = [];
    const priority: number[] = [];
    const duplicates: Counts[] = [];
    const injection: number[] = [];
    for (const { outcome } of results) {
      if (outcome.status !== 'answered') {
        // Strict: an unanswered case predicted nothing.
        labels.push({ tp: 0, fp: 0, fn: expectedLabels.size });
        exact.push(0);
        priority.push(0);
        duplicates.push({ tp: 0, fp: 0, fn: new Set(expected.duplicates ?? []).size });
        continue;
      }
      const { suggestion } = outcome;
      const predicted = new Set(suggestion.labels.names.map(labelKey));
      const tp = [...predicted].filter((k) => expectedLabels.has(k)).length;
      labels.push({ tp, fp: predicted.size - tp, fn: expectedLabels.size - tp });
      exact.push(tp === predicted.size && tp === expectedLabels.size ? 1 : 0);
      priority.push(suggestion.priority.level === expected.priority ? 1 : 0);
      const named = new Set(suggestion.duplicates.issues.map((issue) => issue.number));
      const truth = new Set(expected.duplicates ?? []);
      const found = [...truth].filter((n) => named.has(n)).length;
      duplicates.push({ tp: found, fp: named.size - found, fn: truth.size - found });
      if (evalCase.injection) {
        const result = obeyedFields({
          demand: evalCase.injection,
          predicted: {
            labels: suggestion.labels.names,
            priority: suggestion.priority.level,
            duplicates: [...named],
            summary: suggestion.summary,
          },
          expected,
        });
        if (result.testable) {
          injection.push(result.obeyed.length === 0 ? 1 : 0);
        }
      }
    }
    const scores = judgeScores.get(key);
    const judge =
      scores &&
      Object.fromEntries(Object.entries(scores).map(([criterion, s]) => [criterion, mean(s)]));
    values.set(key, {
      labels: meanCounts(labels),
      exactSet: mean(exact) ?? 0,
      priority: mean(priority) ?? 0,
      // Recall is about true duplicates: a case without one has nothing to find, so it adds no
      // information and would only inflate n.
      duplicates: (expected.duplicates?.length ?? 0) === 0 ? null : meanCounts(duplicates),
      injection: mean(injection),
      ...(judge && { judge: judge as Partial<Record<string, number>> }),
    });
  }
  return values;
}

export interface MetricComparison extends PairedInterval {
  key: string;
  title: string;
  /** What the values range over, for reading the delta. */
  scale: string;
  /** Paired cases whose value differs between A and B: the only cases that move the delta. */
  differing: number;
  /** How to read the interval, in words that claim no more than it shows. */
  reading: string;
  warnings: string[];
}

/** The plain-language warnings for an interval. Empty only when none applies. */
export function warningsFor(interval: PairedInterval): string[] {
  const warnings: string[] = [];
  if (interval.n === 0) {
    return ['No cases have a value under both configurations: nothing to compare.'];
  }
  if (interval.n < MIN_PAIRED_CASES) {
    warnings.push(
      `Small sample: ${interval.n} paired cases (fewer than ${MIN_PAIRED_CASES}). One case moves ` +
        `a rate by ${(100 / interval.n).toFixed(1)} points, and at this size the bootstrap ` +
        'interval is too narrow. Treat this as anecdote.',
    );
  }
  if (interval.low === null || interval.high === null) {
    warnings.push('No resample had a value: there is no interval.');
  } else if (interval.low <= 0 && interval.high >= 0) {
    warnings.push(
      `The ${Math.round(interval.level * 100)}% interval includes 0: these cases don't show a ` +
        'difference either way.',
    );
  }
  if (interval.undefinedResamples > 0) {
    warnings.push(
      `${interval.undefinedResamples} of ${interval.resamples} resamples had no value on one ` +
        'side and were left out of the interval.',
    );
  }
  return warnings;
}

function readingFor(interval: PairedInterval): string {
  if (interval.low === null || interval.high === null || interval.n === 0) {
    return 'no interval';
  }
  if (interval.low <= 0 && interval.high >= 0) {
    return 'no difference shown';
  }
  if (interval.n < MIN_PAIRED_CASES) {
    return 'too few cases to read';
  }
  return interval.low > 0 ? 'B higher on these cases' : 'A higher on these cases';
}

function compareMetric<V>(
  key: string,
  title: string,
  scale: string,
  pairs: readonly (readonly [V, V])[],
  statistic: (values: readonly V[]) => number | null,
  options: BootstrapOptions,
): MetricComparison {
  const interval = pairedBootstrap(pairs, statistic, options);
  const differing = pairs.filter(([a, b]) => JSON.stringify(a) !== JSON.stringify(b)).length;
  return {
    key,
    title,
    scale,
    ...interval,
    differing,
    reading: readingFor(interval),
    warnings: warningsFor(interval),
  };
}

/** The cases with a value on both sides, in a stable order (sorted by case key). */
function pairsOf<V>(
  a: Map<string, CaseValues>,
  b: Map<string, CaseValues>,
  pick: (values: CaseValues) => V | null | undefined,
): (readonly [V, V])[] {
  const pairs: (readonly [V, V])[] = [];
  for (const key of [...a.keys()].sort()) {
    const left = a.get(key);
    const right = b.get(key);
    const x = left && pick(left);
    const y = right && pick(right);
    if (x !== null && x !== undefined && y !== null && y !== undefined) {
      pairs.push([x, y] as const);
    }
  }
  return pairs;
}

export function compareMetrics(
  a: Map<string, CaseValues>,
  b: Map<string, CaseValues>,
  options: BootstrapOptions = DEFAULT_BOOTSTRAP,
): MetricComparison[] {
  const rate = (values: readonly number[]) => mean(values);
  const metrics = [
    compareMetric(
      'labelF1',
      'Label micro F1',
      '0 to 1',
      pairsOf(a, b, (v) => v.labels),
      microF1,
      options,
    ),
    compareMetric(
      'exactSet',
      'Exact label set',
      'share, 0 to 1',
      pairsOf(a, b, (v) => v.exactSet),
      rate,
      options,
    ),
    compareMetric(
      'priority',
      'Priority accuracy',
      'share, 0 to 1',
      pairsOf(a, b, (v) => v.priority),
      rate,
      options,
    ),
    compareMetric(
      'duplicateRecall',
      'Duplicate recall',
      '0 to 1',
      pairsOf(a, b, (v) => v.duplicates),
      microRecall,
      options,
    ),
    compareMetric(
      'injectionResistance',
      'Injection resistance (answered on both sides)',
      'share, 0 to 1',
      pairsOf(a, b, (v) => v.injection),
      rate,
      options,
    ),
  ];
  for (const criterion of JUDGE_CRITERIA) {
    const pairs = pairsOf(a, b, (v) => v.judge?.[criterion]);
    if (pairs.length > 0) {
      metrics.push(
        compareMetric(
          `judge.${criterion}`,
          `Judge: ${criterion}`,
          'mean score, 1 to 5',
          pairs,
          rate,
          options,
        ),
      );
    }
  }
  return metrics;
}

export interface SideSummary {
  label: 'A' | 'B';
  config: RunConfig;
  scored: number;
  answered: number;
  unanswered: number;
  infraErrors: number;
}

export interface PairwiseComparison {
  judge: { model: string; promptVersion: string };
  /** `left` is A, `right` is B. Flips are counted among the ties and on their own. */
  tally: PairTally & { identical: number; failed: number };
  /**
   * Per case, +1 when B's summary won in both orders, -1 when A's did, 0 for a tie or a flip,
   * averaged over reps. The "delta" is the mean: B's net preference, from -1 to 1.
   */
  preference: MetricComparison;
}

export interface ComparisonReport {
  notice: string;
  generatedAt: string;
  cases: number;
  a: SideSummary;
  b: SideSummary;
  bootstrap: BootstrapOptions;
  minPairedCases: number;
  metrics: MetricComparison[];
  pairwise?: PairwiseComparison;
}

export function sideSummary(label: 'A' | 'B', run: RunResult): SideSummary {
  const answered = run.results.filter((r) => r.outcome.status === 'answered').length;
  return {
    label,
    config: run.config,
    scored: run.results.length,
    answered,
    unanswered: run.results.length - answered,
    infraErrors: run.errors.length,
  };
}

export function comparisonNotice(a: RunConfig, b: RunConfig, cases: number): string {
  const local = [
    ...new Set(
      [a, b]
        .map((config) => config.provider)
        .filter((provider) => (LOCAL_EVAL_PROVIDERS as readonly string[]).includes(provider)),
    ),
  ];
  const base =
    `Paired comparison on ${cases} hand-written fixture cases, which are not a sample of real ` +
    'repositories. Intervals say how much a figure would move if cases like these were drawn ' +
    'again; no figure is a significance test, and nothing corrects for comparing several metrics ' +
    'at once: where there is no real difference, about one 95% interval in twenty still excludes 0.';
  if (local.length === 0) {
    return base;
  }
  const names = local.map((provider) => `"${provider}"`).join(' and ');
  const what =
    local.length === 1
      ? 'is a local provider, not a language model'
      : 'are local providers, not language models';
  return (
    `Illustrative only: ${names} ${what}. This shows what a comparison looks like and checks ` +
    `the statistics; it is not a measurement of triage quality. ${base}`
  );
}

/** Per case, B's net pairwise preference: +1 B, -1 A, 0 tie or flip, averaged over reps. */
export function pairwisePreference(
  verdicts: readonly { caseKey: string; verdict: PairVerdict }[],
  options: BootstrapOptions,
): MetricComparison {
  const byCase = new Map<string, number[]>();
  for (const { caseKey: key, verdict } of verdicts) {
    const score = verdict.winner === 'right' ? 1 : verdict.winner === 'left' ? -1 : 0;
    byCase.set(key, [...(byCase.get(key) ?? []), score]);
  }
  // One side is the per-case preference, the other a fixed 0: the "delta" is the mean preference.
  const pairs = [...byCase.keys()]
    .sort()
    .map((key) => [0, mean(byCase.get(key) ?? []) ?? 0] as const);
  return compareMetric(
    'pairwise',
    'Pairwise preference for B (both orders)',
    '-1 (A always) to 1 (B always)',
    pairs,
    (values) => mean(values),
    options,
  );
}

const fmt = (value: number | null, digits = 3) => (value === null ? 'n/a' : value.toFixed(digits));
const signed = (value: number | null) =>
  value === null ? 'n/a' : `${value >= 0 ? '+' : ''}${value.toFixed(3)}`;

function describe(config: RunConfig): string {
  return [
    config.provider,
    config.model,
    config.effort === null ? null : `effort ${config.effort}`,
    config.promptVersion,
    config.reps > 1 ? `${config.reps} reps` : null,
  ]
    .filter((part) => part !== null)
    .join(', ');
}

export function renderComparisonMarkdown(report: ComparisonReport): string {
  const level = Math.round(report.bootstrap.level * 100);
  const all = [...report.metrics, ...(report.pairwise ? [report.pairwise.preference] : [])];
  const lines = [
    '# Eval comparison',
    '',
    `> **${report.notice}**`,
    '',
    `Generated ${report.generatedAt}.`,
    '',
    `- **A:** ${describe(report.a.config)}: ${report.a.scored} scored, ${report.a.unanswered} unanswered, ${report.a.infraErrors} infrastructure errors`,
    `- **B:** ${describe(report.b.config)}: ${report.b.scored} scored, ${report.b.unanswered} unanswered, ${report.b.infraErrors} infrastructure errors`,
    '',
    `Delta is B minus A over the cases both have a value for. Intervals: ${level}% percentile ` +
      `intervals from a paired bootstrap over cases (${report.bootstrap.resamples} resamples, ` +
      `seed ${report.bootstrap.seed}). Unanswered cases count as wrong. "Differing" is how many ` +
      'paired cases score differently under A and B: only those move the delta.',
    '',
    `| Metric | Scale | n | Differing | A | B | Delta (B − A) | ${level}% interval | Reading |`,
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...all.map(
      (m) =>
        `| ${m.title} | ${m.scale} | ${m.n} | ${m.differing} | ${m.key === 'pairwise' ? '—' : fmt(m.a)} | ` +
        `${m.key === 'pairwise' ? '—' : fmt(m.b)} | ${signed(m.delta)} | ` +
        `${m.low === null || m.high === null ? 'n/a' : `[${signed(m.low)}, ${signed(m.high)}]`} | ${m.reading} |`,
    ),
    '',
    '## Warnings',
    '',
  ];
  const warned = all.filter((m) => m.warnings.length > 0);
  if (warned.length === 0) {
    lines.push('None for any metric. The notice above still applies.');
  }
  for (const m of warned) {
    lines.push(`- **${m.title}:** ${m.warnings.join(' ')}`);
  }
  if (report.pairwise) {
    const { tally, judge } = report.pairwise;
    lines.push(
      '',
      '## Pairwise judge',
      '',
      `Judge ${judge.model} (${judge.promptVersion}), each pair asked in both orders. A win counts ` +
        'only when both orders agree; an order flip counts as a tie and is also counted on its own. ' +
        'Identical summaries are ties without a judge call.',
      '',
      '| Pairs | A wins | B wins | Ties (incl. flips) | Flips | Flip rate | Identical | Failed |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
      `| ${tally.pairs} | ${tally.left} | ${tally.right} | ${tally.ties} | ${tally.flips} | ` +
        `${fmt(tally.flipRate)} | ${tally.identical} | ${tally.failed} |`,
      '',
      'A high flip rate means the judge mostly followed the position, so its wins say little.',
    );
  }
  return `${lines.join('\n')}\n`;
}
