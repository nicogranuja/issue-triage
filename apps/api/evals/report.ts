/**
 * Turns runs into a report: label and priority metrics (see `metrics.ts`) for the run under test
 * and for each baseline, side by side, in markdown and JSON.
 *
 * The metrics cover answered cases only. Refusals and invalid output are scored outcomes too, so
 * they appear as rates next to the metrics, and the "strict" figures count them as wrong: a model
 * can't look better by declining the hard cases. Infrastructure errors are in no figure at all;
 * the report says how many there were and where they are listed.
 */
import type { Priority } from '@issue-triage/shared';

import { candidatesFor, type EvalCase, type Fixture } from './cases.js';
import {
  duplicateMetrics,
  labelMetrics,
  priorityMetrics,
  type DuplicateMetrics,
  type DuplicateOutcome,
  type LabelMetrics,
  type PriorityMetrics,
} from './metrics.js';
import type { RunConfig, RunResult } from './runner.js';

export interface RunSummary {
  name: string;
  config: RunConfig;
  /** Case runs with a scored outcome (cases × reps, minus infrastructure errors). */
  scored: number;
  answered: number;
  refused: number;
  invalid: number;
  /** Left out of every figure; listed in the errors sidecar. */
  infraErrors: number;
  cached: number;
  labels: LabelMetrics;
  priority: PriorityMetrics;
  duplicates: DuplicateMetrics;
  /** Exact-set matches and priority hits over all scored outcomes: unanswered counts as wrong. */
  strict: { exactSetMatch: number | null; priorityAccuracy: number | null };
}

function expectedByCase(fixtures: readonly Fixture[]) {
  const expected = new Map<string, EvalCase['expected'] & { candidates: number[] }>();
  for (const fixture of fixtures) {
    for (const evalCase of fixture.cases) {
      expected.set(`${fixture.repository}/${evalCase.id}`, {
        ...evalCase.expected,
        candidates: candidatesFor(fixture, evalCase).map((candidate) => candidate.number),
      });
    }
  }
  return expected;
}

export function summarize(name: string, run: RunResult, fixtures: readonly Fixture[]): RunSummary {
  const truth = expectedByCase(fixtures);
  const labelOutcomes: { predicted: string[]; expected: string[] }[] = [];
  const priorityOutcomes: { predicted: Priority; expected: Priority }[] = [];
  const duplicateOutcomes: DuplicateOutcome[] = [];
  let refused = 0;
  let invalid = 0;
  for (const result of run.results) {
    const expected = truth.get(`${result.repository}/${result.caseId}`);
    if (!expected) {
      throw new Error(`No ground truth for ${result.repository}/${result.caseId}`);
    }
    const { outcome } = result;
    if (outcome.status === 'refused') {
      refused += 1;
    } else if (outcome.status === 'invalid') {
      invalid += 1;
    } else {
      labelOutcomes.push({ predicted: outcome.suggestion.labels.names, expected: expected.labels });
      priorityOutcomes.push({
        predicted: outcome.suggestion.priority.level,
        expected: expected.priority,
      });
      duplicateOutcomes.push({
        predicted: outcome.suggestion.duplicates.issues.map((issue) => issue.number),
        expected: expected.duplicates,
        candidates: expected.candidates,
      });
    }
  }
  const labels = labelMetrics(labelOutcomes);
  const priority = priorityMetrics(priorityOutcomes);
  const scored = run.results.length;
  const answered = labelOutcomes.length;
  const share = (rate: number | null) => (scored === 0 ? null : ((rate ?? 0) * answered) / scored);
  return {
    name,
    config: run.config,
    scored,
    answered,
    refused,
    invalid,
    infraErrors: run.errors.length,
    cached: run.results.filter((result) => result.cached).length,
    labels,
    priority,
    duplicates: duplicateMetrics(duplicateOutcomes),
    strict: {
      exactSetMatch: share(labels.exactSetMatch),
      priorityAccuracy: share(priority.accuracy),
    },
  };
}

export interface Report {
  /** Says what the numbers are and are not. Repeated at the top of the markdown. */
  notice: string;
  generatedAt: string;
  cases: number;
  run: RunSummary;
  baselines: RunSummary[];
}

const LOCAL_PROVIDERS = new Set(['fake', 'oracle', 'null']);

export function buildReport(
  run: RunSummary,
  baselines: RunSummary[],
  fixtures: readonly Fixture[],
  now: Date = new Date(),
): Report {
  const cases = fixtures.reduce((total, fixture) => total + fixture.cases.length, 0);
  const notice = LOCAL_PROVIDERS.has(run.config.provider)
    ? `Illustrative only: this run used the local "${run.config.provider}" provider, not a language model. ` +
      'It shows what the report looks like and checks the harness; it is not a measurement of triage quality.'
    : `Results from a real model on ${cases} cases. Small sample: differences of a few cases are ` +
      'noise, and the hand-written fixtures are not a sample of real repositories.';
  return {
    notice,
    generatedAt: now.toISOString(),
    cases,
    run,
    baselines,
  };
}

const fmt = (value: number | null) => (value === null ? 'n/a' : value.toFixed(3));
const pct = (count: number, total: number) =>
  total === 0 ? 'n/a' : `${((100 * count) / total).toFixed(1)}%`;

function table(header: string[], rows: string[][]): string {
  return [header, header.map(() => '---'), ...rows]
    .map((row) => `| ${row.join(' | ')} |`)
    .join('\n');
}

export function renderMarkdown(report: Report): string {
  const all = [report.run, ...report.baselines];
  const { config } = report.run;
  const lines = [
    '# Eval report',
    '',
    `> **${report.notice}**`,
    '',
    `Generated ${report.generatedAt}. Provider \`${config.provider}\`, model \`${config.model}\`, ` +
      `effort \`${config.effort ?? 'none'}\`, prompt \`${config.promptVersion}\`, ` +
      `${config.reps} rep(s), seed ${config.seed}. ${report.cases} cases.`,
    '',
    '## Outcomes',
    '',
    'Infrastructure errors (timeouts, rate limits, server errors) are in no figure below; they are ' +
      'listed in `errors.jsonl`. Refusals and invalid output are scored: the metrics after this ' +
      'table cover answered cases, and the strict figures count the rest as wrong.',
    '',
    table(
      ['Run', 'Scored', 'Answered', 'Refused', 'Invalid', 'Infra errors', 'From cache'],
      all.map((s) => [
        s.name,
        String(s.scored),
        pct(s.answered, s.scored),
        pct(s.refused, s.scored),
        pct(s.invalid, s.scored),
        String(s.infraErrors),
        String(s.cached),
      ]),
    ),
    '',
    '## Labels',
    '',
    table(
      ['Run', 'Micro P', 'Micro R', 'Micro F1', 'Exact set', 'Exact set (strict)'],
      all.map((s) => [
        s.name,
        fmt(s.labels.micro.precision),
        fmt(s.labels.micro.recall),
        fmt(s.labels.micro.f1),
        fmt(s.labels.exactSetMatch),
        fmt(s.strict.exactSetMatch),
      ]),
    ),
    '',
    `Per label, ${report.run.name}:`,
    '',
    table(
      ['Label', 'TP', 'FP', 'FN', 'P', 'R', 'F1'],
      Object.entries(report.run.labels.perLabel).map(([label, m]) => [
        `\`${label}\``,
        String(m.truePositives),
        String(m.falsePositives),
        String(m.falseNegatives),
        fmt(m.precision),
        fmt(m.recall),
        fmt(m.f1),
      ]),
    ),
    '',
    '## Priority',
    '',
    table(
      ['Run', 'Accuracy', 'Within one', 'Accuracy (strict)', 'Majority-class baseline'],
      all.map((s) => [
        s.name,
        fmt(s.priority.accuracy),
        fmt(s.priority.withinOne),
        fmt(s.strict.priorityAccuracy),
        s.priority.majorityBaseline
          ? `${fmt(s.priority.majorityBaseline.accuracy)} (always \`${s.priority.majorityBaseline.level}\`)`
          : 'n/a',
      ]),
    ),
    '',
    `Confusion matrix, ${report.run.name} (rows: expected, columns: predicted):`,
    '',
    table(
      ['', ...Object.keys(report.run.priority.confusion)],
      Object.entries(report.run.priority.confusion).map(([expected, row]) => [
        `**${expected}**`,
        ...Object.values(row).map(String),
      ]),
    ),
    '',
    '## Duplicates',
    '',
    'Recall counts every true duplicate, including those the TF-IDF pre-filter never offered the ' +
      'model; the pre-filter recall is the ceiling.',
    '',
    table(
      ['Run', 'P', 'R', 'F1', 'Pre-filter recall'],
      all.map((s) => [
        s.name,
        fmt(s.duplicates.micro.precision),
        fmt(s.duplicates.micro.recall),
        fmt(s.duplicates.micro.f1),
        fmt(s.duplicates.preFilterRecall),
      ]),
    ),
    '',
  ];
  return lines.join('\n');
}
